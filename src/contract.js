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
import { HealthReporter, collectHealth } from "./health-check.js";
import { lossyThreshold, RESERVE_TOKENS, HEADROOM_TOKENS } from "./lossy-summarize.js";
// 四层引擎与工具结果观察者：接管路径必须自己持有它们（D17 关键修复），
// 不能再依赖 index.js 里那个未被实例化的类。
import { TieredCompactionEngine } from "./engine.js";
import { ToolResultObserver } from "./tool-result-observer.js";

/**
 * 把流式摘要的终止状态映射成必须上抛的错误（照抄 basic finishError 判定口径）。
 *
 * 为什么不能用 `finish?.error`：`BlockAssembler.finish` 的返回形状是
 * `{ kind: 'stop' | 'error' | 'aborted' | 'max-tokens', failure? }`，
 * 没有 `error` 字段。读错字段名会让**所有** LLM 失败静默降级成「摘要为空」，
 * 丢掉真实原因（D17 沙箱实测：21/21 事务都是这种表现）。
 *
 * @param {{kind: string, failure?: {message: string, code: string}}} finish
 * @returns {Error | undefined} 正常结束返回 undefined
 */
function finishErrorOf(finish) {
    switch (finish?.kind) {
        case "error":
        case "aborted": {
            const failure = finish.failure ?? {};
            const message = failure.message ?? "摘要调用失败（无错误详情）";
            const code = failure.code ?? "SUMMARY_FAILED";
            const error = new Error(message);
            error.code = code;
            if (finish.failure !== undefined) error.cause = finish.failure;
            return error;
        }
        case "max-tokens": {
            // 截断的检查点是不完整的检查点，宁可失败也不能提交
            const error = new Error("summarization truncated at the token cap (incomplete checkpoint)");
            error.code = "MAX_TOKENS";
            return error;
        }
        default: return undefined;
    }
}

/**
 * 把一个会话事件投影成摘要用的文本。
 *
 * P0 审计发现（2026-10-27）：真实宿主里消息内容的存放位置**不统一**：
 *
 *   user/message      → data.content            （直接挂在 data 上）
 *   assistant/message → data.message.content    （包在 message 里）
 *   tool/result       → data.message.content    （包在 message 里）
 *   system/message    → data.message.content
 *
 * 旧实现只读 `data.content`，于是 assistant 与 tool 的消息**全部读成空**。
 * 实测：真实会话 277328 字内容里，旧逻辑只抽出 45838 字（丢 83.5%），
 * tool/result 的 224556 字一个字都没进摘要。
 *
 * 内容块的处理也有讲究：
 *   text      → 保留（这是主要信息）
 *   tool-call → 保留「工具名 + 参数」，这是"做了什么"的关键，续做必需
 *   reasoning → **丢弃**。推理过程对续做无用，而且往往比正文还长，
 *               带上它会让摘要输入膨胀、稀释真正要紧的信息。
 *
 * @param {object} event 会话事件
 * @returns {string} 投影文本；无可提取内容返回空字符串
 */
export function textOfEventForSummary(event) {
    const data = event?.data ?? {};
    // 两种存放位置都试：先 data.content，再 data.message.content
    const content = data.content ?? data.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    const pieces = [];
    for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        if (block.type === "text") {
            const text = typeof block.text === "string" ? block.text : "";
            if (text.length > 0) pieces.push(text);
        } else if (block.type === "tool-call") {
            // 工具调用保留名字与参数：这是「做过什么」的唯一线索
            const name = typeof block.name === "string" ? block.name : "unknown";
            const args = typeof block.arguments === "string" ? block.arguments : "";
            pieces.push(`[调用工具 ${name}] ${args}`);
        }
        // reasoning 明确丢弃（见上方说明）
    }
    return pieces.join("\n");
}

/**
 * 取会话当前的 open turn（用于 compaction 生命周期事件的 `turn` 字段）。
 *
 * 宿主格式契约要求 `compaction/start` / `compaction/end` 必带 `turn`
 * （见 `dsh-session-format-v0-to-v1/lib/index.js:53,59`），
 * 取法照抄原版 basic（lib/index.js:707-722）：倒扫事件流，
 * 遇到 `turn/start` 记下 `data.turn`，遇到 `turn/end` 说明那个 turn 已关闭。
 *
 * @param {object} session 会话
 * @returns {number|null} 当前 open turn；空闲态返回 null（合法）
 */
function openTurnOf(session) {
    let openTurn = null;
    let stateKnown = false;
    const lastSeq = typeof session?.seq === "number" ? session.seq : 0;
    for (let seq = lastSeq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt?.(seq);
        if (event === undefined) continue;
        if (event.type === "turn/start") {
            openTurn = typeof event.data?.turn === "number" ? event.data.turn : null;
            stateKnown = true;
        } else if (event.type === "turn/end") {
            stateKnown = true;
        }
        if (stateKnown) break;
    }
    return openTurn;
}

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

/**
 * 溢出恢复默认重试次数上限。
 *
 * D17 对齐原版：basic 的 maxOverflowRetries 默认是 **1**，旧实现写死 3。
 * 3 次意味着上下文真溢出时要多打 2 次必败的 LLM 请求——用户多付钱、多等，
 * 而原版认为一次不成就该交回上一层。现改为可配、默认 1。
 */
const DEFAULT_MAX_OVERFLOW_RETRIES = 1;

/**
 * 摘要重试默认次数（D17 对齐原版 basic 的 compactionRetries 默认值）。
 * 1 表示「首次 + 重试一次」：一次压不到阈值以下时，重新选区间再压一次。
 */
const DEFAULT_COMPACTION_RETRIES = 1;

/**
 * 缺窗口读数时的兜底窗口（保守取值，宁可晚压也不误压）。
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * 检查会话里是否有「未闭合的压缩事务」（D17 对齐原版 basic 的压缩锁）。
 *
 * 为什么需要这把锁：摘要要调 LLM，耗时几秒到几十秒。这期间会话可能又跑
 * 新步骤，或者用户点了 `/compact`。两个事务并发会同时改会话表面，
 * 造成内容错位——而且**不必然报错**，可能安静地把会话搞坏。
 *
 * 语义照抄 basic：从事件流尾部倒着找，第一条 `compaction/start` 或
 * `compaction/end` 决定状态。找到未配对的 start 即视为锁被持有。
 * 但有一个豁免：如果其后出现过 `session/end-seed`（新会话生命周期），
 * 说明那个 start 属于上一轮生命周期，不算当前锁。
 *
 * @param {object} session 会话
 * @returns {{locked: boolean, sinceSeq?: number}} 锁状态
 */
function inspectCompactionLock(session) {
    let unmatchedStart;
    let stateKnown = false;
    let latestEndSeedSeq;
    const lastSeq = typeof session?.seq === "number" ? session.seq : (session?.surface?.nodes?.length ?? 0);
    for (let seq = lastSeq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt?.(seq);
        if (event === undefined) continue;
        if (latestEndSeedSeq === undefined && event.type === "session/end-seed") latestEndSeedSeq = event.seq;
        if (!stateKnown) {
            if (event.type === "compaction/start") {
                unmatchedStart = event;
                stateKnown = true;
            } else if (event.type === "compaction/end") {
                stateKnown = true;
            }
        }
        if (stateKnown && latestEndSeedSeq !== undefined) break;
    }
    if (unmatchedStart === undefined) return { locked: false };
    // 豁免：start 之后出现了新的会话生命周期起点，说明那个 start 是上一轮的
    if (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedStart.seq) return { locked: false };
    return { locked: true, sinceSeq: unmatchedStart.seq };
}

/**
 * 压缩锁断言：锁被持有就抛 busy，绝不并发进入事务。
 *
 * @param {object} session 会话
 * @param {string} stage 阶段标签（错误信息里标明是谁撞上了锁）
 * @throws {ManualCompactionError} 锁被持有时抛 "busy"
 */
function assertCompactionInactive(session, stage) {
    const { locked, sinceSeq } = inspectCompactionLock(session);
    if (!locked) return;
    throw new ManualCompactionError(
        "busy",
        `${stage}: compaction already in progress (unclosed compaction/start at seq ${sinceSeq}); the session compaction lock is already active`,
    );
}

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
    // 首选：宿主官方 API `requestContext()`（dsh-session lib：「Return the latest
    // resolved route metadata」）。它把 `request/context` 事件 fold 成最新路由
    // 元数据，包含 contextWindow——这是读取窗口的**唯一官方途径**。
    //
    // 为什么不能只扫 surface（D17 沙箱实测暴露的真因）：
    //   旧实现遍历 `session.surface.nodes` 找 type === "request/context"，
    //   但 request/context 是**路由元数据**，未必出现在表面节点里
    //   （表面只承载消息类节点）。于是窗口永远读不到 →
    //   回落兜底 128000 → 压力按 128k 计算，与实际窗口无关。
    //   沙箱里把窗口设成 20000 却毫无反应，正是这个原因。
    const folded = session?.requestContext?.();
    const fromApi = folded?.contextWindow;
    if (typeof fromApi === "number" && fromApi > 0) return fromApi;

    // 兜底 1：扫表面（兼容没有 requestContext API 的宿主版本）
    const nodes = session?.surface?.nodes ?? [];
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const event = session.eventAt?.(nodes[index]);
        if (event?.type !== "request/context") continue;
        const window = event.data?.contextWindow;
        if (typeof window === "number" && window > 0) return window;
    }
    // 兜底 2：扫全量事件日志（不限于表面，比兜底 1 更宽）
    const total = typeof session?.seq === "number" ? session.seq : 0;
    for (let seq = total - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt?.(seq);
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
     *
     * D17 对照原版补齐（用户定「择优选用」）：原版 11 个字段里，
     * 真正影响正确性的是「按模型分别设阈值」——因为不同模型窗口差异巨大
     * （128k vs 1M 差 8 倍），一套全局公式必然对某一端不合适。
     * 其余字段（retainRatio 等）暂不做成可配：当前固定值已由
     * test/d17-threshold.test.js 钉死语义，暴露成配置项反而增加误配面。
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
        /** 全局阈值占比（第 4 层触发线），默认 0.85；下限由公式内部保底 0.82。 */
        thresholdRatio: z.number(),
        /** 全局压缩余量（token），默认 65536（原版 basic 默认值）。 */
        headroomTokens: z.number(),
        /** 溢出恢复最大重试次数，默认 1（对齐原版 basic，旧实现写死 3 偏贵）。 */
        maxOverflowRetries: z.number(),
        /** 摘要重试次数，默认 1（对齐原版 basic）：压不到阈值以下时再选一次区间重试。 */
        compactionRetries: z.number(),
        /**
         * 按模型覆盖阈值：`[{ provider, model, thresholdRatio?, headroomTokens?, maxOverflowRetries?, compactionRetries? }]`
         * 匹配不到则不覆盖（沿用全局值）。数组顺序即优先级，先匹配先用。
         */
        modelPolicies: z.array(z.object({
            provider: z.string(),
            model: z.string(),
            thresholdRatio: z.number(),
            headroomTokens: z.number(),
            maxOverflowRetries: z.number(),
            compactionRetries: z.number(),
        })),
    });

    /**
     * 解析某个模型路由的有效策略（全局值 + 精确匹配覆盖）。
     *
     * 为什么需要：不同模型窗口差 8 倍以上，同一套 headroom 对小窗口是
     * 灾难（原版在新窗口下直接抛「无压力预算」），对 1M 窗口又过于保守。
     * 允许按 provider/model 精确覆盖，匹配不到就回落全局。
     *
     * @param {{provider?: string, model?: string}} [target] 当前路由（可缺省）
     * @returns {{thresholdRatio: number, headroomTokens: number, maxOverflowRetries: number}}
     */
    policyFor(target) {
        const base = {
            thresholdRatio: this.config.thresholdRatio ?? 0.85,
            headroomTokens: this.config.headroomTokens ?? HEADROOM_TOKENS,
            maxOverflowRetries: this.config.maxOverflowRetries ?? DEFAULT_MAX_OVERFLOW_RETRIES,
            compactionRetries: this.config.compactionRetries ?? DEFAULT_COMPACTION_RETRIES,
        };
        const list = this.config.modelPolicies;
        // 路由信息可能缺失（会话早期还没有 requestHeader），也可能只填了一半。
        // 这些情况一律回落全局策略，**绝不抛错**——压缩层不能因为查不到路由
        // 就让整个 pre-step 钩子炸掉（本插件的基本约束：任何异常只降级）。
        if (!Array.isArray(list)) return base;
        if (target === undefined || target === null) return base;
        if (typeof target.provider !== "string" || typeof target.model !== "string") return base;
        const hit = list.find(
            (p) => p?.provider === target.provider && p?.model === target.model,
        );
        if (hit === undefined) return base;
        return {
            thresholdRatio: hit.thresholdRatio ?? base.thresholdRatio,
            headroomTokens: hit.headroomTokens ?? base.headroomTokens,
            maxOverflowRetries: hit.maxOverflowRetries ?? base.maxOverflowRetries,
            compactionRetries: hit.compactionRetries ?? base.compactionRetries,
        };
    }

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
        await this._flushAfterCommit(agent?.session);
        return result;
    }

    /**
     * 压缩提交后的持久化检查点（P4-2）。
     * 失败按 basic 口径抛 persistence 错误：压缩已提交但没落地，属于耐久性缺陷，
     * 不能静默放过（否则用户以为省了 token，重启后发现没省）。
     *
     * **交叉审计修复（2026-10-27，gpt-6-astra 报、我实跑确认）**：
     * 宿主签名是 `flush(session)`，不是无参。实测宿主实现：
     *   `async flush(session) { const { carrier } = this.liveEntryFor(session); ... }`
     * 而 `liveEntryFor` 第一行就读 `session.id`——
     * 传 undefined 直接抛 TypeError。
     *
     * 后果：**手动 `/compact` 每次都失败**（错误被包装成 persistence）。
     * 自动路径不走这里，所以这个 bug 一直没被真实使用暴露。
     *
     * @param {object} [session] 要落盘的会话
     */
    async _flushAfterCommit(session) {
        const sessions = this.ctx.sessions;
        if (typeof sessions?.flush !== "function") return;
        // 没有会话就跳过：宁可不落盘，也不能用 undefined 去打宿主接口
        if (session === undefined || session === null) return;
        try {
            await sessions.flush(session);
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

        // 运行时自检（健康探针）：把"各层实际计数"打成结构化日志。
        //
        // 为什么需要：D17 挖出的 10 个 bug 里 8 个是「日志正常、单测全绿、
        // 功能根本没跑」的静默失效。它们不能靠"看有没有报错"发现，
        // 只能靠计数器——某层长期为 0、或压力已高却零动作，就是异常信号。
        //
        // 安全边界：整段包 try/catch，探针自身失败绝不影响会话。
        try {
            if (this.healthReporter === undefined) {
                this.healthReporter = new HealthReporter({ logger: this.ctx.logger });
            }
            this.healthReporter.maybeReport(collectHealth({
                observer: this.observer,
                engine: this.engine,
                session,
                window,
                currentTokens: current,
                config: this.config,
            }));
        } catch {
            /* 探针失败不阻断：健康检查不该成为新的故障点 */
        }

        // 第 3 层：70% 提醒（不改历史）
        if (action === "remind") {
            this.ctx.logger.info(`tiered-compaction: 窗口压力 ${(pressure * 100).toFixed(0)}%（70%），建议收束当前任务`);
        }
        // 第 3 层：80% 驱逐（把可重放的 read/grep/glob 结果换成「请重跑」提示）。
        //
        // D17 补线（2026-10-27）：此前这里只 `emit("tiered-compaction/evict")`，
        // 而**生产代码里没有任何监听者**——只有测试在听。于是第 3 层的驱逐
        // 在真实会话里从未执行过：日志会打「已广播易失内容驱逐事件」，
        // 看起来像做了事，实际会话表面一个字节都没变。
        // 这正是本插件反复踩的同一类坑：**广播不等于落地，有监听才算生效**。
        //
        // 现在直接调用观察者上已有的 evictStaleToolResults（它本来就是为这一层
        // 写的，只是从没人调用），并保留事件广播供外部观测。
        if (action === "evict") {
            this.ctx.emit("tiered-compaction/evict", { session, pressure, at: Date.now() });
            try {
                const { evicted } = await this.observer.evictStaleToolResults(session);
                this.ctx.logger.warn(
                    `tiered-compaction: 窗口压力 ${(pressure * 100).toFixed(0)}%（80%），` +
                    `已驱逐 ${evicted} 个可重放工具结果`,
                );
            } catch (error) {
                // 驱逐失败只降级：绝不能因为瘦身失败让步进炸掉
                this.ctx.logger.warn(
                    `tiered-compaction: 80% 驱逐失败（已忽略）：${error?.message ?? error}`,
                );
            }
        }
        // 第 4 层触发判定：overflow 直接触发；pressure 达阈值触发。
        // 阈值按**当前路由模型**取策略：不同模型窗口差 8 倍，
        // 同一套 headroom 对小窗口是灾难、对 1M 窗口又过于保守
        // （D17 对照原版 basic 的 modelPolicies 后补齐）。
        const policy = this.policyFor(this._targetFromAgent(agent));
        const threshold = lossyThreshold(window, {
            thresholdRatio: policy.thresholdRatio,
            headroomTokens: policy.headroomTokens,
        });
        const need = trigger === "context-overflow" || current >= threshold;
        if (!need) return null;
        if (trigger === "context-overflow") {
            if (this.overflowRetries.get(agent)) return null; // 一次 overflow 只补一枪
            this.overflowRetries.set(agent, true);
            // 交叉审计修复（2026-10-27，gpt-6-astra / gpt-5.6-sol 都报、我实跑确认）：
            // overflow 必须**强制**压缩，不能沿用保留尾部策略。
            //
            // 缺陷：overflow 与 pressure 共用 _compactWithRetention，仍按 retain
            // 保留近端尾部。当表面总量不足以在保留尾部之外形成可压区间时，
            // `_selectRange` 返回 null → 本次恢复什么都没做 → 原始溢出错误照样抛给用户。
            //
            // 实测：三个各约 100 token 的表面节点，retain=16000 时 `_selectRange` 返回 null；
            // 改成 retain=0 就能选出整段配平区间。
            //
            // 原版 basic 对 overflow 明确调用 `selectCompactableRange(..., 0)`
            // （lib/index.js:927-934）——不保留尾部，强制尝试一次有用且配平的缩减。
            // 这是有意的取舍：溢出了就没资格挑三拣四，先腾出空间再说。
            return this._compactWithRetention(session, agent, signal, {
                threshold,
                measure: () => this.ctx.tokenMeter?.measure?.(session)?.totalTokens ?? 0,
                retainOverride: 0,
            });
        }
        return this._compactWithRetention(session, agent, signal, {
            threshold,
            measure: () => this.ctx.tokenMeter?.measure?.(session)?.totalTokens ?? 0,
        });
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
        const target = this._summaryTargetOf(agent);
        if (target === undefined) throw new ManualCompactionError("summary", "tiered-compaction: 无摘要路由（summaryTarget 与会话路由均缺）");
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
            const target = this._summaryTargetOf(agent);
            // 无摘要路由时不接管：交回宿主（保留原始错误，不掩盖）
            if (target === undefined) return next();
            const retries = this.overflowRetries.get(agent) ?? 0;
            // 重试上限按路由模型取策略（可被 modelPolicies 覆盖），默认 1
            // ——对齐原版 basic，避免为必败的请求多付 2 次 LLM 费用。
            const overflowPolicy = this.policyFor(this._targetFromAgent(agent));
            const maxRetries = overflowPolicy.maxOverflowRetries ?? DEFAULT_MAX_OVERFLOW_RETRIES;
            if (retries >= maxRetries) return next();
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

    /**
     * 压力/溢出压缩：保留近端 tail（窗口保护量），其余交事务。
     *
     * D17 补上重试（对齐原版 basic 的 `compactionRetries`，默认 1）：
     * 一次摘要可能压不到阈值以下（模型不肯缩、或选区本来就小），
     * 原版会再选一次区间重试。此前我们一次不成就算结束，
     * 结果是「压力仍高但不再压」，直到溢出才被动救火。
     *
     * @param {object} session 会话
     * @param {object} agent agent
     * @param {AbortSignal} [signal] 取消信号
     * @param {{threshold?: number, measure?: () => number}} [options]
     *   传了 threshold 与 measure 才启用重试；不传则保持单次语义（compactNow 等路径）
     */
    async _compactWithRetention(session, agent, signal, options = {}) {
        const meter = this.ctx.tokenMeter;
        const window = contextWindowOf(session);
        const { threshold, measure } = options;
        // 保留量（保留最近多少 token 原样不压）。
        //
        // D17 沙箱实测挖出的第三个真 bug（2026-10-27）：
        // 旧公式 `max(16000, window × 5%)` 在小窗口下会**吃掉整个窗口**——
        // 窗口 20000 时保留 16000（占 80%），可选区间被挤到只剩 92 token，
        // 于是摘要必然「比被取代的内容还大」，每一次都失败：
        //   summary is not smaller than the shadowed content (634 >= 92)
        //
        // 原版 basic 对此有硬约束（lib/index.js:134）：
        //   retainTokens >= thresholdTokens 直接配置报错。
        // 我们照抄这个约束的用意，但改成运行时收敛而不是抛错——
        // 小窗口是合法场景，不该因此完全丧失压缩能力。
        //
        // 修法：保留量不得超过阈值的一半，保证至少一半阈值的内容可压。
        // 大窗口下（1M：base=50k，cap=425k）行为完全不变；
        // 小窗口下（20k：base=16000，cap=8200）保留量降到 8200，选区恢复正常。
        const retainBase = Math.max(16000, Math.floor(window * 0.05));
        // retainOverride：overflow 强制恢复时传 0（不保留尾部，整段可压）。
        // 见 compactIfNeeded 里的说明——溢出了就没资格挑挑拣拣。
        const retain = options.retainOverride !== undefined
            ? options.retainOverride
            : (threshold === undefined
                ? retainBase
                : Math.max(0, Math.min(retainBase, Math.floor(threshold * 0.5))));
        // 未提供阈值读数时保持原单次行为（例如手动 compactNow 走全表面）
        const maxAttempts = threshold === undefined || measure === undefined
            ? 1
            : (this.policyFor(this._targetFromAgent(agent)).compactionRetries ?? 1) + 1;
        let lastResult = null;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            // 重试时把保留量减半：第一次压不够说明选区偏小，
            // 再选同样大小只会得到同样结果。原版重试也正是重新选区。
            // （旧代码写成 `attempt === 0 ? retain : retain`——两边相同，
            //   等于重试时原地重选，白白多付一次 LLM 调用。）
            const attemptRetain = attempt === 0 ? retain : Math.floor(retain * 0.5);
            const range = this._selectRange(session, meter.measure(session), attemptRetain);
            if (range === null) return lastResult;
            lastResult = await this._runTransaction(session, range.start, range.end, agent, signal);
            // 压完重新测量：已降到阈值以下就不必再试
            if (threshold === undefined || measure === undefined) return lastResult;
            if (measure() < threshold) return lastResult;
            this.ctx.logger.warn(
                `tiered-compaction: 第 ${attempt + 1} 次压缩后仍高于阈值（${measure()} >= ${threshold}），继续重试`,
            );
        }
        // 用完重试次数仍高于阈值：如实告知，不静默放弃
        throw new ManualCompactionError(
            "summary",
            `tiered-compaction: 压缩 ${maxAttempts} 次后仍高于阈值（${measure?.()} >= ${threshold}）`,
        );
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
        // 最小可压缩量守卫（D17 真实模型实测挖出的 bug，2026-10-27）。
        //
        // 症状：真实会话窗口 24000、阈值 19680、retain 9840，
        // 而被压缩表面总计只有约 11.8k token。从尾累计到 9840 时
        // 只剩第一个节点（23 token）可压，于是摘要必然失败：
        //   summary is not smaller than the shadowed content (306 >= 23)
        // 实测：第 4 层 3 次事务 3 次失败、0 次成功，每一步都在重试同一件事。
        //
        // 关键点：这不是「摘要写得不够短」，而是**选区本身没有压缩空间**。
        // 原版 basic 的 selectCompactableRange 在 keepFromIdx <= firstIdx 时
        // 返回 null（= 本次不压）；我们的口径相同却仍返回了 23 token 的区间，
        // 让它进事务里注定失败。
        //
        // 判据：被取代内容的预估量必须显著大于摘要本身的成本。
        // 摘要固定预留 20000 token 预算，正文至少几百 token；
        // 压一个几百 token 以下的区间永远净亏损。这里取 RESERVE_TOKENS 的 5%
        // （= 1000 token）作为下限：低于它直接放弃本次（返回 null），
        // 语义与「暂无可压内容」一致，不报错、不重试、不花 LLM 调用。
        //
        // 但 overflow 强制恢复（retainTokens === 0）必须跳过这道守卫：
        // 已经溢出了，可压区间再小也得压——否则就是"因为省得不够多而拒绝救命"。
        const compactable = priced.slice(firstIdx, endIdx + 1)
            .reduce((total, node) => total + (node?.tokens ?? 0), 0);
        const isForced = retainTokens === 0;
        if (!isForced && compactable < Math.floor(RESERVE_TOKENS * 0.05)) return null;
        return { start: surfaceNodes[firstIdx], end: surfaceNodes[endIdx] };
    }

    /**
     * 事务：start → 摘要 → summary 事件 + user/message(surfaceOp replace) → end。
     * 返回形状与 basic 对齐；任何失败补一条带 error 的 compaction/end 后上抛。
     *
     * D17 补两道原版护栏（此前完全没有）：
     *   1. 进入前查压缩锁（assertCompactionInactive）——防止两个事务并发改表面
     *   2. 摘要返回后、提交前校验选区未变（assertSpanStable）——防止
     *      「按 A 版内容生成摘要，却提交到已变成 B 版的表面」这种错位
     */
    async _runTransaction(session, start, end, agent, signal) {
        // 护栏 1：压缩锁。放在 append start 之前，锁被占时不留任何痕迹。
        assertCompactionInactive(session, "tiered-compaction");
        const compactionId = CompactionId(randomUUID());
        // 交叉审计修复（2026-10-27，gpt-5.6-sol 报、我查宿主格式校验确认）：
        // `compaction/start` 与 `compaction/end` 的 data **必须带 turn**。
        //
        // 宿主 `dsh-session-format-v0-to-v1/lib/index.js:53,59`：
        //   "compaction/start": disposition(["compactionId", "turn"], ["sourceCommandId"])
        //   "compaction/end":   disposition(["compactionId", "turn"], ["sourceCommandId", "error"])
        // 缺 turn 的记录在格式校验/迁移/恢复时会被拒绝——而我们是靠 append
        // 写进内存日志的，当时不报错，问题会推迟到下次读取或升级时才炸。
        //
        // 原版 basic 的取法（lib/index.js:707-722）：倒扫事件流找未配对的
        // `turn/start`，其 `data.turn` 即当前 open turn；没有则传 null
        // （空闲态压缩是合法的，null 表示不属于任何 turn）。
        //
        // 我们照抄同一口径，并对此前所有历史事件保持兼容。
        const lifecycle = { compactionId, turn: openTurnOf(session) };
        const startEvent = session.append("compaction/start", lifecycle);
        try {
            const surfaceNodes = session.surface.nodes;
            // D17 沙箱实测挖出的第四个真 bug（2026-10-27）：
            // 选区必须按**表面位置**切片，不能按数值区间过滤。
            //
            // 表面上的 seq 不是单调递增的：一次 replace 会把新事件的 seq 放回
            // 被替换节点原来的位置（compactCheckpoint 就插在旧位置）。
            // 于是 `filter(seq >= start && seq <= end)` 会漏掉那些「位置在区间内、
            // 但 seq 数值在区间外」的节点，并且首尾比对必然失败，报
            //   compaction: the selected span is no longer a valid replacement target
            //
            // 实测证据：小窗口沙箱里这类失败 4 次，另有 13 次更隐蔽的
            // 「changed during summarization」——因为过滤得到的 shadowedSeqs
            // 与稳定性校验（用位置切片）的期望值对不上，校验必然判变动。
            //
            // 原版 basic 全程用位置索引（prepareCompaction / assertSelectedSpanStable
            // 都是 nodes.slice(startIdx, endIdx + 1)），这里照抄同一口径。
            const startIdx = surfaceNodes.indexOf(start);
            const endIdx = surfaceNodes.indexOf(end);
            if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
                throw new Error("compaction: the selected span is no longer a valid replacement target");
            }
            const shadowedSeqs = surfaceNodes.slice(startIdx, endIdx + 1);
            // 摘要输入：把区间内每个节点投影成文本，按表面序拼接。
            //
            // P0 审计发现（2026-10-27 系统审计）：旧实现只读 `data.content`，
            // 而真实宿主里只有 `user/message` 用这个形状：
            //   user/message      → data.content            ✅ 能读到
            //   assistant/message → data.message.content    ❌ 旧实现读到空
            //   tool/result       → data.message.content    ❌ 旧实现读到空
            //
            // 实测量化（真实会话 14 条事件）：旧逻辑只抽出 45838 字，
            // 而实际内容有 277328 字——**丢了 83.5%**，其中
            // tool/result 的 224556 字**一个字都没进摘要**。
            //
            // 后果：摘要只看得到用户说了什么，看不到助手做了什么、
            // 工具返回了什么。而工具结果恰恰是压缩的主要对象。
            // 这会产出「知道用户要什么、不知道进展到哪」的半截检查点，
            // 比不压更糟——续做的模型会重复已经做过的工作。
            //
            // 修法：两种形状都试，且对 assistant 消息额外收集 tool-call 摘要
            // （工具名+参数，不含 reasoning——推理过程对续做无用且极占篇幅）。
            const input = shadowedSeqs
                .map((seq) => textOfEventForSummary(session.eventAt(seq)))
                .filter((t) => t.length > 0)
                .join("\n");
            const estimate = estimateTokens(input);
            // 摘要是一次 LLM 往返，期间会话可能已经变了。记下提交前需要校验的快照。
            const prepared = { start, end, shadowedSeqs: [...shadowedSeqs] };
            const { summary, provider, model, maxTokens } = await this.summarize(input, agent, signal);

            // 取消检查（交叉审计修复，2026-10-27，gpt-6-astra 报、我实跑确认）。
            //
            // 缺陷：旧实现只在**入口**检查一次 signal，摘要（一次 LLM 往返，
            // 几秒到几十秒）期间用户按了取消，返回后照样提交——
            // 实测 `{aborted:true, checkpointCommitted:true}`，
            // 取消操作完全没能阻止不可逆的会话写入。
            //
            // 原版 basic 在摘要后、提交前都再查一次（lib/index.js:479/513）。
            // 这里照抄：已花掉的 LLM 调用无法收回，但**内容不能提交**。
            signal?.throwIfAborted();

            // 护栏 2：提交前校验选区仍然可替换（basic 的 assertSelectedSpanStable 等价物）。
            // 摘要已花掉一次 LLM 调用，若此处发现变动，宁可丢弃摘要也不提交错位内容。
            this._assertSpanStable(session, prepared);

            // 提交前最后一道取消检查：稳定性校验可能耗时（扫表面），
            // 期间仍可能被取消。
            signal?.throwIfAborted();

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

    /**
     * 提交前校验：摘要期间选区没有被改动（D17 对齐原版 basic 的
     * `assertSelectedSpanStable`）。
     *
     * 防的是什么：摘要是异步的（一次 LLM 往返，几秒到几十秒）。这期间：
     *   - 用户可能插了新消息
     *   - 工具结果可能新落盘
     *   - 上一层的观察者可能替换了选区内的节点
     * 如果选区变了却照样提交，摘要内容与提交位置就会错位——
     * 结果是会话里留下「总结的是旧内容、替换的是新内容」的检查点，
     * 而且**不报错**，日后很难追。
     *
     * 校验三件事（与 basic 同口径）：
     *   1. 起点/终点仍在表面上，且顺序正确
     *   2. 选区内的节点集合与摘要时记录的一致
     *   3. 选区两端仍是配平边界（不劈开 tool-call/result 对）
     *
     * @param {object} session 会话
     * @param {{start: number, end: number, shadowedSeqs: number[]}} prepared 摘要前的快照
     * @throws {ManualCompactionError} 变动时抛 "changed"
     */
    _assertSpanStable(session, prepared) {
        const nodes = session.surface?.nodes ?? [];
        const { start, end, shadowedSeqs } = prepared;
        const startIdx = nodes.indexOf(start);
        const endIdx = nodes.indexOf(end);
        if (startIdx === -1 || endIdx === -1) {
            throw new ManualCompactionError(
                "changed",
                "the selected span is no longer present on the surface (summarization raced with compaction of the same region)",
            );
        }
        if (startIdx > endIdx) {
            throw new ManualCompactionError("changed", "the selected span order changed during summarization");
        }
        const current = nodes.slice(startIdx, endIdx + 1);
        if (current.length !== shadowedSeqs.length || current.some((seq, i) => seq !== shadowedSeqs[i])) {
            throw new ManualCompactionError(
                "changed",
                "the selected span changed during summarization; refusing to commit a summary of stale content",
            );
        }
        if (!toolPairingBalancedBefore(session, nodes[startIdx]) || !toolPairingBalancedAfter(session, nodes[endIdx])) {
            throw new ManualCompactionError(
                "changed",
                "the selected span is no longer a balanced boundary; refusing to split a tool-call/result pair",
            );
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
     * 解析摘要路由：配置优先，缺失则回落到会话当前路由。
     *
     * D17 沙箱实测挖出的第二个真 bug（2026-10-27）：
     * 配置里**没写** `summaryTarget` 时，schemastery 反序列化会把它变成
     * **空对象 `{}`**，不是 `undefined`。于是 `config.summaryTarget ?? 会话路由`
     * 的 `??` 短路失效——拿到的是 `{}`，`target.provider` 与 `target.model`
     * 都是 `undefined`，摘要请求带着空路由发出去，必然失败。
     *
     * 这与第一个 bug 叠加成一次「双重静默」：
     *   空路由 → LLM 调用失败 → finish 字段读错被吞 → 只报「摘要结果为空」。
     * 实测证据：沙箱 21 次压缩事务，21 次「摘要结果为空」，零真实原因。
     *
     * 因此这里按「字段齐全才算有效」判断，空对象一律视为未配置。
     *
     * @param {object} [agent] 当前 agent（提供会话路由）
     * @returns {{provider: string, model: string} | undefined}
     */
    _summaryTargetOf(agent) {
        const configured = this.config.summaryTarget;
        if (
            configured !== undefined && configured !== null &&
            typeof configured.provider === "string" && configured.provider.length > 0 &&
            typeof configured.model === "string" && configured.model.length > 0
        ) {
            return { provider: configured.provider, model: configured.model };
        }
        return this._targetFromAgent(agent);
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
            // finish 错误必须上抛：否则会把半截输出当完整摘要提交。
            //
            // D17 沙箱实测真 bug（2026-10-27）：`assembler.finish` 的形状是
            // `{ kind, failure }`，根本没有 `error` 字段。旧代码读
            // `assembler.finish?.error` 永远是 undefined，于是**每一次** LLM
            // 失败都被静默吞掉：blocks() 为空 → 返回空串 → 外层只报
            // 「摘要结果为空」，真实错误（限流/超时/密钥）全部丢失。
            // 实测证据：21 次压缩事务 21 次「摘要结果为空」，无一条真实原因。
            // 原版 basic 用 finishError() 按 kind 分派（lib/index.js:358-369），
            // 这里照抄同一判定口径。
            const failure = finishErrorOf(assembler.finish);
            if (failure !== undefined) throw failure;
            const blocks = assembler.blocks?.() ?? [];
            return blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        };
    }
}

/** 测试用探测面：暴露内部纯函数（生产代码不消费）。 */
export const __test = { contextWindowOf, textOfEventForSummary };
