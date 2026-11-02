/**
 * 只读状态路由（方案《方案-UI显示.md》任务 #1）。
 *
 * 给 client 半（设置分区/侧栏/悬浮三个入口）提供一个同源取数点：
 * GET /api/tiered-compaction/status → 压力/分层计数/最近一次压缩/启动时刻。
 *
 * 设计边界（方案 §八定案）：
 *   1. 只读：不提供任何改变行为的参数，响应 no-store，非 GET 一律 405。
 *   2. 探针式获取 webServer（照 tiered_restore 对 tools 的同一模式）：
 *      static inject 是硬依赖，headless/测试环境没有 webServer 会让
 *      服务构造失败、四层压缩陪葬——一条只读路由不配这个代价。
 *   3. 任何失败都降级成日志 + 跳过，绝不阻断主功能（与 restore 工具同规）。
 */

/** 路由固定路径：client 半的三个入口与 #9 反向验证都按它取数。 */
export const STATUS_ROUTE_PATH = "/api/tiered-compaction/status";

/** 非 GET 请求的响应码：只读端点不提供其它方法。 */
const METHOD_NOT_ALLOWED = 405;

/**
 * 写出一个 JSON 响应。
 *
 * 为什么必须 no-store：状态读数不允许被浏览器缓存，否则「三入口同一秒
 * 数字一致」的验收会被缓存击穿（不同入口读到不同时刻的旧值）。
 */
function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(payload));
}

/**
 * 从请求 URL 取 `session` 查询参数；没有或为空返回 undefined。
 * @param {{url?: string}} req
 * @returns {string|undefined}
 */
export function sessionIdOf(req) {
    if (typeof req?.url !== "string") return undefined;
    let value;
    try {
        value = new URL(req.url, "http://x").searchParams.get("session");
    } catch {
        return undefined;
    }
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 注册状态路由。
 *
 * @param {object} deps
 * @param {object} deps.ctx 服务上下文（用 ctx.get 探针取 webServer，见头部说明）
 * @param {(sessionId?: string) => object} deps.buildPayload 状态载荷工厂（由 contract 提供，
 *   本模块不感知数据来源，只负责协议：方法校验、编码、降级）
 * @returns {() => void} 注销器；未注册或注册失败时返回空函数，调用方无需分支
 */
export function registerStatusRoute({ ctx, buildPayload }) {
    // 只用 ctx.get：直接访问 ctx.webServer 会因未声明 inject 被 cordis 抛错
    // （D22 教训），探针式访问拿不到就返回 undefined，安全。
    const webServer = ctx?.get?.("webServer");
    if (typeof webServer?.register !== "function") {
        ctx?.logger?.info("dsh-tiered-compaction: 无 webServer 服务，跳过 status 路由（不影响四层压缩）");
        return () => {};
    }

    try {
        const disposer = webServer.register({
            kind: "exact",
            path: STATUS_ROUTE_PATH,
            handler: (req, res) => {
                // 卫语句：只读端点，非 GET 直接拒绝（无任何副作用可触发）
                if (req?.method !== "GET") {
                    sendJson(res, METHOD_NOT_ALLOWED, { error: "method not allowed: status endpoint is GET-only" });
                    return;
                }
                try {
                    // `?session=<id>`：client 按当前主视图会话取数；缺省时由
                    // buildPayload 退回最近活跃会话。exact 路由按 pathname 匹配，
                    // query 原样留在 req.url 里。
                    sendJson(res, 200, buildPayload(sessionIdOf(req)));
                } catch (error) {
                    // 载荷拼装失败也必须给 client 一个可渲染的降级信号
                    //（#9 反向验证就靠这个 error 字段触发「数据不可用」态）
                    sendJson(res, 500, { error: String(error?.message ?? error) });
                }
            },
        });
        ctx.logger.info(`dsh-tiered-compaction: status 只读路由已注册（GET ${STATUS_ROUTE_PATH}）`);
        return typeof disposer === "function" ? disposer : () => {};
    } catch (error) {
        // 注册失败只降级不阻断：状态 UI 缺席时四层压缩照常工作
        ctx?.logger?.warn(
            `dsh-tiered-compaction: status 路由注册失败（${error?.message ?? error}），四层压缩照常`,
        );
        return () => {};
    }
}

/**
 * 进程级路由席位表（beta3 W3/W4）：`Symbol.for` 挂 globalThis，抗模块多副本。
 * candidates 按 apply 先后排队；只有队首（active）真正挂路由。
 */
const ROUTE_SEAT = Symbol.for("dsh-tiered-compaction.status-route.seat");

function routeSeat() {
    let seat = globalThis[ROUTE_SEAT];
    if (!seat || typeof seat !== "object" || !Array.isArray(seat.candidates)) {
        seat = { candidates: [], active: null };
        globalThis[ROUTE_SEAT] = seat;
    }
    return seat;
}

function promote(seat) {
    while (seat.active === null && seat.candidates.length > 0) {
        const next = seat.candidates[0];
        seat.active = next;
        try {
            next.start();
        } catch {
            // 候选的 fiber 已在卸载途中（inject 抛 inactive）：跳过它，试下一个
            seat.active = null;
            seat.candidates.shift();
        }
    }
}

/**
 * 挂状态路由：全进程恰好一条（W3/W4）。
 *
 * - 多个实例都调用时只有第一个真正挂；它卸载后由下一个候选补位，
 *   所以「root + 若干 preset realm」任意卸载顺序下都始终恰好一条。
 * - 注册包在 `ctx.effect` 里：fiber 回收时自动注销路由并让出席位。
 * - webServer 晚到（root apply 时尚未 provide，宿主日志实测）：用
 *   `ctx.inject(["webServer"], ...)` 声明式等待，webServer 出现才挂、
 *   消失即随之注销、再出现再挂。
 * - ctx 不是 cordis Context（无 effect / inject，单测桩）时退回一次性
 *   registerStatusRoute。
 *
 * @param {{ctx: object, buildPayload: (sessionId?: string) => object}} deps
 */
export function mountStatusRoute({ ctx, buildPayload }) {
    if (typeof ctx?.effect !== "function" || typeof ctx?.inject !== "function") {
        registerStatusRoute({ ctx, buildPayload });
        return;
    }
    ctx.effect(() => {
        const seat = routeSeat();
        const candidate = {
            fiber: null,
            start() {
                this.fiber = ctx.inject(["webServer"], (webCtx) => {
                    webCtx.effect(
                        () => registerStatusRoute({ ctx: webCtx, buildPayload }),
                        "tiered-compaction status route",
                    );
                });
            },
        };
        seat.candidates.push(candidate);
        promote(seat);
        return () => {
            const current = globalThis[ROUTE_SEAT];
            if (!current) return;
            current.candidates = current.candidates.filter((c) => c !== candidate);
            if (current.active === candidate) {
                current.active = null;
                const fiber = candidate.fiber;
                candidate.fiber = null;
                // 先等本候选的路由注销完再补位：同一 exact 路径不能有两条并存
                const disposing = Promise.resolve(fiber?.dispose?.()).catch(() => {});
                return disposing.then(() => promote(current));
            }
        };
    }, "tiered-compaction status route seat");
}

/** 仅测试用：清空路由席位表（理由同 __resetSingleWriterForTests）。 */
export function __resetStatusRouteForTests() {
    delete globalThis[ROUTE_SEAT];
}
