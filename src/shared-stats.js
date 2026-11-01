/**
 * 进程级共享统计表（beta3 审计 · 多 realm 结构修复）。
 *
 * 为什么是模块级而不是实例字段：同一进程里本插件可能有多份实例
 * （root 一份 + 每个 preset realm 一份），而工具结果观察者全局只有一份、
 * 状态路由全进程也只注册一份。第 1-3 层计数产生在观察者里，第 4 层摘要
 * 产生在会话所属 realm 的实例里，读数的却是路由持有者——这些数只能放在
 * 实例之外，按 sessionId 汇总。
 *
 * - 用 `Symbol.for` 挂在 globalThis：抗同一文件被多副本加载（与单写者守卫同理）。
 * - 会话表有界（超过 MAX_TRACKED_SESSIONS 淘汰最久未触碰的条目），且只持
 *   WeakRef，不让已关闭的会话常驻内存。
 * - 同一 id 换了会话对象（重开 / 测试复用 id）时条目整体重置，旧计数不串到新会话。
 */

const SHARED_KEY = Symbol.for("dsh-tiered-compaction.shared-stats");

/** 会话表上限：超出时淘汰最久未触碰的会话条目。 */
export const MAX_TRACKED_SESSIONS = 256;

/**
 * 每会话计数。beta4 口径：
 * - bytesSaved：第 1-2 层合计节省的**字符数**（旧字段，保留兼容）；
 * - foldBytesSaved / spillBytesSaved：按层拆开、按 UTF-8 **字节**计；
 * - l12TokensSaved / evictTokensSaved：按观察者 estimateTokens 估算的 token 差；
 * - summaries / summaryTokensSaved：本会话已提交的第 4 层摘要次数与其遮蔽 token；
 * - firstSeenAt：本会话在本进程里第一次被看到的时刻（界面「自 HH:mm 起」）。
 */
function zeroCounts() {
    return {
        processed: 0, bytesSaved: 0, skipped: 0, failed: 0, evicted: 0, spilled: 0,
        folded: 0, foldBytesSaved: 0, spillBytesSaved: 0,
        l12TokensSaved: 0, evictTokensSaved: 0,
        summaries: 0, summaryTokensSaved: 0,
        firstSeenAt: Date.now(),
    };
}

function freshTable() {
    return {
        /** @type {Map<string, {ref: WeakRef<object>, counts: object}>} */
        sessions: new Map(),
        /** 全进程唯一的工具结果观察者（持 observer 席位的实例登记） */
        observer: null,
        /** @type {WeakRef<object>|null} */
        latest: null,
        lastCompaction: null,
        summaryCount: 0,
        startedAt: Date.now(),
    };
}

function table() {
    let t = globalThis[SHARED_KEY];
    if (!t || typeof t !== "object") {
        t = freshTable();
        globalThis[SHARED_KEY] = t;
    }
    return t;
}

/**
 * 登记全局唯一观察者（持 observer 席位的实例调用）。
 * @param {object} observer
 * @returns {() => void} 注销器：只注销自己，不误删后来者
 */
export function setActiveObserver(observer) {
    table().observer = observer;
    return () => {
        const t = globalThis[SHARED_KEY];
        if (t && t.observer === observer) t.observer = null;
    };
}

/** @returns {object|null} 当前进程的观察者；未装配或已卸载时为 null */
export function activeObserver() {
    return table().observer ?? null;
}

/**
 * 取（必要时建）会话条目，并把它移到「最近触碰」端。
 * @returns {object|undefined} 无字符串 id 的会话不入表
 */
function entryFor(session) {
    const id = session?.id;
    if (typeof id !== "string" || id.length === 0) return undefined;
    const t = table();
    let entry = t.sessions.get(id);
    if (entry === undefined || entry.ref.deref() !== session) {
        entry = { ref: new WeakRef(session), counts: seedCountsFromLog(session) };
    }
    // 重新插入 = 移到 Map 尾部；淘汰从头部删
    t.sessions.delete(id);
    t.sessions.set(id, entry);
    while (t.sessions.size > MAX_TRACKED_SESSIONS) {
        t.sessions.delete(t.sessions.keys().next().value);
    }
    return entry;
}

/**
 * 某会话第 1-3 层计数的**可写**对象（观察者直接在上面累加）。
 * 无 id 的会话（单测桩）拿到一份不入表的独立对象。
 * @param {object} session
 * @returns {{processed: number, bytesSaved: number, skipped: number, failed: number, evicted: number, spilled: number}}
 */
export function layerCountsFor(session) {
    return entryFor(session)?.counts ?? zeroCounts();
}

/**
 * 某会话第 1-3 层计数的只读快照（不建条目）；未见过的会话为全零。
 * 状态载荷走这里：任何实例（包括不持观察者的 realm 实例）读到的都是同一份数。
 * @param {object} session
 */
export function layerStatsSnapshot(session) {
    const id = session?.id;
    const entry = typeof id === "string" ? table().sessions.get(id) : undefined;
    if (entry !== undefined && entry.ref.deref() === session) return { ...entry.counts };
    // beta8：本进程还没登记的会话（重启后首次查询）按日志回填，不留条目；否则健康检查会误报零驱逐
    return session !== null && typeof session === "object" && typeof session.eventAt === "function" ? seedCountsFromLog(session) : zeroCounts();
}

/**
 * 登记会话为最近活跃（观察者回调与压缩路径共用）。
 * @param {object} session
 */
export function touchSession(session) {
    if (session === undefined || session === null) return;
    table().latest = new WeakRef(session);
    entryFor(session);
}

/** @returns {object|null} 全进程最近活跃的会话 */
export function latestSession() {
    return table().latest?.deref() ?? null;
}

/**
 * 按 id 取见过的会话；弱引用失效时顺手清掉条目。
 * @param {string} id
 * @returns {object|undefined}
 */
export function sessionById(id) {
    const t = table();
    const entry = t.sessions.get(id);
    const session = entry?.ref.deref();
    if (entry !== undefined && session === undefined) t.sessions.delete(id);
    if (session !== undefined) return session;
    const latest = t.latest?.deref();
    return latest?.id === id ? latest : undefined;
}

/**
 * 记账一次已提交的第 4 层摘要事务。
 * 口径与旧实例字段一致：l4Summaries 是「本次运行」全进程的摘要次数。
 * @param {object} record lastCompaction 形状
 */
export function recordCompaction(record, session) {
    const t = table();
    t.lastCompaction = record;
    t.summaryCount += 1;
    // beta4：同时记到会话条目，界面「本会话摘要次数 / 摘要节省」按会话口径显示
    const entry = session === undefined ? undefined : entryFor(session);
    if (entry !== undefined) {
        entry.counts.summaries += 1;
        entry.counts.summaryTokensSaved += Math.max(0, Number(record?.shadowedTokenCount) || 0);
        entry.lastCompaction = record;
    }
}

/**
 * 记下自动压缩检查（pre-step / overflow）进入了本会话。
 * @param {object} session
 * @param {string} trigger
 */
export function markAutoCheck(session, trigger) {
    if (trigger !== "pressure" && trigger !== "context-overflow") return;
    const entry = entryFor(session);
    if (entry !== undefined) entry.autoCheck = { at: Date.now(), trigger };
}

/**
 * 记下会话所属 agent 的运行状态（宿主 agent/status 事件：running / idle）。
 * 界面靠它区分「会话空闲，下条消息才检查」和「运行中却没检查」。
 * @param {object} session
 * @param {string} status
 */
export function markAgentStatus(session, status) {
    if (status !== "running" && status !== "idle") return;
    const entry = entryFor(session);
    if (entry !== undefined) entry.agentStatus = status;
}

/**
 * 记下第 4 层摘要开始（传时间戳）或结束（传 null）。
 * @param {object} session
 * @param {number|null} at
 */
export function markSummarizing(session, at) {
    const entry = entryFor(session);
    if (entry !== undefined) entry.summarizingSince = at;
}

/**
 * @param {object} session
 * @returns {number|null} 摘要开始时刻；没在摘要时为 null
 */
export function summarizingSinceOf(session) {
    const id = session?.id;
    const entry = typeof id === "string" ? table().sessions.get(id) : undefined;
    return entry !== undefined && entry.ref.deref() === session ? entry.summarizingSince ?? null : null;
}

/**
 * @param {object} session
 * @returns {"running"|"idle"|null} 未见过状态事件时为 null
 */
export function agentStatusOf(session) {
    const id = session?.id;
    const entry = typeof id === "string" ? table().sessions.get(id) : undefined;
    return entry !== undefined && entry.ref.deref() === session ? entry.agentStatus ?? null : null;
}

/**
 * @param {object} session
 * @returns {{at: number, trigger: string}|null}
 */
export function autoCheckOf(session) {
    const id = session?.id;
    const entry = typeof id === "string" ? table().sessions.get(id) : undefined;
    return entry !== undefined && entry.ref.deref() === session ? entry.autoCheck ?? null : null;
}

/**
 * 某会话最近一次已提交的摘要（beta4：界面按会话显示，不再串到别的会话）。
 * @param {object} session
 * @returns {object|null}
 */
export function lastCompactionFor(session) {
    const id = session?.id;
    const entry = typeof id === "string" ? table().sessions.get(id) : undefined;
    return entry !== undefined && entry.ref.deref() === session ? entry.lastCompaction ?? null : null;
}

/** @returns {number} 全进程本次运行的第 4 层摘要总数 */
export function summaryCount() {
    return table().summaryCount;
}

/** @returns {object|null} 全进程最近一次压缩 */
export function lastCompaction() {
    return table().lastCompaction;
}

/** @returns {number} 共享表建立时刻（「本次运行」口径的 since） */
export function startedAt() {
    return table().startedAt;
}

/** 仅测试用：清空共享表（每个用例从零开始）。 */
export function __resetSharedStatsForTests() {
    globalThis[SHARED_KEY] = freshTable();
}

/**
 * beta8：从会话日志回填累计计数，重启后不再从 0 开始。
 *
 * 每次第 1-3 层动作都会写一对 `compaction/prune` + 替换用 `tool/result`，
 * 第 4 层写 `compaction/summary`；日志随会话持久化，所以按日志统计就是
 * 「本会话至今」的累计值，不需要另存文件。替换内容的文字决定归哪一层：
 *   - 「[已驱逐：」→ 第 3 层驱逐
 *   - 其余本插件标记 → 第 1-2 层（折叠与落盘文本相同，只计合计）
 * 只认本插件写的标记，官方 pruner 写的 prune 不计入。读失败时返回全零。
 * @param {object} session
 */
export function seedCountsFromLog(session) {
    const counts = zeroCounts();
    try {
        const end = typeof session?.seq === "number" ? session.seq : 0;
        if (typeof session?.eventAt !== "function" || end <= 0) return counts;
        for (let seq = 0; seq < end; seq++) {
            const event = session.eventAt(seq);
            if (event === undefined) continue;
            if (event.type === "compaction/summary") {
                counts.summaries += 1;
                counts.summaryTokensSaved += Math.max(0, Number(event.data?.shadowedTokenCount) || 0);
                continue;
            }
            if (event.type !== "compaction/prune") continue;
            const replacement = session.eventAt(seq + 1);
            if (replacement?.type !== "tool/result") continue;
            const text = (replacement.data?.message?.content ?? [])
                .map((block) => (typeof block?.text === "string" ? block.text : ""))
                .join("");
            if (!text.includes("[tiered-compaction") && !text.includes("[已驱逐：")) continue;
            const before = Math.max(0, Number(event.data?.shadowedTokenCount) || 0);
            const saved = Math.max(0, before - Math.ceil(text.length / 4));
            if (text.includes("[已驱逐：")) {
                counts.evicted += 1;
                counts.evictTokensSaved += saved;
            } else {
                counts.processed += 1;
                counts.l12TokensSaved += saved;
                // 折叠与落盘的替换文本相同（都带存档路径），日志里分不出层，只记合计
            }
        }
    } catch {
        return zeroCounts();
    }
    counts.seededFromLog = true;
    return counts;
}