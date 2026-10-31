/**
 * D24 单写者守卫（single-writer guard），beta3 审计改为「两类席位」。
 *
 * 为什么必须存在（病案 2026-10-29，勿删）：
 * 插件可能被同时装配在多处（bundle 静态清单、根平面 patch、多个 preset 的
 * compaction 组……）。历史上「root 平面实例 + preset realm 实例」各自挂一份
 * 工具结果观察者，对同一批工具结果各发一枚 compaction/prune——第二枚落盘时
 * 目标已被换出 surface，宿主冷重放校验必抛 SessionFormatError，会话从此打不开
 * （签名：`compaction/prune shadowedSeqs do not name an exact current surface span`）。
 *
 * 席位语法（v4，按职责拆分）：
 * - `observer`：进程唯一。持有者才挂第 1-3 层工具结果观察者。root 实例
 *   （无 scopeId）一般最先 apply；没有 root 时由第一个 apply 的实例持有。
 * - `compaction:<scope>`：同一 scope 唯一，不同 scope 并存。root 记作
 *   `compaction:root`，preset realm 记作 `compaction:<scopeId>`。每个 realm 的
 *   第 4 层只处理归属本 realm 的会话（contract.js 的 realm 判定），所以不同
 *   scope 并存不会双写；同 scope 重复 apply 才是双写，必须拒绝。
 * - 后来者拿不到席位时降级（观察者不挂 / 实例退为自检服务）并打日志——
 *   宁可少压一轮，不可坏一份归档。
 * - Symbol.for 全局座位表：抗多副本加载（旧 tarball + link 目录并存也一样）。
 * - 逃生阀：环境变量 DSH_TC_ALLOW_MULTI_ENGINE=1 绕过守卫（仅调试病理用）。
 */

/** 全局座位表键（跨模块副本共享）。值为 null-map：seat -> token。 */
const WRITER_SEATS = Symbol.for("dsh-tiered-compaction.single-writer.seats");

/** 逃生阀环境变量名。 */
export const MULTI_ENGINE_ESCAPE_ENV = "DSH_TC_ALLOW_MULTI_ENGINE";

/** 观察者席位名（进程唯一）。 */
export const OBSERVER_SEAT = "observer";

/**
 * 压缩席位名：`compaction:<scope>`，无 scopeId 记作 `compaction:root`。
 * @param {string} [scopeId]
 * @returns {string}
 */
export function compactionSeat(scopeId) {
    return `compaction:${typeof scopeId === "string" && scopeId.length > 0 ? scopeId : "root"}`;
}

function seatsMap() {
    let m = globalThis[WRITER_SEATS];
    if (!m || typeof m !== "object") {
        m = { __proto__: null };
        globalThis[WRITER_SEATS] = m;
    }
    return m;
}

/**
 * 申请一个席位。
 * @param {string} kind 申请者类型（contract / bypass，仅用于日志）
 * @param {{scope: string, logger?: {info: Function, warn: Function}}} hooks
 *   scope 为席位名：`observer` 或 `compaction:<scope>`
 * @returns {object|null} 席位 token；已被占用时返回 null
 */
export function acquireSingleWriter(kind, hooks = {}) {
    const logger = (hooks && hooks.logger) || { info() {}, warn() {} };
    const scope = hooks && typeof hooks.scope === "string" && hooks.scope.length > 0 ? hooks.scope : undefined;
    if (scope === undefined) throw new TypeError("acquireSingleWriter 需要显式席位名（observer 或 compaction:<scope>）");

    if (process.env[MULTI_ENGINE_ESCAPE_ENV] === "1") {
        logger.warn(
            `dsh-tiered-compaction：检测到 ${MULTI_ENGINE_ESCAPE_ENV}=1，单写者守卫已绕过` +
            `（多引擎并存，可能出现重复 prune，仅供调试）`
        );
        return { kind, scope, escaped: true, acquiredAt: Date.now() };
    }

    const m = seatsMap();
    const seated = m[scope];
    if (seated && typeof seated === "object" && !seated.released) {
        logger.warn(
            `dsh-tiered-compaction：单写者守卫生效——席位 ${scope} 已有持有者` +
            `（kind=${seated.kind}，acquiredAt=${new Date(seated.acquiredAt).toISOString()}），` +
            `本实例（kind=${kind}）不再占用该席位。`
        );
        return null;
    }

    const token = { kind, scope, escaped: false, acquiredAt: Date.now() };
    m[scope] = token;
    logger.info(`dsh-tiered-compaction：单写者守卫已记账（seat=${scope}，kind=${kind}）`);
    return token;
}

/**
 * 归还席位。只有持票者本人能还（陌生/过期 token 返回 false）。
 * @param {object|null} token
 * @returns {boolean}
 */
export function releaseSingleWriter(token) {
    if (!token || token.escaped) return false;
    const m = globalThis[WRITER_SEATS];
    if (!m || m[token.scope] !== token) return false;
    token.released = true;
    delete m[token.scope];
    return true;
}

/**
 * 只读快照（测试与诊断用）。
 * @returns {{taken: boolean, observerTaken: boolean, scopes: Array<{scope: string, kind: string, acquiredAt: number}>}}
 */
export function inspectSingleWriter() {
    const m = globalThis[WRITER_SEATS];
    if (!m) return { taken: false, observerTaken: false, scopes: [] };
    const scopes = Object.keys(m).map((k) => ({
        scope: k,
        kind: m[k].kind,
        acquiredAt: m[k].acquiredAt,
    }));
    return {
        taken: scopes.length > 0,
        observerTaken: scopes.some((s) => s.scope === OBSERVER_SEAT),
        scopes,
    };
}

/**
 * 仅测试用：清空座位表。单测直接 `apply(new Context(), ...)`，root fiber 永不
 * 卸载，ctx.effect 托管的席位不会归还——用例之间靠它复位（替代旧 detach()）。
 */
export function __resetSingleWriterForTests() {
    delete globalThis[WRITER_SEATS];
}
