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

function zeroCounts() {
    return { processed: 0, bytesSaved: 0, skipped: 0, failed: 0, evicted: 0, spilled: 0 };
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
        entry = { ref: new WeakRef(session), counts: zeroCounts() };
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
    return entry !== undefined && entry.ref.deref() === session ? { ...entry.counts } : zeroCounts();
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
export function recordCompaction(record) {
    const t = table();
    t.lastCompaction = record;
    t.summaryCount += 1;
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
