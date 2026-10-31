/**
 * D29 验收（host 半）：状态路由按会话取数 + 各层计数口径统一。
 *
 * 修复前的三处缺陷：
 *   1. _statusPayload 只认 latestSession，而它只在压缩路径里赋值——普通工具结果
 *      被第 1-2 层加工过，状态面板仍是 idle + 全 0；
 *   2. collectHealth 读 observer.evicted.size（属性不存在，l3Evicted 恒 0）和
 *      observer.done.size（「尝试过」集合，skip/无收益也算）；
 *   3. 读数异常在 _statusPayload 里被 catch 成 idle 200，路由的 500 分支形同虚设。
 *
 * 本文件覆盖：
 *   - observer 处理工具结果后，status 返回该会话且 l12Processed 非 0；
 *   - `?session=<id>` 指定会话；未知 id 返回 idle 且 sessionId 回显请求值；
 *   - 驱逐后 l3Evicted===1；
 *   - skip / 无收益不计入 l12Processed；
 *   - _statusPayload 抛异常时路由返回 500。
 *
 * 运行：node --test test/d29-session-status.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TieredCompactionEngine } from "../src/engine.js";
import { ToolResultObserver } from "../src/tool-result-observer.js";
import { sessionIdOf } from "../src/status-route.js";

const STATUS_PATH = "/api/tiered-compaction/status";
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 收集响应的 res 桩（d23 同款）。 */
function mockRes() {
    return {
        statusCode: 0, headers: {}, body: "",
        setHeader(key, value) { this.headers[key] = value; },
        end(body) { this.body = body ?? ""; },
    };
}

/**
 * 宿主形状的最小会话桩：带 id、surface、eventAt、append（replace 原地换 seq）。
 * @param {string} id
 * @param {object[]} events 初始事件（需自带 seq）
 */
function fakeSession(id, events = []) {
    const log = [...events];
    const session = {
        id,
        surface: { nodes: events.map((e) => e.seq) },
        eventAt: (seq) => log.find((e) => e.seq === seq),
        requestHeader: () => ({ config: { provider: "test", model: "test" } }),
        append(type, data, options = {}) {
            const seq = log.length + 100;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                const at = session.surface.nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) session.surface.nodes[at] = seq;
            }
            return event;
        },
        log,
    };
    return session;
}

/** 一条文本工具结果事件（工具名内联，走 toolNameOf 快路径）。 */
function toolResult(seq, text, toolName = "pwsh") {
    return {
        seq,
        type: "tool/result",
        data: {
            toolName,
            message: { content: [{ type: "text", text }], source: { callId: `call-${seq}`, toolName } },
        },
    };
}

/** 40 行连续重复：第 1 层无损折叠必有收益。 */
const FOLDABLE = Array.from({ length: 40 }, () => "same log line").join("\n");

/** 装好整个插件（d28 同款桩），返回服务与状态 handler。 */
async function mountPlugin(t) {
    const { Context, Service } = await import("@deepseek-ai/cordis");
    const { apply } = await import("../src/index.js");

    class WebServerStub extends Service {
        constructor(ctx) { super(ctx, "webServer"); this.specs = []; }
        register(spec) { this.specs.push(spec); return () => {}; }
        handlerFor(path) { return this.specs.find((spec) => spec.path === path)?.handler; }
    }
    class MeterStub extends Service {
        constructor(c, cfg) { super(c, "tokenMeter"); Object.assign(this, cfg); }
    }
    class LlmStub extends Service {
        constructor(c) { super(c, "llm"); }
    }
    class SessionsStub extends Service {
        constructor(c) { super(c, "sessions"); }
    }

    const dir = await mkdtemp(join(tmpdir(), "d29-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const ctx = new Context();
    await ctx.plugin(MeterStub, { window: 128000, perNode: 2000 });
    await ctx.plugin(LlmStub, {});
    await ctx.plugin(SessionsStub, {});
    await ctx.plugin(WebServerStub, {});
    await apply(ctx, {
        enabled: true,
        archiveDir: dir,
        summarizeFn: async () => "摘要",
        summaryTarget: { provider: "test", model: "test" },
    });
    const meter = ctx.tokenMeter;
    meter.currentTokens = () => 2000;
    meter.measure = (session) => ({
        totalTokens: 2000,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 10 })),
    });
    const handler = ctx.get("webServer").handlerFor(STATUS_PATH);
    assert.equal(typeof handler, "function", "status 路由必须已注册");
    /** 发一次 GET，返回 { statusCode, payload }。 */
    const get = async (url = STATUS_PATH) => {
        const res = mockRes();
        await handler({ method: "GET", url }, res);
        return { statusCode: res.statusCode, payload: res.body ? JSON.parse(res.body) : null };
    };
    return { svc: ctx.compaction, get };
}

test("D29-1 observer 处理工具结果后，status 返回该会话且 l12Processed 非 0", async (t) => {
    const { svc, get } = await mountPlugin(t);
    const idle = await get();
    assert.equal(idle.payload.sessionId, null, "还没有任何事件时是 idle");

    const session = fakeSession("sess-A", [toolResult(1, FOLDABLE)]);
    // 没有发生任何第 4 层压缩：旧实现下 latestSession 永远是 null
    await svc.observer.handleEvent(session, session.eventAt(1));

    const { statusCode, payload } = await get();
    assert.equal(statusCode, 200);
    assert.equal(payload.sessionId, "sess-A", "无参数时退回最近活跃会话");
    assert.equal(payload.layers.l12Processed, 1, "实际替换 1 次");
    assert.ok(payload.layers.l12BytesSaved > 0);
});

test("D29-2 ?session=<id> 按会话取数；未知 id 返回 idle 且回显请求值", async (t) => {
    const { svc, get } = await mountPlugin(t);
    const a = fakeSession("sess-A", [toolResult(1, FOLDABLE)]);
    const b = fakeSession("sess-B", [toolResult(1, "short")]);
    await svc.observer.handleEvent(a, a.eventAt(1));
    await svc.observer.handleEvent(b, b.eventAt(1));

    const latest = await get();
    assert.equal(latest.payload.sessionId, "sess-B", "最近活跃的是 B");
    assert.equal(latest.payload.layers.l12Processed, 0, "B 没有成功替换");

    const forA = await get(`${STATUS_PATH}?session=sess-A`);
    assert.equal(forA.payload.sessionId, "sess-A");
    assert.equal(forA.payload.layers.l12Processed, 1, "A 的计数不被 B 冲掉");

    const unknown = await get(`${STATUS_PATH}?session=nope`);
    assert.equal(unknown.statusCode, 200);
    assert.equal(unknown.payload.sessionId, "nope", "未知会话回显请求值");
    assert.equal(unknown.payload.pressure, 0);
    assert.equal(unknown.payload.layers.l12Processed, 0);
});

test("D29-3 驱逐后 l3Evicted===1（不再读不存在的 observer.evicted）", async (t) => {
    const { svc, get } = await mountPlugin(t);
    const session = fakeSession("sess-E", [toolResult(1, "x".repeat(500), "read")]);
    await svc.observer.handleEvent(session, session.eventAt(1));
    const result = await svc.observer.evictStaleToolResults(session);
    assert.equal(result.evicted, 1);

    const { payload } = await get(`${STATUS_PATH}?session=sess-E`);
    assert.equal(payload.layers.l3Evicted, 1);
});

test("D29-4 skip / 无收益不计入 l12Processed", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d29-skip-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });

    // 富块（含图片）→ skip
    const rich = {
        seq: 1,
        type: "tool/result",
        data: { message: { content: [{ type: "text", text: "看图" }, { type: "image", attachment: { id: "x" } }] } },
    };
    // 短文本 → 各层都没有收益
    const plain = toolResult(2, "ok");
    const session = fakeSession("sess-S", [rich, plain]);
    await observer.handleEvent(session, rich);
    await observer.handleEvent(session, plain);

    const counts = observer.statsFor(session);
    assert.equal(counts.processed, 0, "skip 和无收益都不是「处理成功」");
    assert.equal(counts.skipped, 2);
    assert.equal(observer.done.size, 2, "done 仍记两条「尝试过」，但它不再是计数来源");
    assert.equal(observer.statsFor(fakeSession("other")).processed, 0, "未见过的会话全 0");
});

test("D29-5 _statusPayload 抛异常时路由返回 500（不再被吞成 idle 200）", async (t) => {
    const { svc, get } = await mountPlugin(t);
    const session = fakeSession("sess-X", [toolResult(1, FOLDABLE)]);
    await svc.observer.handleEvent(session, session.eventAt(1));
    svc._readingOf = () => {
        throw new Error("meter broken");
    };
    const { statusCode } = await get();
    assert.equal(statusCode, 500);
});

test("D29-6 sessionIdOf：只认非空 session 参数", () => {
    assert.equal(sessionIdOf({ url: `${STATUS_PATH}?session=abc` }), "abc");
    assert.equal(sessionIdOf({ url: `${STATUS_PATH}?session=` }), undefined);
    assert.equal(sessionIdOf({ url: STATUS_PATH }), undefined);
    assert.equal(sessionIdOf({}), undefined);
});
