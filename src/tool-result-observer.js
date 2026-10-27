/**
 * 宿主观察者（P2 修补核心）：把第 1-3 层真正接到宿主的会话事件流上。
 *
 * 背景（D16 审计）：
 * - P1：`engine.processToolOutput` 全仓库只有测试调用——工具输出没有宿主入口，
 *   第 1-2 层在真实会话里零执行，`archiveDir` 收下后零消费。
 * - P2-1：80% 驱逐只是 `ctx.emit` 广播，**全仓库无监听者**；70% 提醒只进日志。
 *
 * 本模块按 DSH 官方 `dsh-compaction-tool-result-pruner` 的落地范式补上这条路：
 *   1. `session/event` 里出现 `tool/result` → 取内容过第 1-2 层（折叠 → 落盘）
 *   2. 若内容确实变小 → 先 append `compaction/prune` 影子定价事件，
 *      再 append 带 `surfaceOp: replace` 的替换事件（与官方 pruner 逐字段同形）
 *   3. 谱系表登记「原位 → 存档路径」取代关系（保真原则 2）
 *   4. 压力 ≥80% 时对「易失且可重放」的历史工具结果做同一套替换（第 3 层落地）
 *
 * 安全边界（为什么这样做是安全的）：
 * - 只替换 `tool/result` 自身，**不动 assistant tool-call**，故不破坏 tool-pairing；
 * - 替换事件保留原事件全部 data，仅换 content（官方 pruner 同款做法）；
 * - `compaction/prune` 必须先于 replace 写入（宿主据此做影子定价）；
 * - 任何异常只记警告，绝不阻断会话（与 basic / pre-step 钩子同款口径）。
 */

/** 替换内容的标记：一眼能看出这是被压缩过的，并给出存档路径。 */
export const PRUNE_MARKER = "[tiered-compaction";

/**
 * 从 `tool/result` 事件里取原始文本内容。
 * @param {object} event 会话事件
 * @returns {string | null} 无法取文本时返回 null（图片/文件等富块跳过）
 */
export function textOfToolResult(event) {
    const content = event?.data?.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    // 只处理纯文本结果：含非 text 块（图片/附件）一律跳过，避免破坏富块结构
    if (content.some((block) => block?.type !== "text")) return null;
    return content.map((block) => block.text ?? "").join("\n");
}

/**
 * 生成替换后的 content（纯文本块 + 预览 + 存档指引）。
 * @param {string} preview 预览文本
 * @param {{path?: string, sha256?: string, size?: number}} info 存档信息
 * @returns {Array<{type: "text", text: string}>}
 */
export function prunedContent(preview, info) {
    const where = info.path === undefined
        ? ""
        : `\n存档：${info.path}（${info.size ?? 0} 字节，sha256 ${(info.sha256 ?? "").slice(0, 16)}…）`;
    return [{
        type: "text",
        text: `${PRUNE_MARKER} 原始输出已折叠/落盘，此处为预览]\n${preview}${where}`,
    }];
}

/**
 * 观察者：把工具结果压缩接到会话表面。
 *
 * 与 `TieredCompactionEngine` 的分工：引擎是纯函数式四层实现，不做任何 I/O 与
 * 会话写；本类只负责「何时调引擎、怎么把结果写回会话」。
 */
export class ToolResultObserver {
    /**
     * @param {{
     *   engine: import('./engine.js').TieredCompactionEngine,
     *   ctx: { logger: {info(msg: string): void, warn(msg: string): void}, on(name: string, fn: Function): void },
     *   enabled?: boolean,
     * }} options
     */
    constructor({ engine, ctx, enabled = true }) {
        this.engine = engine;
        this.ctx = ctx;
        this.enabled = enabled;
        /** 已处理过的源事件 seq，避免第 1-2 层重复替换（同一 seq 只加工一次）。 */
        this.done = new Set();
        /**
         * 已被第 3 层驱逐过的 seq。
         *
         * 必须与 `done` 分开（D17 实测 bug）：`done` 是「内容已压缩过」，
         * 本集合是「已换成重跑提示」。混用会让第 3 层被第 1-2 层永久禁用——
         * 凡是被折叠/落盘过的结果，都因为已在 done 里而被跳过。
         */
        this.evicted = new Set();
        /** 统计面（供探针与安装记录核对，不进业务路径）。 */
        this.stats = { replaced: 0, bytesSaved: 0, skipped: 0, failed: 0 };
    }

    /** 注册宿主钩子：工具结果产生即加工。 */
    register() {
        if (!this.enabled) return;
        // 宿主钩子签名是**位置参数** `(session, event)`——见 basic 的实现
        // （dsh-compaction-basic/lib/index.js:856）与自家 contract.js:343。
        //
        // 这里曾经写成 `(payload) => payload?.session ?? payload?.[0]`，结果
        // session 与 event 全是 undefined，函数在第一行就 return——第 1-2 层
        // 在真实会话里从未执行过，且不报任何错（archiveDir 一直不创建正是这个
        // 原因）。单测直接调 handleEvent，绕过了钩子签名，所以全绿。
        // 教训与 D16 三实锤同源：测试桩能过 ≠ 宿主能跑。
        //
        // 兼容写法保留：个别版本若按对象传 ({session, event}) 也能接住。
        this.ctx.on("session/event", async (first, second) => {
            const session = first?.session ?? (Array.isArray(first) ? first[0] : first);
            const event = first?.event ?? (Array.isArray(first) ? first[1] : second);
            if (session === undefined || event === undefined) return;
            try {
                await this.handleEvent(session, event);
            } catch (error) {
                // 绝不阻断会话：压缩层失败必须降级为「不加工」
                this.stats.failed += 1;
                this.ctx.logger.warn(
                    `tiered-compaction: 工具结果观察者出错（已降级，不影响会话）：${error?.message ?? error}`,
                );
            }
        });
    }

    /**
     * 处理单条事件（可被测试直接调用，不必起钩子）。
     * @param {object} session 会话
     * @param {object} event 事件
     */
    async handleEvent(session, event) {
        if (event?.type !== "tool/result") return;
        if (event.seq === undefined || this.done.has(event.seq)) return;
        // D17 系统审计修复（2026-10-27）：去重标记必须在 **await 之前**占位。
        //
        // 缺陷：旧代码在 `await this.engine.processToolOutput(...)` **之后**才
        // `this.done.add(event.seq)`。这中间有一个真实的竞态窗口：
        // 同一事件被并发派发两次（宿主重放、钩子重复注册、或宿主不 await 钩子），
        // 两次调用都会通过 `done.has()` 检查，于是：
        //   · engine 处理两次（白做一次折叠/落盘，多写一个存档文件）
        //   · 产生两条 surfaceOp: replace 事件（同一位置被替换两次）
        // 实测复现：并发两次 → processToolOutput 被调用 2 次、替换事件 2 条。
        //
        // 修法：进入前先占位（先 add 再 await），失败时再回滚。
        // 这样即使并发进入，第二个调用会在第一行就被挡掉。
        this.done.add(event.seq);
        const text = textOfToolResult(event);
        if (text === null) {
            this.stats.skipped += 1;
            return;
        }
        // 第 1-2 层：折叠 → （折叠后仍 >8k 字节才）落盘
        // 传 sessionId：存档文件名据此区分会话，避免跨会话 seq 重号互相覆盖
        // （D17 验收 P0-1：旧文件名只有 arbitrated-<seq>，不同会话必然重号）
        let processed;
        let layers;
        try {
            ({ text: processed, layers } = await this.engine.processToolOutput(text, {
                seq: event.seq,
                sessionId: session?.id,
            }));
        } catch (error) {
            // 处理失败必须回滚占位，否则该 seq 永久被跳过（下次重放也无法补救）
            this.done.delete(event.seq);
            throw error;
        }
        if (processed === text || layers.length === 0) {
            return; // 无收益，占位保留（不必重复尝试同一内容）
        }
        // 落盘信息从谱系表取回（引擎在落盘层已登记）
        const spillInfo = this.engine.lastSpillInfo?.(event.seq) ?? {};
        this.replace(session, event, processed, spillInfo);
        this.stats.replaced += 1;
        this.stats.bytesSaved += Math.max(0, text.length - processed.length);
        this.ctx.logger.info(
            `tiered-compaction: 工具结果 seq=${event.seq} 已压缩（${layers.join("+")}），` +
            `${text.length} → ${processed.length} 字符`,
        );
    }

    /**
     * 把压缩结果写回会话表面（官方 pruner 同款两步：影子定价 → replace）。
     * @param {object} session
     * @param {object} event 源 `tool/result` 事件
     * @param {string} processed 压缩后的文本
     * @param {{path?: string, sha256?: string, size?: number}} spillInfo
     */
    replace(session, event, processed, spillInfo) {
        // 第一步：影子定价（纯消费方可据此扣减 token，不必逐节点记账）
        session.append("compaction/prune", {
            shadowedRange: { start: event.seq, end: event.seq },
            shadowedSeqs: [event.seq],
            shadowedTokenCount: this.estimateTokens(event),
        });
        // 第二步：替换事件（保留原 data 全部字段，仅换 content）
        const replacement = session.append("tool/result", {
            ...event.data,
            message: {
                ...event.data.message,
                content: prunedContent(processed, spillInfo),
            },
        }, {
            surfaceOp: { op: "replace", startSeq: event.seq, endSeq: event.seq },
            sourceEventSeqs: [event.seq],
        });
        return replacement;
    }

    /**
     * 第 3 层落地：压力 ≥80% 时驱逐「易失且可重放」的历史工具结果。
     *
     * 与第 1-2 层的区别：这一层不产生归档，直接把可重放工具结果（read/grep/glob）
     * 换成「请重跑」提示——它们随时能重新取回，属于最便宜的瘦身。
     * @param {object} session
     * @returns {Promise<{evicted: number}>}
     */
    async evictStaleToolResults(session) {
        const surface = session.surface?.nodes ?? [];
        let evicted = 0;
        for (const seq of [...surface]) {
            const event = session.eventAt(seq);
            if (event?.type !== "tool/result") continue;
            // 只跳过「已被第 3 层驱逐过」的，不能沿用 `done`。
            //
            // D17 实测真 bug（2026-10-27，用真实模型跑沙箱时暴露）：
            // `done` 是**第 1-2 层的处理标记**——handleEvent 处理完就把 seq
            // 加进去。而驱逐这里也用它做去重，于是：
            //   凡是第 1-2 层碰过的工具结果，第 3 层永远轮不到。
            // 实测：压力 83.9%（20148/24000）已越过 80% 驱逐线，
            // read 结果也确实被第 2 层折叠/落盘过（因此全在 done 里），
            // 结果驱逐数恒为 0——日志还会打「已驱逐 0 个」，看起来跑了。
            //
            // 两者语义不同：`done` = 已做过内容压缩；`evicted` = 已换成重跑提示。
            // 必须分开记账，否则第 3 层等于被第 1-2 层永久禁用。
            if (this.evicted.has(seq)) continue;
            const name = this.toolNameOf(session, event);
            // 只驱逐可重放类（read/grep/glob）：重跑即恢复，属设计稿 §3 优先级 2
            if (name !== "read" && name !== "grep" && name !== "glob") continue;
            const text = textOfToolResult(event);
            if (text === null) continue;
            session.append("compaction/prune", {
                shadowedRange: { start: seq, end: seq },
                shadowedSeqs: [seq],
                shadowedTokenCount: this.estimateTokens(event),
            });
            session.append("tool/result", {
                ...event.data,
                message: {
                    ...event.data.message,
                    content: prunedContent(
                        `[已驱逐：${name} 的结果可随时重跑恢复]`,
                        {},
                    ),
                },
            }, {
                surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
                sourceEventSeqs: [seq],
            });
            this.evicted.add(seq);
            evicted += 1;
        }
        if (evicted > 0) {
            this.engine.lineage.record(
                `soft-pressure@${Date.now()}`,
                `${evicted} 个可重放工具结果已驱逐（可重跑恢复）`,
                "soft-pressure",
            );
            this.ctx.logger.warn(`tiered-compaction: 80% 压力驱逐 ${evicted} 个可重放工具结果`);
        }
        return { evicted };
    }

    /**
     * 取某条 `tool/result` 对应的工具名。
     *
     * D17 沙箱实测挖出的真 bug（2026-10-27，用真实模型跑出来的）：
     * 真实宿主的 `tool/result` 事件**没有工具名**。实测结构是：
     *   data = { turn, step, message: { role, source: { kind, callId },
     *                                  toolCallId, content, isError, id },
     *            meta: { path, offset, lines, totalLines, lang } }
     * 工具名只存在于配对的 **`tool/call` 事件**：
     *   data = { turn, step, callId, name: "read", arguments: "..." }
     *
     * 旧代码读 `source.toolName ?? data.toolName`，两个字段都不存在，
     * 永远得到 undefined → 第 3 层驱逐**一个也挑不出来**（evicted 恒为 0），
     * 而日志仍会打「已驱逐」——又一次「看起来做了、实际没做」。
     *
     * 匹配口径：`tool/result.data.toolCallId` 与 `tool/call.data.callId` 相等
     * （实测两者逐字相同，都是 `call_xx|item_yy` 形式）。
     *
     * @param {object} session 会话
     * @param {object} event 一条 tool/result 事件
     * @returns {string | undefined} 工具名；找不到返回 undefined
     */
    toolNameOf(session, event) {
        // 快路径：有些宿主/桩会把名字直接挂在结果上（保持兼容）
        const inline = event?.data?.message?.source?.toolName ?? event?.data?.toolName;
        if (typeof inline === "string" && inline.length > 0) return inline;

        const callId = event?.data?.toolCallId ?? event?.data?.message?.toolCallId;
        if (typeof callId !== "string" || callId.length === 0) return undefined;

        // 真实路径：到日志里找配对 tool/call 的 name。
        // 从结果事件往前扫（call 必然早于 result），命中即返回。
        const total = typeof session?.seq === "number" ? session.seq : 0;
        const startSeq = typeof event?.seq === "number" ? event.seq : total - 1;
        for (let seq = startSeq; seq >= 0; seq -= 1) {
            const candidate = session.eventAt?.(seq);
            if (candidate?.type !== "tool/call") continue;
            if (candidate.data?.callId !== callId) continue;
            const name = candidate.data?.name;
            if (typeof name === "string" && name.length > 0) return name;
        }
        return undefined;
    }

    /** 自算 token（与 contract.js 同口径：字符数/4 向上取整）。 */
    estimateTokens(event) {
        const text = textOfToolResult(event) ?? "";
        return Math.ceil(text.length / 4);
    }
}
