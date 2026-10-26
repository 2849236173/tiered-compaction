/**
 * 宿主契约层（A12）：把四层管线接到宿主的真实调用链上。
 *
 * 背景（安装记录 §9）：M4.5 wiring 只接了「层与层」，漏了「引擎与宿主」。
 * 宿主通过 `ctx.compaction` 调三个入口（/compact 命令 → compactNow；pressure /
 * context-overflow 自动触发 → compactIfNeeded；定向 → compactRegion），
 * 自动压缩靠引擎自己注册 `agent/pre-step` 钩子。本模块与 basic 契约面对齐：
 *
 * 1. `TieredCompactionEngineService extends CompactionEngine`（构造即占用
 *    'compaction' 服务位；槽冲突由 apply 的 construction-catch 降级旁路）
 * 2. `static inject = ["llm", "tokenMeter", "sessions"]`——依赖从 ctx 注入，
 *    消除 config 手传导致的第 3/4 层静默失效
 * 3. 事务事件与返回形状与 basic 对齐：`compaction/start` → `compaction/summary`
 *    → `user/message`(surfaceOp replace + compactCheckpointSource) → `compaction/end`
 * 4. 第 1-2 层在工具输出路径由仲裁器生效；本契约层把第 3 层（70% 提醒/80% 驱逐）
 *    挂进 pressure 触发、第 4 层（20k 预算摘要）挂进阈值与 overflow 触发
 */
import { randomUUID } from "node:crypto";
import {
    CompactionEngine,
    CompactionId,
    ManualCompactionError,
    compactCheckpointSource,
    toolPairingBalancedBefore,
    toolPairingBalancedAfter,
} from "@deepseek-ai/dsh-compaction";
import { createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE, BlockAssembler } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { pressureAction } from "./soft-pressure.js";
import { lossyThreshold, RESERVE_TOKENS } from "./lossy-summarize.js";
// 四层引擎与工具结果观察者：接管路径必须自己持有它们（D17 关键修复），
// 不能再依赖 index.js 里那个未被实例化的类。
import { TieredCompactionEngine } from "./engine.js";
import { ToolResultObserver } from "./tool-result-observer.js";

/**
 * 摘要指令（与 basic 的 COMPACTION_INSTRUCTION 同义，独立成文以免跨模块耦合）：
 * 追加在重放前缀之后，让模型把前面对话压成可无损续做的检查点。
 */
const COMPACTION_INSTRUCTION = [
    "You are now acting as a compaction engine for this AI coding assistant.",
    "Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
    "Preserve exact file paths, commands, error strings, identifiers, numeric values and user corrections.",
    "Output only the checkpoint text: do not call any tool or take any other action.",
].join("\n");

/** 同一 agent 的溢出恢复最多重试次数（照 basic 的 maxOverflowRetries 默认口径）。 */
const MAX_OVERFLOW_RETRIES = 3;

/** 缺窗口读数时的兜底窗口（保守取值，宁可晚压也不误压）。 */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * 从会话事件流里找当前上下文窗口大小。
 *
 * 为什么不能问 tokenMeter：D16 实测钉死——真实 `TokenMeter` 只有
 * `measure(session, requestHeader)` 与 `estimateMessage(message)`，**没有
 * `contextWindow()`**（dsh-token-meter lib:722/783）。旧代码
 * `meter.contextWindow?.(session) ?? 0` 永远拿 0 → 压力恒 0（第 3 层死）
 * → 阈值算成负数（第 4 层反向强触发、每步都白跑一次必败事务）。
 * 窗口数据实际在 `request/context` 事件的 `data.contextWindow`
 * （token-meter 自己的投影也是这么读的）。
 *
 * @param {object} session 会话
 * @returns {number} 窗口 token 数；找不到时用保守兜底值
 */
function contextWindowOf(session) {
    const nodes = session?.surface?.nodes ?? [];
    // 从最近往前找：窗口随路由模型变化，最新一条才是当前有效值
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const event = session.eventAt?.(nodes[index]);
        if (event?.type !== "request/context") continue;
        const window = event.data?.contextWindow;
        if (typeof window === "number" && window > 0) return window;
    }
    return FALLBACK_CONTEXT_WINDOW;
}

/** 与 basic 相同的 checkpoint 框架文案（投影层据此识别摘要节点）。 */
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_PREAMBLE =
    "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

/**
 * 把摘要文本包进与 basic 相同的 checkpoint 框架（basic frameSummary 的文本版）。
 * @param {string} summary 纯文本摘要
 * @returns {Array<{type: "text", text: string}>}
 */
function frameSummaryText(summary) {
    return [
        { type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
        { type: "text", text: summary },
        { type: "text", text: SUMMARY_CLOSE_TAG },
    ];
}

/** 估算文本 token（自算口径：字符数/4，向上取整；压力判断用 meter 正式读数）。 */
const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * 配置加载期校验（P4-1）。
 *
 * 为什么要有：没有 schema 时，`archiveDir: 123`（类型错）或 `enabled: "yes"`
 * 会一路带进运行期，最坏结果是被当成 truthy/falsy 静默走错分支——
 * 我们已经在 D15 被「缺 enabled:true 静默不生效」坑过一次，不能再靠运气。
 * @param {object} config
 * @throws {TypeError} 字段类型不对时
 */
function validateConfig(config) {
    const shape = {
        enabled: "boolean",
        auto: "boolean",
        bypassMode: "boolean",
        archiveDir: "string",
        summaryTarget: "object",
        summarizeFn: "function",
        tokenMeter: "object",
    };
    for (const [key, expected] of Object.entries(shape)) {
        const value = config?.[key];
        if (value === undefined) continue; // 未提供 = 走默认，合法
        const actual = Array.isArray(value) ? "array" : typeof value;
        if (actual !== expected) {
            throw new TypeError(
                `tiered-compaction: 配置项 ${key} 应为 ${expected}，实得 ${actual}`,
            );
        }
    }
}

/**
 * 宿主契约引擎服务。
 */
export class TieredCompactionEngineService extends CompactionEngine {
    static inject = ["llm", "tokenMeter", "sessions"];

    /**
     * 配置结构（P4-1）：与 basic 一样用 Schemastery 声明，配置写错在加载期就报，
     * 而不是运行到一半才暴露（比如 archiveDir 传了对象）。
     * 注意：只做类型校验不做必填——archiveDir 缺省时落盘层自动跳过。
     */
    static Config = z.object({
        enabled: z.boolean().default(false),
        auto: z.boolean().default(true),
        archiveDir: z.string(),
        bypassMode: z.boolean().default(false),
        summaryTarget: z.object({
            provider: z.string(),
            model: z.string(),
        }),
    });

    /** @param {object} config 插件配置（enabled/archiveDir/summaryTarget 由 apply 解析） */
    constructor(ctx, config = {}) {
        super(ctx); // Service(ctx, 'compaction')：槽冲突在此同步抛错 → apply 降级旁路
        this.config = config;
        // 观测：接管成功必须留痕。此前只有 index.js 里那个未被使用的类打日志，
        // 真实接管路径（本类）完全静默——「没看到已接管」无法区分「没生效」
        // 还是「生效了但没打」。这条日志是 enabled=true 路径的唯一存在性证据。
        ctx.logger.info(
            "dsh-tiered-compaction 已接管 compaction 服务位（enabled=true" +
            (config.archiveDir ? `，archiveDir=${config.archiveDir}` : "，无 archiveDir（落盘层跳过）") +
            "）"
        );
        // P4-1：加载期校验（Cordis 若已按 static Config 校验过则本步幂等无害）
        validateConfig(config);
        /**
         * 四层引擎 + 工具结果观察者（D17 关键修复）。
         *
         * 为什么必须在这里创建：接管 `compaction` 服务位的是**本类**
         * （apply 里用 HostContractEngineService）。而四层引擎与观察者原先
         * 只在 index.js 的 `TieredCompactionEngineService` 里创建——那个类
         * 在接管路径上**从未被实例化**。
         * 后果：第 1-2 层（折叠 + 落盘）代码存在但永不执行，archiveDir
         * 永远是空目录，且不报任何错。D16 审计认定「P1 已修」是假绿：
         * 修的是一个死类。
         */
        this.engine = new TieredCompactionEngine({
            archiveDir: config.archiveDir,
            // 不传 tokenMeter / summarizeFn：
            //   - 第 1-2 层（本类唯一用到的引擎能力）不需要压力读数；
            //   - 第 3-4 层由本类自己的 pressure / overflow 钩子处理，它们用
            //     contextWindowOf(session) 与 meter.measure(session) 直读，
            //     绕过引擎那套不存在的 meter.contextWindow()（D16 P1-0 教训）。
            // 传一个假 meter 只会制造「看起来接上了」的假象。
            logger: ctx.logger,
        });
        // 观察者：把第 1-2 层接到宿主 session/event 流（工具结果一产生就加工）。
        // 这是 archiveDir 唯一的真实消费方。
        this.observer = new ToolResultObserver({ engine: this.engine, ctx });
        this.observer.register();
        ctx.logger.info(
            "dsh-tiered-compaction 观察者已注册（工具结果 → 第 1-2 层）" +
            (config.archiveDir ? "" : "；注意：未配置 archiveDir，落盘层将跳过")
        );
        /** overflow 重试去重（照 basic 的 WeakMap 口径，按 agent 记账） */
        this.overflowRetries = new WeakMap();
        /** session → agent 映射：清理钩子只拿得到 session，据此找回 agent 清账（P3-3） */
        this.overflowAgents = new WeakMap();
        if (config.auto ?? true) this._registerAutomaticCompaction();
    }

    /* ---------------- 宿主三入口 ---------------- */

    /**
     * /compact 手动命令入口（宿主 command-compact 的唯一调用点）。
     * @returns {Promise<object|null>} 压缩事务结果；无可压缩面返回 null
     */
    async compactNow(agent, signal, sourceCommandId) {
        signal?.throwIfAborted();
        const result = typeof agent?.runMaintenance !== "function"
            // 非 agent 桩（测试/探针）：直接走事务，语义等价
            ? await this._compactWholeSurface(agent, { sourceCommandId, signal })
            : await agent.runMaintenance(async (agentSignal) => {
                // 兜底：无外部 signal 时用常开信号（AbortSignal.any 要求非空数组）
                const signals = [agentSignal, signal].filter(Boolean);
                const operationSignal = signals.length > 0 ? AbortSignal.any(signals) : agentSignal;
                return this._compactWholeSurface(agent, { sourceCommandId, signal: operationSignal });
            });
        // P4-2：事务提交后把会话落盘（basic 同款 durability checkpoint）。
        // 缺这一步时压缩结果只在内存里，进程崩溃会丢掉整次压缩。
        await this._flushAfterCommit();
        return result;
    }

    /**
     * 压缩提交后的持久化检查点（P4-2）。
     * 失败按 basic 口径抛 persistence 错误：压缩已提交但没落地，属于耐久性缺陷，
     * 不能静默放过（否则用户以为省了 token，重启后发现没省）。
     */
    async _flushAfterCommit() {
        const sessions = this.ctx.sessions;
        if (typeof sessions?.flush !== "function") return;
        try {
            await sessions.flush();
        } catch (error) {
            throw new ManualCompactionError("persistence", "manual compaction durability checkpoint failed", { cause: error });
        }
    }

    /**
     * 自动触发入口。
     * - "pressure"：70% 提醒（只广播不改历史）→ 80% 驱逐（广播驱逐事件，
     *   由投影侧落地，会话表面不动）→ 达第 4 层阈值才走摘要事务。
     * - "context-overflow"：provider 已确认溢出，直接走摘要事务（含一次重试记账）。
     * @returns {Promise<object|null>} 压缩事务结果或 null（未触发）
     */
    async compactIfNeeded(agent, trigger, signal) {
        const session = agent?.session;
        if (!session) return null;
        const meter = this.ctx.tokenMeter;
        if (!meter) throw new Error("tiered-compaction: ctx.tokenMeter 缺失（static inject 未生效或宿主版本不匹配）");
        const window = contextWindowOf(session);
        // 读数口径与 basic 一致：压力取 meter.measure(session).totalTokens
        // （conversation meter 的会话面读数；currentTokens 是兼容面，仅兜底）
        const measurement = meter.measure?.(session);
        const current = measurement?.totalTokens ?? meter.currentTokens?.(session) ?? meter.currentTokens?.() ?? 0;
        const pressure = window > 0 ? current / window : 0;
        const action = pressureAction(pressure);

        // 第 3 层：70% 提醒（不改历史）
        if (action === "remind") {
            this.ctx.logger.info(`tiered-compaction: 窗口压力 ${(pressure * 100).toFixed(0)}%（70%），建议收束当前任务`);
        }
        // 第 3 层：80% 驱逐（广播事件；易失内容剔除由投影侧消费，A3 口径不变）
        if (action === "evict") {
            this.ctx.emit("tiered-compaction/evict", { session, pressure, at: Date.now() });
            this.ctx.logger.warn(`tiered-compaction: 窗口压力 ${(pressure * 100).toFixed(0)}%（80%），已广播易失内容驱逐事件`);
        }
        // 第 4 层触发判定：overflow 直接触发；pressure 达阈值触发
        const threshold = lossyThreshold(window);
        const need = trigger === "context-overflow" || current >= threshold;
        if (!need) return null;
        if (trigger === "context-overflow") {
            if (this.overflowRetries.get(agent)) return null; // 一次 overflow 只补一枪
            this.overflowRetries.set(agent, true);
        }
        return this._compactWithRetention(session, agent, signal);
    }

    /**
     * 定向压缩区间入口（宿主 compactIfNeeded 内部路径的等价公开面）。
     */
    async compactRegion(start, end, agent, signal) {
        return this._runTransaction(agent.session, start, end, agent, signal);
    }

    /* ---------------- 摘要钩子 ---------------- */

    /**
     * basic 契约的摘要覆写点：第 4 层预算预留（A4a：maxTokens 写死 20k）。
     * @param {string} input 待摘要文本
     * @returns {Promise<{summary: string, provider: string, model: string, maxTokens: number}>}
     */
    async summarize(input, agent, signal) {
        const target = this.config.summaryTarget ?? this._targetFromAgent(agent);
        if (!target) throw new ManualCompactionError("summary", "tiered-compaction: 无摘要路由（summaryTarget 与会话路由均缺）");
        const summarizeFn = this.config.summarizeFn ?? this._summarizeFnFromCtx();
        if (!summarizeFn) throw new ManualCompactionError("summary", "tiered-compaction: 无摘要实现（config.summarizeFn 或 ctx.llm 均缺）");
        const request = { provider: target.provider, model: target.model, maxTokens: RESERVE_TOKENS, purpose: "compaction" };
        const summary = await summarizeFn(request, input, signal);
        if (!summary || summary.length === 0) throw new ManualCompactionError("summary", "tiered-compaction: 摘要结果为空，拒绝提交");
        return { summary, provider: target.provider, model: target.model, maxTokens: RESERVE_TOKENS };
    }

    /* ---------------- 自动钩子（照 basic 写法） ---------------- */

    _registerAutomaticCompaction() {
        const { ctx } = this;
        ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
            if (!signal?.aborted) {
                try {
                    const result = await this.compactIfNeeded(agent, "pressure", signal);
                    if (result !== null) {
                        ctx.logger.info(
                            `compaction (step pressure): shadowed ${result.shadowedSeqs.length} surface nodes ` +
                            `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, ~${result.shadowedTokenCount} tokens)`
                        );
                    }
                } catch (error) {
                    // 钩子失败绝不阻断步进（basic 同款口径）
                    ctx.logger.warn(`tiered-compaction: pressure 钩子失败，继续步进：${error?.message ?? error}`);
                }
            }
            return next();
        });

        // ── P2-2：真实溢出后的恢复压缩（照 basic 861-887 的钩子语义）──
        // 背景：审计发现只注册 pre-step，provider 报 CONTEXT_WINDOW_EXCEEDED 后
        // 根本没有恢复路径——真溢出时压缩永不触发。
        ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
            if (failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal?.aborted) return next();
            this.overflowAgents.set(agent.session, agent);
            const target = this.config.summaryTarget ?? this._targetFromAgent(agent);
            // 无摘要路由时不接管：交回宿主（保留原始错误，不掩盖）
            if (target === undefined) return next();
            const retries = this.overflowRetries.get(agent) ?? 0;
            if (retries >= MAX_OVERFLOW_RETRIES) return next();
            const generation = agent.session.surface.replaceGeneration;
            let result;
            try {
                result = await this.compactIfNeeded(agent, "context-overflow", signal);
            } catch (recoveryError) {
                const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
                // 表面已有持久进展 → 从替换后的表面重试（不重复压同一段）
                if (!signal?.aborted && agent.session.surface.replaceGeneration > generation) {
                    ctx.logger.warn(
                        `tiered-compaction: 溢出恢复压缩失败但表面已有进展（${message}），从替换面重试`
                    );
                    this.overflowRetries.set(agent, retries + 1);
                    return { kind: "retry" };
                }
                ctx.logger.warn(
                    `tiered-compaction: 溢出恢复压缩失败（${message}）；` +
                    `${signal?.aborted ? "已取消，不再重试" : "保留原始请求错误"}`
                );
                return next();
            }
            if (signal?.aborted || agent.session.surface.replaceGeneration <= generation) return next();
            if (result !== null) {
                ctx.logger.info(
                    `compaction (context overflow recovery): shadowed ${result.shadowedSeqs.length} nodes ` +
                    `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end})`
                );
            }
            this.overflowRetries.set(agent, retries + 1);
            return { kind: "retry" };
        });

        // ── P3-3：overflowRetries 双钩子清理（照 basic 853-860）──
        // 只增不清的 WeakMap 会让同一 agent 在长时间会话里永久失去溢出恢复能力。
        ctx.on("agent/status", ({ agent, status }) => {
            if (status === "idle") this.overflowRetries.delete(agent);
        });
        ctx.on("session/event", (session, event) => {
            if (event?.type !== "assistant/message") return;
            const agent = this.overflowAgents.get(session);
            if (agent !== undefined) this.overflowRetries.delete(agent);
        });
    }

    /* ---------------- 内部：选区与事务 ---------------- */

    /** 全表面压缩（compactNow 的实际路径）：保留 0 token tail。 */
    _compactWholeSurface(agent, { sourceCommandId, signal }) {
        const session = agent.session;
        const meter = this.ctx.tokenMeter;
        const range = this._selectRange(session, meter.measure(session), 0);
        if (range === null) return null;
        return this._runTransaction(session, range.start, range.end, agent, signal);
    }

    /** 压力/溢出压缩：保留近端 tail（窗口保护量），其余交事务。 */
    _compactWithRetention(session, agent, signal) {
        const meter = this.ctx.tokenMeter;
        const window = contextWindowOf(session);
        const retain = Math.max(16000, Math.floor(window * 0.05));
        const range = this._selectRange(session, meter.measure(session), retain);
        if (range === null) return null;
        return this._runTransaction(session, range.start, range.end, agent, signal);
    }

    /**
     * 选区（basic 同款规则）：system 头不进区间；从尾向前累计保留 tail；
     * 不拆 assistant tool-call/result 对。读数面与表面不一致直接放弃本次压缩
     * （保守：不压比压错好）。
     */
    _selectRange(session, measurement, retainTokens) {
        const surfaceNodes = session.surface?.nodes ?? [];
        const priced = measurement?.nodes ?? [];
        if (surfaceNodes.length === 0 || priced.length !== surfaceNodes.length) return null;
        const head = session.eventAt(surfaceNodes[0]);
        const firstIdx = head?.type === "system/message" ? 1 : 0;
        if (firstIdx >= surfaceNodes.length) return null;
        let accumulated = 0;
        let keepFromIdx = priced.length;
        for (let index = priced.length - 1; index >= 0; index -= 1) {
            accumulated += priced[index].tokens;
            keepFromIdx = index;
            if (accumulated >= retainTokens) break;
        }
        if (keepFromIdx <= firstIdx) return null;
        while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) {
            keepFromIdx -= 1;
        }
        if (keepFromIdx <= firstIdx) return null;
        // P3-2 修复：整段「好」还不够，要保证被替换区间末尾不把 tool-call/result
        // 配对劈成两半——只往前配平会留下 result 在区间内、call 在区间外（或反之）。
        // 从区间末尾往前收，直到区间自身也是配平的。
        let endIdx = keepFromIdx - 1;
        while (endIdx > firstIdx && !toolPairingBalancedAfter(session, surfaceNodes[endIdx])) {
            endIdx -= 1;
        }
        if (endIdx < firstIdx) return null;
        return { start: surfaceNodes[firstIdx], end: surfaceNodes[endIdx] };
    }

    /**
     * 事务：start → 摘要 → summary 事件 + user/message(surfaceOp replace) → end。
     * 返回形状与 basic 对齐；任何失败补一条带 error 的 compaction/end 后上抛。
     */
    async _runTransaction(session, start, end, agent, signal) {
        const compactionId = CompactionId(randomUUID());
        const lifecycle = { compactionId };
        const startEvent = session.append("compaction/start", lifecycle);
        try {
            const surfaceNodes = session.surface.nodes;
            const shadowedSeqs = surfaceNodes.filter((seq) => seq >= start && seq <= end);
            if (shadowedSeqs[0] !== start || shadowedSeqs[shadowedSeqs.length - 1] !== end) {
                throw new Error("compaction: the selected span is no longer a valid replacement target");
            }
            // 摘要输入：区间内节点内容按表面序拼接（basic 的 buildSummarizationInput
            // 走投影前缀；此处文本等价，第 1-2 层已在写入侧缩小过原文）
            const input = shadowedSeqs
                .map((seq) => {
                    const ev = session.eventAt(seq);
                    const data = ev?.data ?? {};
                    if (typeof data.content === "string") return data.content;
                    if (Array.isArray(data.content)) {
                        return data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
                    }
                    return "";
                })
                .filter((t) => t.length > 0)
                .join("\n");
            const estimate = estimateTokens(input);
            const { summary, provider, model, maxTokens } = await this.summarize(input, agent, signal);
            const framedEstimate = estimateTokens(summary);
            if (framedEstimate >= estimate) {
                throw new Error(`summary is not smaller than the shadowed content (${framedEstimate} estimated framed tokens >= ${estimate})`);
            }
            const summaryEvent = session.append("compaction/summary", {
                compactionId,
                summary,
                shadowedRange: { start, end },
                shadowedSeqs: [...shadowedSeqs],
                shadowedTokenCount: estimate,
                provider,
                model,
                maxTokens,
            });
            const checkpointMessage = createUserMessage({
                content: frameSummaryText(summary),
                source: compactCheckpointSource(compactionId, undefined),
            });
            session.append("user/message", checkpointMessage, {
                surfaceOp: { op: "replace", startSeq: start, endSeq: end },
                sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
            });
            const endEvent = session.append("compaction/end", lifecycle);
            return {
                compactionId,
                startSeq: startEvent.seq,
                summarySeq: summaryEvent.seq,
                summary,
                shadowedRange: { start, end },
                shadowedSeqs: [...shadowedSeqs],
                shadowedTokenCount: estimate,
                endSeq: endEvent.seq,
            };
        } catch (error) {
            // 失败必须补配对 end（unmatched start 由宿主投影判定为可恢复态）
            try {
                session.append("compaction/end", { ...lifecycle, error: String(error?.message ?? error) });
            } catch { /* close 尽力而为 */ }
            if (error instanceof ManualCompactionError) throw error;
            throw new ManualCompactionError("summary", "tiered-compaction 事务失败", { cause: error });
        }
    }

    /* ---------------- 依赖解析（ctx 注入优先，config 兜底） ---------------- */

    /** 从 agent 会话路由解析摘要 target（basic 同款兜底顺序）。 */
    _targetFromAgent(agent) {
        const routed = agent?.session?.requestHeader?.()?.config;
        if (routed?.provider && routed?.model) {
            return { provider: routed.provider, model: routed.model };
        }
        return undefined;
    }

    /**
     * 从注入的 ctx.llm 构造摘要实现（宿主真链路路径）。
     *
     * **为什么不能用 `llm.summarize`**（D16 运行时实锤）：真实 llm 服务的方法面
     * 里没有 `summarize`，只有 `stream()`。旧实现调用不存在的 API，导致每一次
     * 摘要事务都抛「llm.summarize is not a function」——18 次事务 18 次失败。
     * basic 的摘要路径就是 `for await (const chunk of ctx.llm.stream(options))`，
     * 这里照抄同一形态：stream + BlockAssembler 聚合，再取 text 块拼成摘要。
     */
    _summarizeFnFromCtx() {
        const llm = this.ctx.llm;
        if (!llm || typeof llm.stream !== "function") return undefined;
        return async (request, input, signal) => {
            const assembler = new BlockAssembler();
            const messages = [
                { role: "user", content: [{ type: "text", text: input }] },
                { role: "user", content: [{ type: "text", text: COMPACTION_INSTRUCTION }] },
            ];
            const options = {
                provider: request.provider,
                model: request.model,
                messages,
                maxTokens: request.maxTokens,
                purpose: request.purpose ?? "compaction",
                ...(signal === undefined ? {} : { signal }),
            };
            for await (const chunk of llm.stream(options)) assembler.push(chunk);
            // finish 错误必须上抛：否则会把半截输出当完整摘要提交
            const failure = assembler.finish?.error;
            if (failure !== undefined) throw failure;
            const blocks = assembler.blocks?.() ?? [];
            return blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        };
    }
}

/** 测试用探测面：暴露内部纯函数（生产代码不消费）。 */
export const __test = { contextWindowOf };
