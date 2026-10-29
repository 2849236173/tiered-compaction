/**
 * D24 单写者守卫（single-writer guard）：全进程范围内，「会写归档 / 会产
 * prune 事件」的实例集合必须保持单一族群——要么恰有一个全局写者，
 * 要么只有若干 realm 写者（彼此按会话归属天然隔离），绝不混居。
 *
 * 为什么必须存在（病案 2026-10-29，勿删）：
 * 插件可能被同时装配在多处（bundle 静态清单、根平面 patch、多个 preset 的
 * compaction 组……）。历史上「root 平面实例 + preset realm 实例」同时观察
 * 同一条会话事件流，各自对同一批工具结果发 compaction/prune——第二枚 prune
 * 落盘时目标已被换出 surface，宿主冷重放校验必抛 SessionFormatError，
 * 会话从此打不开（签名：`compaction/prune shadowedSeqs do not name an
 * exact current surface span`）。远程用户从 GitHub / npm 安装本插件时，
 * 挂载组合五花八门，唯有进程内强制收敛才能普遍免疫。
 *
 * 席位语法（v3，混合互斥）：
 * - class "global"：进程唯一。只要有任何 realm 席位在场，global 申请被拒；
 *   反之 global 在场时，一切 realm 申请被拒。
 * - class "realm:<scopeId>"：同 scopeId 唯一；不同 scopeId 可并存。
 * - 结论：任意挂载组合最终收敛到「一个 global」或「若干 realm」其中一种
 *   形态，杜绝 root+realm 混写。
 * - 申请先后不影响安全性：无论谁先入座，后来者只要构成混居/重复即被降级
 *   为「不写盘的自检服务」并打日志——宁可少压一轮，不可坏一份归档。
 * - Symbol.for 全局座位表：抗多副本加载（旧 tarball + link 目录并存也一样）。
 * - 逃生阀：环境变量 DSH_TC_ALLOW_MULTI_ENGINE=1 绕过守卫（仅调试病理用）。
 */

/** 全局座位表键（跨模块副本共享）。值为 null-map：scope -> token。 */
const WRITER_SEATS = Symbol.for("dsh-tiered-compaction.single-writer.seats");

/** 逃生阀环境变量名。 */
export const MULTI_ENGINE_ESCAPE_ENV = "DSH_TC_ALLOW_MULTI_ENGINE";

function seatsMap() {
    let m = globalThis[WRITER_SEATS];
    if (!m || typeof m !== "object") {
        m = { __proto__: null };
        globalThis[WRITER_SEATS] = m;
    }
    return m;
}

function normalizeScope(hooks) {
    const s = hooks && typeof hooks.scope === "string" ? hooks.scope : "";
    return s.length > 0 ? s : "global";
}

/** scope 是否属于 realm 族（非 global）。 */
function isRealmClass(scope) {
    return scope !== "global";
}

/** 族群普查：全局与各 realm 席位的占用情况。 */
function census() {
    const m = seatsMap();
    let globalTaken = false;
    const realmScopes = [];
    for (const k of Object.keys(m)) {
        if (isRealmClass(k)) realmScopes.push(k);
        else globalTaken = true;
    }
    return { globalTaken, realmScopes };
}

/**
 * 申请「写者席位」。
 * @param {string} kind 申请者形态（仅用于诊断日志："contract" | "bypass"）
 * @param {{logger?: {info(msg: string): void, warn(msg: string): void},
 *          scope?: string}} [hooks]
 *   scope：缺省 "global"；preset 组挂载传 `realm:<id>`（如 "realm:standard"）。
 * @returns {object|null} 拿到席位返回 token（交给 releaseSingleWriter 归还）；
 *   被拒返回 null（申请方必须降级为不写盘的自检服务）。
 */
export function acquireSingleWriter(kind, hooks = {}) {
    const logger = (hooks && hooks.logger) || { info() {}, warn() {} };
    const scope = normalizeScope(hooks);

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
            `dsh-tiered-compaction：单写者守卫生效——scope=${scope} 已有写者` +
            `（kind=${seated.kind}，acquiredAt=${new Date(seated.acquiredAt).toISOString()}），` +
            `本实例（kind=${kind}）降级为不写盘的自检服务。` +
            `通常意味着同一插件被重复装配；请收敛挂载点。`
        );
        return null;
    }

    // 族群互斥：global 与 realm 不得混居（防止 root 平面 + preset 双观察同一条流）。
    const pop = census();
    if (isRealmClass(scope) && pop.globalTaken) {
        logger.warn(
            `dsh-tiered-compaction：单写者守卫生效——进程已有全局写者（root 平面挂载），` +
            `它已覆盖所有会话流；本 realm 实例（scope=${scope}）与之并存会造成双写，` +
            `现降级为不写盘的自检服务。请二选一：去掉 root 平面挂载，或不要在 preset 内再挂。`
        );
        return null;
    }
    if (!isRealmClass(scope) && pop.realmScopes.length > 0) {
        logger.warn(
            `dsh-tiered-compaction：单写者守卫生效——进程已有 preset 写者` +
            `（${pop.realmScopes.join(", ")}），再启用全局写者会对同一些会话形成双写，` +
            `本全局实例降级为不写盘的自检服务。请二选一挂载。`
        );
        return null;
    }

    const token = { kind, scope, escaped: false, acquiredAt: Date.now() };
    m[scope] = token;
    logger.info(
        `dsh-tiered-compaction：单写者守卫已记账（scope=${scope}，kind=${kind}）`
    );
    return token;
}

/**
 * 归还席位（Service 停止时调用；只有持票者本人能还）。
 * @param {object|null} token acquireSingleWriter 返回的 token
 * @returns {boolean} 是否真的释放了
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
 * 侦查当前席位状态（供健康检查 / status-route / 排障展示，不改状态）。
 * @returns {{taken: boolean, globalTaken: boolean,
 *            scopes: Array<{scope: string, kind: string, acquiredAt: number}>}}
 */
export function inspectSingleWriter() {
    const m = globalThis[WRITER_SEATS];
    if (!m) return { taken: false, globalTaken: false, scopes: [] };
    const scopes = Object.keys(m).map((k) => ({
        scope: k,
        kind: m[k].kind,
        acquiredAt: m[k].acquiredAt,
    }));
    return {
        taken: scopes.length > 0,
        globalTaken: scopes.some((s) => s.scope === "global"),
        scopes,
    };
}
