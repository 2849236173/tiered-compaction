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
 * 注册状态路由。
 *
 * @param {object} deps
 * @param {object} deps.ctx 服务上下文（用 ctx.get 探针取 webServer，见头部说明）
 * @param {() => object} deps.buildPayload 状态载荷工厂（由 contract 提供，
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
                    sendJson(res, 200, buildPayload());
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
