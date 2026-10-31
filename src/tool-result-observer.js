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
import { nodeLocation } from "./lineage.js";
// beta3 多 realm：计数存进进程级共享表，状态路由持有者（可能是别的实例）也读得到。
import { layerCountsFor } from "./shared-stats.js";

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
 * 源事件是否仍是当前表面上的活节点（W8）。
 *
 * 宿主 API（dsh-session lib）：`session.surface.nodes` 是当前表面的 seq 数组，
 * `session.eventAt(seq)` 返回日志里该 seq 的事件对象（同一冻结引用）。
 * 两条都满足才允许写 prune + replace。
 * @param {object} session
 * @param {{seq: number}} event
 * @returns {boolean}
 */
function isLiveSurfaceNode(session, event) {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes) || !nodes.includes(event.seq)) return false;
    return typeof session.eventAt !== "function" || session.eventAt(event.seq) === event;
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
    constructor({ engine, ctx, enabled = true, onSessionActive } = {}) {
        this.engine = engine;
        this.ctx = ctx;
        this.enabled = enabled;
        /**
         * 会话活跃回调：每处理一条 session/event 就把该会话登记给 contract，
         * 状态路由据此找到「最近活跃会话」（不再只认发生过压缩的会话）。
         */
        this.onSessionActive = typeof onSessionActive === "function" ? onSessionActive : undefined;
        /**
         * 每个会话各自的去重集合，`WeakMap<session, {done, evicted}>`。
         *
         * **P0 审计发现（2026-10-27）**：旧实现是一个进程级 `Set`，只按
         * `event.seq` 记账。但 `seq` 是**会话内**序号，每个会话都从 0 开始，
         * 而 `contract.js` 全进程只创建一个 observer、注册一次钩子，所有会话
         * 共用它。于是：
         *
         *   会话 A 处理 seq 0/1/2 → done = {0,1,2}
         *   会话 B（新会话）的 seq 也是 0/1/2 → 全部命中 done → 一条都不处理
         *
         * 实测：会话 A replaced=3，其后三个全新会话 replaced 恒为 0，
         * `stats` 完全冻结、**零报错**。即「第一个会话之后，压缩静默失效」。
         *
         * 这比之前的 bug 更隐蔽：第一个会话是好的，你根本不会怀疑它坏了。
         *
         * 用 WeakMap 而不是 `session.id#seq` 字符串键，还有个附带好处：
         * 会话对象被回收时，它的集合自动释放，长驻进程不会无限增长。
         */
        this.perSession = new WeakMap();
        /** 统计面（供探针与安装记录核对，不进业务路径）。 */
        this.stats = { replaced: 0, bytesSaved: 0, skipped: 0, failed: 0 };
        /** 防止重复注册（HMR 重载 / 旁路+接管并存时会有两个实例）—— P0-4。 */
        this._registered = false;
    }

    /**
     * 取某会话的去重集合（不存在则创建）。
     * @param {object} session
     * @returns {{done: Set<number>, evicted: Set<number>, counts: object}}
     */
    stateOf(session) {
        let state = this.perSession.get(session);
        if (state === undefined) {
            // counts 是**该会话**的显式计数：processed 只记实际写回的替换，
            // done 集合是「尝试过」的占位（含 skip/无收益），不能当计数用。
            state = {
                done: new Set(),
                evicted: new Set(),
                counts: layerCountsFor(session),
            };
            this.perSession.set(session, state);
        }
        return state;
    }

    /**
     * 查询某会话的计数快照（health-check / 状态路由用）。
     * 未见过的会话返回全 0，且不在 WeakMap 里留下条目。
     * @param {object} session
     * @returns {{processed: number, bytesSaved: number, skipped: number, failed: number, evicted: number, spilled: number}}
     */
    statsFor(session) {
        const counts = session == null ? undefined : this.perSession.get(session)?.counts;
        return counts === undefined
            ? { processed: 0, bytesSaved: 0, skipped: 0, failed: 0, evicted: 0, spilled: 0 }
            : { ...counts };
    }

    /** 把会话登记为最近活跃（回调异常不得影响会话）。 */
    _markActive(session) {
        if (this.onSessionActive === undefined || session == null) return;
        try {
            this.onSessionActive(session);
        } catch { /* 登记失败只影响状态展示 */ }
    }

    /** 注册宿主钩子：工具结果产生即加工。 */
    register() {
        if (!this.enabled) return;
        // P0-4（2026-10-27 系统审计）：实例级注册守卫。
        //
        // 缺陷：register() 没有去重，也不登记 disposer。HMR 重载、或
        // index.js 的旁路服务与 contract.js 接管服务同时构造时，会有两个
        // 实例各自监听同一 session/event。实测两实例并存时：
        //   prune=2 replace=1，第二个实例的 replace 抛错
        // → 留下**一条没有 replace 消费的影子定价**，污染宿主的计量折叠链：
        //   `replace at seq 7 over range 5-5 has no adjacent shadow price`
        // 紧随其后的任何 range 不匹配的 replace（官方 pruner、第 4 层摘要）
        // 都会让宿主抛错。
        if (this._registered) return;
        this._registered = true;
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
                this.stateOf(session).counts.failed += 1;
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
        // 任何事件都说明该会话正在活动：先登记，再按类型过滤
        this._markActive(session);
        if (event?.type !== "tool/result") return;
        if (event.seq === undefined) return;
        // **P0 交叉审计修复（2026-10-27，gpt-6-astra 报、我实跑确认）**：
        // 必须排除「我们自己写回的替换事件」，否则会自我递归到 OOM。
        //
        // 缺陷链条：
        //   1. 宿主 `Session.commit()` 会**同步**调用所有 `session/event` 监听器
        //      （dsh-session lib:1592），且**不 await** 返回的 Promise
        //      （lib:1231 `Promise.resolve(returned).catch(...)`）。
        //   2. 我们处理源 tool/result 时异步落盘，然后 append 一条带
        //      `surfaceOp: replace` 的**新 tool/result**。
        //   3. 那条 append 又同步触发本观察者，新事件 seq 不在 done 里，
        //      于是再次进入 processToolOutput → 再 append → 无限递归。
        //
        // 实测后果：**进程直接 OOM 崩溃**
        // （`FATAL ERROR: Ineffective mark-compacts near heap limit`）。
        // 现有 164 条测试全绿也抓不到——因为 fake session 的 append
        // 不会派发 session/event，桩比现实"更安静"。
        //
        // 三道防线（任一命中即跳过）：
        //   1. 我们自己写回的替换内容带 PRUNE_MARKER
        //   2. 事件带 surfaceOp（只有替换/驱逐产物才有；源事件是 append）
        //   3. 该 seq 已在 done / evicted 里
        const state = this.stateOf(session);
        if (state.done.has(event.seq)) return;

        const eventText = textOfToolResult(event);
        if (eventText !== null && eventText.startsWith(PRUNE_MARKER)) return;
        // W9（beta3 审计）：宿主 `Session.append` 把 surfaceOp 展开在事件**顶层**
        // （dsh-session lib:1517-1534），不在 data 里——旧判据 `data.surfaceOp`
        // 永远 undefined，替换产物会被再加工一次。源事件的标记是字符串 "append"
        // （lib:193 isAppendSurfaceEvent），替换是 { op: "replace", ... } 对象。
        // 只处理 append；undefined 仅出现在未带标记的桩里，按 append 对待。
        if (event.surfaceOp !== undefined && event.surfaceOp !== "append") return;
        if (event.data?.surfaceOp?.op === "replace") return;
        if (state.evicted.has(event.seq)) return;
        // D17 系统审计修复（2026-10-27）：去重标记必须在 **await 之前**占位。
        //
        // 缺陷：旧代码在 `await this.engine.processToolOutput(...)` **之后**才
        // `state.done.add(event.seq)`。这中间有一个真实的竞态窗口：
        // 同一事件被并发派发两次（宿主重放、钩子重复注册、或宿主不 await 钩子），
        // 两次调用都会通过 `done.has()` 检查，于是：
        //   · engine 处理两次（白做一次折叠/落盘，多写一个存档文件）
        //   · 产生两条 surfaceOp: replace 事件（同一位置被替换两次）
        // 实测复现：并发两次 → processToolOutput 被调用 2 次、替换事件 2 条。
        //
        // 修法：进入前先占位（先 add 再 await），失败时再回滚。
        this.done = state.done; // 兼容旧字段访问（见下方 getter 说明）
        state.done.add(event.seq);
        const text = textOfToolResult(event);
        if (text === null) {
            this.stats.skipped += 1;
            state.counts.skipped += 1;
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
            state.done.delete(event.seq);
            throw error;
        }
        if (processed === text || layers.length === 0) {
            // 无收益，占位保留（不必重复尝试同一内容）；只计 skipped，不计 processed
            state.counts.skipped += 1;
            return;
        }
        // 落盘信息从谱系表取回（引擎在落盘层已登记）
        // 传 session.id：spillInfo 的键是 `sessionId#seq`，不传会按后缀兜底匹配
        const spillInfo = this.engine.lastSpillInfo?.(event.seq, session?.id) ?? {};
        try {
            if (this.replace(session, event, processed, spillInfo) === null) {
                // W8：源节点已不在表面（await 期间被替换），不写任何事件；
                // 占位保留——该 seq 已离开表面，再处理也写不回去
                this.stats.skipped += 1;
                state.counts.skipped += 1;
                return;
            }
        } catch (error) {
            // P1-4：写表面失败也必须回滚占位，否则该 seq 永久封禁。
            // （第 2 步真正改表面的操作同样可能失败——例如 await 期间
            //   表面被第 3 层改动，导致 startSeq 已不存在。）
            state.done.delete(event.seq);
            throw error;
        }
        this.stats.replaced += 1;
        this.stats.bytesSaved += Math.max(0, text.length - processed.length);
        state.counts.processed += 1;
        state.counts.bytesSaved += Math.max(0, text.length - processed.length);
        if (layers.includes("spill-to-disk")) state.counts.spilled += 1;
        // P2-6：日志不在 try 内会外抛，导致 stats 已计数但实际未完成。
        try {
            this.ctx.logger.info(
                `tiered-compaction: 工具结果 seq=${event.seq} 已压缩（${layers.join("+")}），` +
                `${text.length} → ${processed.length} 字符`,
            );
        } catch { /* 日志后端异常不得影响业务 */ }
    }

    /** 兼容旧测试/探针的 `observer.done` 访问（返回最近一次会话的集合）。 */
    get done() {
        return this._lastDone ?? new Set();
    }

    set done(value) {
        this._lastDone = value;
    }

    /**
     * 把压缩结果写回会话表面（官方 pruner 同款两步：影子定价 → replace）。
     * @param {object} session
     * @param {object} event 源 `tool/result` 事件
     * @param {string} processed 压缩后的文本
     * @param {{path?: string, sha256?: string, size?: number}} spillInfo
     */
    replace(session, event, processed, spillInfo) {
        // W8（beta3 审计）：prune 前**同步**复核源节点仍在表面上、且仍是同一条事件。
        // handleEvent 在 processToolOutput 的 await 期间，第 3 层驱逐或其它写者
        // 可能已把该 seq 替换掉；此时再写 prune，shadowedSeqs 不再指向当前表面
        // 的精确区间，会话日志冷加载直接失败（format-v3-to-v4 span 校验）。
        // 复核与两次 append 之间没有 await，单线程下不会再被插队。
        if (!isLiveSurfaceNode(session, event)) return null;
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
        const state = this.stateOf(session);
        const surface = session.surface?.nodes ?? [];
        let evicted = 0;
        for (const seq of [...surface]) {
            // W8：遍历的是快照；每个 seq 写 prune 前都要复核它仍在**当前**表面上
            // （同一循环里同步派发的监听者可能已改动表面）
            if (!session.surface?.nodes?.includes(seq)) continue;
            const event = session.eventAt(seq);
            if (event?.type !== "tool/result") continue;
            // 只跳过「已被第 3 层驱逐过」的，不能沿用 `done`。
            //
            // D17 实测真 bug（2026-10-27，用真实模型跑沙箱时暴露）：
            // `done` 是**第 1-2 层的处理标记**——handleEvent 处理完就把 seq
            // 加进去。而驱逐这里也用它做去重，于是：
            //   凡是第 1-2 层碰过的工具结果，第 3 层永远轮不到。
            //
            // 两者语义不同：`done` = 已做过内容压缩；`evicted` = 已换成重跑提示。
            if (state.evicted.has(seq)) continue;
            const text = textOfToolResult(event);
            if (text === null) continue;
            // P0-2（2026-10-27 系统审计）：必须用**内容判据**兜住重复驱逐。
            //
            // 缺陷：旧实现记的是**驱逐前**的 seq，但 replace 之后表面上的节点
            // 已经是**新 seq**。下一轮遍历拿到新 seq，不在 evicted 里 → 再驱逐一次。
            // 实测 6 轮：每轮 evicted=1，事件数 4→6→8…→14 无限增长。
            // 而 contract.js 在**每次 pre-step** 都调用本方法，压力不降就是
            // 每步追加 2 条事件（1 prune + 1 replace），会话日志无限膨胀。
            //
            // 内容判据是最终防线：已经是驱逐提示的节点，无论 seq 怎么变都跳过。
            if (text.includes("已驱逐：")) {
                state.evicted.add(seq);
                continue;
            }
            // P1-2：失败结果不得驱逐。它是排障的唯一线索，
            // 抹掉后模型只会盲目重跑同一命令（必然再次失败）。
            if (event.data?.message?.isError === true) continue;
            const name = this.toolNameOf(session, event);
            // 只驱逐可重放类（read/grep/glob）：重跑即恢复，属设计稿 §3 优先级 2
            if (name !== "read" && name !== "grep" && name !== "glob") continue;
            // P2-2：净收益判据。驱逐提示本身有长度成本，
            // 把 2 字符的 "ok" 换成 58 字符提示是越驱越大。
            const notice = `[已驱逐：${name} 的结果可随时重跑恢复]`;
            if (Buffer.byteLength(notice, "utf8") >= Buffer.byteLength(text, "utf8")) continue;
            // P1-1：保留第 1-2 层写入的存档路径——那是模型回读原文的唯一线索
            const keptPath = /存档：([^\n]+)/.exec(text)?.[1];
            session.append("compaction/prune", {
                shadowedRange: { start: seq, end: seq },
                shadowedSeqs: [seq],
                shadowedTokenCount: this.estimateTokens(event),
            });
            const replacement = session.append("tool/result", {
                ...event.data,
                message: {
                    ...event.data.message,
                    content: prunedContent(
                        keptPath === undefined
                            ? `[已驱逐：${name} 的结果可随时重跑恢复]`
                            : `[已驱逐：${name} 的结果可随时重跑恢复]\n原存档仍在：${keptPath}`,
                        {},
                    ),
                },
            }, {
                surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
                sourceEventSeqs: [seq],
            });
            // 同时记新 seq（防止下一轮把替换产物当新节点再驱逐一次）
            if (replacement?.seq !== undefined) state.evicted.add(replacement.seq);
            state.evicted.add(seq);
            // P1-3：谱系按契约逐节点登记；S2（beta3）：键带会话维度
            // （`<sessionId>#node#<seq>`，无会话 id 时退回 `node#<seq>`）
            this.engine.lineage.record(
                nodeLocation(seq, session?.id),
                keptPath ?? "-（已驱逐，靠重跑恢复）",
                "soft-pressure",
            );
            evicted += 1;
            state.counts.evicted += 1;
        }
        if (evicted > 0) {
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
