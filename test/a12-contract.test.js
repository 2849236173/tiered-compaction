/**
 * A12 宿主契约对齐验收：用真实 cordis Context + 宿主形状的 agent/session/
 * tokenMeter 桩，走宿主源码里的两条真实调用路径：
 * ① /compact 命令路径：ctx.compaction.compactNow(agent, signal, cmdId)
 * ② 自动压力路径：agent/pre-step 钩子 → compactIfNeeded(agent, "pressure")
 * 断言：三入口 typeof function、事务事件序列与返回形状与 basic 对齐、
 * 70%/80% 行为由钩子真实触发、失败补配对 end 不留 unmatched start。
 *
 * 运行：node --test test/a12-contract.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

import { apply } from "../src/index.js";

/**
 * 宿主形状的最小 session 桩：surface + eventAt + append（事件序列可断言）。
 * `dispatchers` 由用例注入：append 后同步调用它们（真实宿主 commit 语义，
 * 不 await 返回的 Promise）——D19 起桩必须与宿主一样"吵"。
 */
function stubSession(nodes, dispatchers = []) {
    const events = [];
    let seq = 0;
    const surface = nodes.map((n) => (n.seq = ++seq, n.seq));
    const store = new Map(nodes.map((n) => [n.seq, { seq: n.seq, type: n.type, data: n.data }]));
    const session = {
        surface: { get nodes() { return surface; } },
        eventAt: (seq) => store.get(seq),
        requestHeader: () => ({ config: { provider: "test", model: "test" } }),
        /** 与宿主 ctx.on("session/event", ...) 同构的注册面（缺省无监听者）。 */
        on(type, listener) {
            if (type !== "session/event") return () => {};
            dispatchers.push(listener);
            return () => {
                const at = dispatchers.indexOf(listener);
                if (at !== -1) dispatchers.splice(at, 1);
            };
        },
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
            // 宿主语义：append 同步派发 session/event，不 await 返回的 Promise
            for (const listener of dispatchers) {
                try {
                    const result = listener(session, ev);
                    if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
                } catch { /* 宿主也是 catch 掉监听者的同步异常 */ }
            }
            return ev;
        },
        events,
    };
    return session;
}

/** 宿主形状的最小 agent 桩：runMaintenance 直通执行（常开信号兜底）。 */
function stubAgent(session) {
    return {
        session,
        runMaintenance: async (fn) => fn(new AbortController().signal),
    };
}

/** 组装一个装好契约层的 ctx（enabled=true，测试摘要桩）。 */
async function setup(t, { window, perNode, summary }) {
    const dir = await mkdtemp(join(tmpdir(), "a12-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const ctx = new Context();
    // inject 面：契约层 static inject = ["llm","tokenMeter","sessions"]。
    // cordis 实测坑：只解析「由 Service 注册的服务」，裸属性不满足注入条件，
    // 服务会永久挂起不构造——桩一律以 Service 提供者注册（真实宿主同理由包占位）。
    const { Service } = await import("@deepseek-ai/cordis");
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
    await apply(ctx, {
        enabled: true,
        archiveDir: dir,
        summarizeFn: async (req) => {
            assert.equal(req.maxTokens, 20000, "A4a：摘要预算必须写死 20k");
            return summary ?? "这是一段足够短的摘要文本";
        },
        summaryTarget: { provider: "test", model: "test" },
    });
    const meter = ctx.tokenMeter;
    setMeter(meter, perNode);
    const svc = ctx.compaction;
    assert.ok(svc, "compaction 服务位必须被契约层接管");
    // 三入口契约面
    for (const m of ["compactNow", "compactIfNeeded", "compactRegion", "summarize"]) {
        assert.equal(typeof svc[m], "function", `宿主契约入口 ${m} 必须存在`);
    }
    return { ctx, svc, meter };
}

/**
 * 给 meter 桩换读数（total=当前总 token，不重建以满足 inject 面）。
 *
 * **注意**（D16 实锤）：真实 `TokenMeter` 只有 `measure`/`estimateMessage`，
 * **没有 `contextWindow()`**。窗口由 `request/context` 事件携带，因此桩不能
 * 伪造 `meter.contextWindow`——早先版本正是这么写的，等于给「代码读了不存在
 * 的 API」这个真 bug 打了掩护（测试全绿、线上全死）。
 */
function setMeter(meter, total) {
    meter.currentTokens = () => total;
    meter.measure = (session) => ({
        totalTokens: total,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: Math.floor(total / session.surface.nodes.length) })),
    });
}

/**
 * 把窗口写进会话事件流（真实宿主形态：token-meter 从 `request/context`
 * 的 `data.contextWindow` 读窗口，插件也该这么读）。
 * @param {object} session stubSession 返回的会话
 * @param {number} window 窗口 token
 */
function setWindowOnSession(session, window) {
    const seq = 900000 + (session.__nextWindowSeq = (session.__nextWindowSeq ?? 0) + 1);
    session.__windowEvents ??= new Map();
    session.__windowEvents.set(seq, {
        seq,
        type: "request/context",
        data: { contextWindow: window },
    });
    const origEventAt = session.__origEventAt ?? session.eventAt;
    session.__origEventAt = origEventAt;
    session.eventAt = (s) => session.__windowEvents.get(s) ?? origEventAt(s);
    session.surface.nodes.push(seq);
    return session;
}

/** 轮询等待条件成立（cordis emit 不等 async listener，事务异步闭合）。 */
async function waitFor(cond, timeoutMs) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
        await new Promise((r) => setTimeout(r, 20));
    }
}

test("A12① /compact 路径：compactNow 走真实事务，事件序列与返回形状对齐 basic", async (t) => {
    const { svc } = await setup(t, { window: 128000, perNode: 2000 });
    const nodes = [
        { type: "user/message", data: { content: "任务一" } },
        { type: "tool/output", data: { content: "很长的工具输出".repeat(50) } },
        { type: "user/message", data: { content: "保留的近端消息" } },
    ];
    const session = stubSession(nodes);
    const agent = stubAgent(session);
    const result = await svc.compactNow(agent, undefined, "cmd-1");
    assert.ok(result, "有可压缩面必须返回事务结果");
    // 返回形状（basic 对齐）
    for (const k of ["compactionId", "startSeq", "summarySeq", "summary", "shadowedRange", "shadowedSeqs", "shadowedTokenCount", "endSeq"]) {
        assert.ok(k in result, `返回缺 ${k}`);
    }
    // 事务事件序列：start → summary → user/message(replace) → end
    const types = session.events.map((e) => e.type);
    assert.deepEqual(types, ["compaction/start", "compaction/summary", "user/message", "compaction/end"]);
    // replace 后表面缩短
    assert.ok(session.surface.nodes.length < nodes.length, "表面必须被替换缩短");
    // summary 事件载荷含宿主渲染依赖字段
    const summaryEv = session.events.find((e) => e.type === "compaction/summary");
    for (const k of ["compactionId", "summary", "shadowedRange", "shadowedSeqs", "shadowedTokenCount", "provider", "model", "maxTokens"]) {
        assert.ok(k in summaryEv.data, `summary 事件缺 ${k}`);
    }
    // 替换消息带 compactCheckpointSource（宿主投影识别依赖）
    const replaceEv = session.events.find((e) => e.type === "user/message");
    assert.ok(replaceEv.opts.sourceEventSeqs.length >= 3);
    assert.ok(replaceEv.data.source, "user/message 必须带 checkpoint source");
});

test("A12② pressure 钩子路径：agent/pre-step 真实触发 70% 提醒 / 80% 驱逐事件 / 阈值摘要", async (t) => {
    const { ctx, svc, meter } = await setup(t, { window: 100000, perNode: 1000 });
    // 钩子必须已注册
    const evictions = [];
    ctx.on("tiered-compaction/evict", (payload) => evictions.push(payload));
    const nodes = [
        // fixture 内容必须足够大：摘要 guard 要求摘要小于被取代内容（basic 同款规则）
        { type: "user/message", data: { content: "历史消息一 " + "很长的上下文内容。".repeat(200) } },
        { type: "tool/output", data: { content: "工具输出 " + "更多的工具输出内容。".repeat(200) } },
        { type: "user/message", data: { content: "近端消息" } },
    ];
    const session = stubSession(nodes);
    const agent = stubAgent(session);

    // 70%：只提醒，零事务事件（200k 窗口：第 4 层阈值 = 200k−16k−20k = 164k，
    // 总量 140k = 70% 未达阈值 → 只提醒；小窗口下阈值线先于提醒线，故用大窗口）
    setMeter(meter, 140000);
    setWindowOnSession(session, 200000);
    let fired = null;
    ctx.state = { fired: () => fired };
    // 真实钩子触发：直接派发 agent/pre-step（宿主 agent-loop 的调用方式）
    await ctx.emit("agent/pre-step", { agent, signal: new AbortController().signal }, () => {});
    // compactIfNeeded 返回 null 但提醒已发生（无事务事件）
    assert.equal(session.events.length, 0, "70% 只提醒不改历史");

    // 80%：驱逐事件必须广播（200k 窗口总量 160k = 80%，仍低于阈值 164k → 只驱逐不摘要）
    setMeter(meter, 160000);
    setWindowOnSession(session, 200000);
    await ctx.emit("agent/pre-step", { agent, signal: new AbortController().signal }, () => {});
    assert.equal(evictions.length, 1, "80% 必须广播驱逐事件");
    assert.equal(session.events.length, 0, "80% 驱逐不动会话表面");

    // 达阈值：走摘要事务（总量 170k ≥ 阈值 164k，同时 85% ≥ 80% 驱逐共存）
    setMeter(meter, 170000);
    setWindowOnSession(session, 200000);
    await ctx.emit("agent/pre-step", { agent, signal: new AbortController().signal }, () => {});
    // cordis 的 emit 不等 async listener：轮询等事务闭合（最多 2s）
    await waitFor(() => session.events.some((e) => e.type === "compaction/end"), 2000);
    assert.ok(session.events.some((e) => e.type === "compaction/start"), "达阈值必须走摘要事务");
    assert.ok(session.events.some((e) => e.type === "compaction/end"), "事务必须闭合 end");
});

test("A12③ 失败路径：摘要为空抛 ManualCompactionError 且补配对 end（不留 unmatched start）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "a12f-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const ctx = new Context();
    const { Service } = await import("@deepseek-ai/cordis");
    class MeterStub extends Service {
        constructor(c, cfg) { super(c, "tokenMeter"); Object.assign(this, cfg); }
    }
    class LlmStub extends Service {
        constructor(c) { super(c, "llm"); }
    }
    class SessionsStub extends Service {
        constructor(c) { super(c, "sessions"); }
    }
    await ctx.plugin(MeterStub, {});
    await ctx.plugin(LlmStub, {});
    await ctx.plugin(SessionsStub, {});
    await apply(ctx, {
        enabled: true,
        archiveDir: dir,
        summarizeFn: async () => "", // 摘要为空 → 必须失败
        summaryTarget: { provider: "test", model: "test" },
    });
    const meter = ctx.tokenMeter;
    setMeter(meter, 3000);
    const svc = ctx.compaction;
    const session = stubSession([
        { type: "user/message", data: { content: "一" } },
        { type: "tool/output", data: { content: "二" } },
    ]);
    const agent = stubAgent(session);
    await assert.rejects(() => svc.compactNow(agent, undefined, "cmd-2"), /ManualCompactionError|为空|事务失败/);
    const types = session.events.map((e) => e.type);
    assert.equal(types.filter((x) => x === "compaction/start").length, 1);
    assert.equal(types.filter((x) => x === "compaction/end").length, 1, "失败必须补配对 end");
    assert.ok(session.events.at(-1).data.error, "end 事件必须带 error 说明");
});

test("A12④ context-overflow 触发：直接走摘要事务，重试去重只补一枪", async (t) => {
    // meter 读数：total 60k > retain 16k（选区可压缩）；overflow 触发不看压力阈值
    const { svc, meter } = await setup(t, { window: 128000, perNode: 30000 });
    const session = stubSession([
        { type: "user/message", data: { content: "a " + "溢出前的大段历史。".repeat(300) } },
        { type: "tool/output", data: { content: "b " + "溢出前的工具输出。".repeat(300) } },
    ]);
    const agent = stubAgent(session);
    setMeter(meter, 60000);
    const r1 = await svc.compactIfNeeded(agent, "context-overflow", undefined);
    assert.ok(r1, "overflow 必须触发摘要事务");
    const r2 = await svc.compactIfNeeded(agent, "context-overflow", undefined);
    assert.equal(r2, null, "同一 agent 的第二次 overflow 必须被记账去重");
});
