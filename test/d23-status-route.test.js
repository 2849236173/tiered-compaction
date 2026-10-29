/**
 * 任务 #1 验收：/api/tiered-compaction/status 只读路由（方案 §六）。
 *
 * 覆盖五件事：
 *   1. 路由以 exact kind 注册在约定路径，GET 返回方案规定的字段形状；
 *   2. 非 GET 请求被 405 拒绝（只读边界）；
 *   3. 真实事务提交后 lastCompaction 被单点记账（compactNow 路径实测）；
 *   4. 无 webServer 时优雅跳过，主功能（四层压缩）不受影响；
 *   5. 载荷工厂抛错时降级成 500 + error，供 #9 反向验证触发「数据不可用」。
 *
 * 运行：node --test test/d23-status-route.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";

import { apply } from "../src/index.js";
import { registerStatusRoute, STATUS_ROUTE_PATH } from "../src/status-route.js";

/** 收集响应的 res 桩（状态码/头/体都可断言）。 */
function mockRes() {
    return {
        statusCode: 0,
        headers: {},
        body: "",
        setHeader(key, value) { this.headers[key] = value; },
        end(body) { this.body = body ?? ""; },
    };
}

/** webServer 服务桩：捕获 register 调用，允许按路径取回 handler。 */
class WebServerStub extends Service {
    constructor(ctx) {
        super(ctx, "webServer");
        this.specs = [];
    }
    register(spec) {
        this.specs.push(spec);
        return () => {};
    }
    handlerFor(path) {
        return this.specs.find((spec) => spec.path === path)?.handler;
    }
}

/** 宿主形状的最小 session 桩（a12 同款：surface + eventAt + append 可断言）。 */
function stubSession(nodes) {
    const events = [];
    let seq = 0;
    const surface = nodes.map((n) => (n.seq = ++seq, n.seq));
    const store = new Map(nodes.map((n) => [n.seq, { seq: n.seq, type: n.type, data: n.data }]));
    return {
        surface: { get nodes() { return surface; } },
        eventAt: (s) => store.get(s),
        requestHeader: () => ({ config: { provider: "test", model: "test" } }),
        append: (type, data, opts) => {
            const ev = { seq: ++seq + 1000, type, data, opts };
            events.push(ev);
            if (type === "user/message" && opts?.surfaceOp?.op === "replace") {
                const { startSeq, endSeq } = opts.surfaceOp;
                const idxStart = surface.indexOf(startSeq);
                const idxEnd = surface.indexOf(endSeq);
                if (idxStart === -1 || idxEnd === -1) throw new Error("replace 区间不在表面");
                surface.splice(idxStart, idxEnd - idxStart + 1, ev.seq);
                store.set(ev.seq, { seq: ev.seq, type, data });
            }
            return ev;
        },
        events,
    };
}

/** 宿主形状的最小 agent 桩（a12 同款：runMaintenance 直通执行）。 */
function stubAgent(session) {
    return {
        session,
        runMaintenance: async (fn) => fn(new AbortController().signal),
    };
}

/**
 * 组装一个装好契约层 + webServer 桩的 ctx（enabled=true，测试摘要桩）。
 * withWebServer=false 用于验证「无 webServer 时优雅跳过」。
 */
async function setup(t, { withWebServer = true, window = 128000, perNode = 2000, summary } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "d23-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const ctx = new Context();
    // cordis 实测坑（a12 备注）：桩必须以 Service 提供者注册，裸属性不满足注入条件
    class MeterStub extends Service {
        constructor(c, cfg) { super(c, "tokenMeter"); Object.assign(this, cfg); }
    }
    class LlmStub extends Service {
        constructor(c) { super(c, "llm"); }
    }
    class SessionsStub extends Service {
        constructor(c) { super(c, "sessions"); }
    }
    await ctx.plugin(MeterStub, { window, perNode });
    await ctx.plugin(LlmStub, {});
    await ctx.plugin(SessionsStub, {});
    if (withWebServer) await ctx.plugin(WebServerStub, {});
    await apply(ctx, {
        enabled: true,
        archiveDir: dir,
        summarizeFn: async () => summary ?? "这是一段足够短的摘要文本",
        summaryTarget: { provider: "test", model: "test" },
    });
    const meter = ctx.tokenMeter;
    meter.currentTokens = () => perNode;
    meter.measure = (session) => ({
        totalTokens: perNode,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: Math.floor(perNode / session.surface.nodes.length) })),
    });
    const svc = ctx.compaction;
    assert.ok(svc, "compaction 服务位必须被契约层接管");
    return { ctx, svc };
}

test("#1 路由以 exact kind 注册在约定路径，GET 返回方案规定的字段形状", async (t) => {
    const { ctx } = await setup(t, {});
    const ws = ctx.get("webServer");
    assert.equal(ws.specs.length, 1, "应恰好注册一条路由");
    const spec = ws.specs[0];
    assert.equal(spec.kind, "exact");
    assert.equal(spec.path, STATUS_ROUTE_PATH);

    // 从未压缩、无活跃会话的初始态：字段齐全 + 初值诚实
    const res = mockRes();
    spec.handler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    for (const key of ["status", "pressure", "window", "layers", "lastCompaction", "archiveDir", "since"]) {
        assert.ok(key in payload, `载荷缺 ${key}`);
    }
    assert.equal(typeof payload.since, "number");
    assert.ok(payload.since > 0 && payload.since <= Date.now(), "since 必须是本次运行的启动时刻");
    assert.equal(payload.lastCompaction, null, "未曾压缩时 lastCompaction 为 null");
    assert.equal(payload.window, 0, "无活跃会话时窗口读数为 0（不虚报兜底值）");
    assert.equal(payload.pressure, 0);
    assert.equal(payload.layers.l12Processed, 0);
    assert.ok(String(payload.archiveDir).length > 0, "archiveDir 应如实回传配置值");
    // 读数不允许被浏览器缓存（三入口同秒一致的验收前提）
    assert.match(res.headers["cache-control"], /no-store/);
    assert.match(res.headers["content-type"], /application\/json/);
});

test("#1 非 GET 请求被 405 拒绝（只读边界）", async (t) => {
    const { ctx } = await setup(t, {});
    const handler = ctx.get("webServer").handlerFor(STATUS_ROUTE_PATH);
    for (const method of ["POST", "PUT", "DELETE"]) {
        const res = mockRes();
        handler({ method }, res);
        assert.equal(res.statusCode, 405, `${method} 应被拒绝`);
        assert.ok(JSON.parse(res.body).error, "405 响应必须带 error 说明");
    }
});

test("#1 真实事务提交后 lastCompaction 被单点记账", async (t) => {
    const { svc, ctx } = await setup(t, { window: 128000, perNode: 2000 });
    const session = stubSession([
        { type: "user/message", data: { content: "任务一" } },
        { type: "tool/output", data: { content: "很长的工具输出".repeat(50) } },
        { type: "user/message", data: { content: "保留的近端消息" } },
    ]);
    const agent = stubAgent(session);
    const result = await svc.compactNow(agent, undefined, "cmd-d23");
    assert.ok(result, "有可压缩面必须返回事务结果");

    const handler = ctx.get("webServer").handlerFor(STATUS_ROUTE_PATH);
    const res = mockRes();
    handler({ method: "GET" }, res);
    const payload = JSON.parse(res.body);
    assert.ok(payload.lastCompaction, "事务提交后 lastCompaction 必须非空");
    assert.equal(payload.lastCompaction.compactionId, result.compactionId, "记账的必须是刚提交的这一次");
    assert.equal(payload.lastCompaction.shadowedTokenCount, result.shadowedTokenCount);
    assert.ok(typeof payload.lastCompaction.at === "number" && payload.lastCompaction.at > 0);
    // 会话被压缩路径触碰过 → 窗口读数恢复真实值（不再是 0）
    assert.equal(payload.window, 128000);
});

test("#1 无 webServer 时优雅跳过，四层压缩主功能不受影响", async (t) => {
    // 直接传一个没有 webServer 的裸 ctx：必须返回可用注销器且不抛错
    const bareCtx = new Context();
    const disposer = registerStatusRoute({ ctx: bareCtx, buildPayload: () => ({}) });
    assert.equal(typeof disposer, "function", "未注册也必须返回空注销器（调用方免分支）");
    assert.doesNotThrow(() => disposer());

    // 全量装配场景：宿主没有 webServer 时 apply 照常产出可用契约层
    const { svc } = await setup(t, { withWebServer: false });
    assert.equal(typeof svc.compactNow, "function");
});

test("#1 载荷工厂抛错时降级成 500 + error（#9 反向验证的数据源）", () => {
    let captured;
    const fakeCtx = {
        get: (name) => (name === "webServer"
            ? { register: (spec) => { captured = spec; return () => {}; } }
            : undefined),
        logger: { info() {}, warn() {} },
    };
    registerStatusRoute({ ctx: fakeCtx, buildPayload() { throw new Error("boom"); } });

    assert.equal(captured.kind, "exact");
    assert.equal(captured.path, STATUS_ROUTE_PATH);
    const res = mockRes();
    captured.handler({ method: "GET" }, res);
    assert.equal(res.statusCode, 500, "拼装失败必须降级为 500，不能挂连接或抛裸异常");
    const body = JSON.parse(res.body);
    assert.match(String(body.error), /boom/, "error 必须携带真实原因");
});
