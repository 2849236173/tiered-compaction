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
import "./reset-writer.js";
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
        surface: { get nodes() { return surface; }, replaceGeneration: 0 },
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
                session.surface.replaceGeneration += 1;
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
async function setup(t, { window, perNode, summary, auto = true }) {
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
        auto,
        archiveDir: dir,
        summarizeFn: async (req, input, signal) => {
            assert.equal(req.maxTokens, 20000, "A4a：摘要预算必须写死 20k");
            if (typeof summary === "function") return summary(req, input, signal);
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
    const startEv = session.events.find((e) => e.type === "compaction/start");
    const endEv = session.events.find((e) => e.type === "compaction/end");
    assert.equal(startEv.data.sourceCommandId, "cmd-1");
    assert.equal(endEv.data.sourceCommandId, "cmd-1");
    assert.equal(replaceEv.data.source.sourceCommandId, "cmd-1");
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
        { type: "user/message", data: { content: "历史请求 " + "旧上下文。".repeat(500) } },
        { type: "tool/output", data: { content: "历史工具输出 " + "旧结果。".repeat(500) } },
        { type: "user/message", data: { content: "当前指令：继续修复" } },
    ]);
    const agent = stubAgent(session);
    await assert.rejects(() => svc.compactNow(agent, undefined, "cmd-2"), /ManualCompactionError|为空|事务失败/);
    const types = session.events.map((e) => e.type);
    assert.equal(types.filter((x) => x === "compaction/start").length, 1);
    assert.equal(types.filter((x) => x === "compaction/end").length, 1, "失败必须补配对 end");
    assert.ok(session.events.at(-1).data.error, "end 事件必须带 error 说明");
});

test("C1 /compact：agent 忙时归类为 busy，agentSignal 取消归类为 cancelled", async (t) => {
    const { svc } = await setup(t, { window: 128000, perNode: 2000 });
    const session = stubSession([
        { type: "user/message", data: { content: "历史" } },
        { type: "user/message", data: { content: "当前指令" } },
    ]);
    const busyAgent = {
        session,
        runMaintenance() { throw new Error('agent "x" already has active work'); },
    };
    await assert.rejects(() => svc.compactNow(busyAgent), (error) => error.code === "busy");

    const cancelledAgent = {
        session,
        async runMaintenance(fn) {
            const controller = new AbortController();
            controller.abort(new Error("cancelled by test"));
            return fn(controller.signal);
        },
    };
    await assert.rejects(() => svc.compactNow(cancelledAgent), (error) => error.code === "cancelled");
});

test("C2 maxOverflowRetries=2：request-error 钩子允许两次恢复，不在 compactIfNeeded 内去重", async (t) => {
    const { ctx, svc } = await setup(t, { window: 128000, perNode: 30000 });
    svc.config.maxOverflowRetries = 2;
    const session = stubSession([
        { type: "user/message", data: { content: "历史" } },
        { type: "user/message", data: { content: "当前指令" } },
    ]);
    session.surface.replaceGeneration = 0;
    const agent = stubAgent(session);
    let calls = 0;
    svc.compactIfNeeded = async () => {
        calls += 1;
        session.surface.replaceGeneration += 1;
        return { shadowedSeqs: [1], shadowedRange: { start: 1, end: 1 } };
    };
    const { CONTEXT_WINDOW_EXCEEDED_CODE } = await import("@deepseek-ai/dsh-llm");
    const emitFailure = () => ctx.emit("agent/request-error", {
        agent,
        failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
        signal: new AbortController().signal,
    }, () => {});
    await emitFailure();
    await waitFor(() => calls === 1, 1000);
    await emitFailure();
    await waitFor(() => calls === 2, 1000);
    await emitFailure();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 2, "maxOverflowRetries=2 应恰好允许两次恢复");
});

test("C6 窗口未知：跳过 pressure 自动层并按会话只告警一次", async (t) => {
    const { ctx, svc, meter } = await setup(t, { window: 128000, perNode: 30000 });
    const session = stubSession([
        { type: "user/message", data: { content: "大段历史" } },
        { type: "user/message", data: { content: "当前指令" } },
    ]);
    const warnings = [];
    const logger = ctx.logger;
    const originalWarn = logger.warn;
    logger.warn = (message) => warnings.push(String(message));
    try {
        setMeter(meter, 120000);
        const agent = stubAgent(session);
        assert.equal(await svc.compactIfNeeded(agent, "pressure"), null);
        assert.equal(await svc.compactIfNeeded(agent, "pressure"), null);
        assert.equal(session.events.length, 0, "窗口未知时不能执行压力提醒、驱逐或摘要");
        assert.equal(warnings.filter((message) => message.includes("contextWindow")).length, 1);
    } finally {
        logger.warn = originalWarn;
    }
});

test("C7 retain=0 保留最新 user/message 与其后的节点；C9(b) 检出 token 节点序号错位", async (t) => {
    const { svc } = await setup(t, { window: 128000, perNode: 2000 });
    const session = stubSession([
        { type: "user/message", data: { content: "旧用户任务" } },
        { type: "assistant/message", data: { message: { content: [{ type: "text", text: "旧答复" }] } } },
        { type: "user/message", data: { content: "必须保留的最新指令" } },
        { type: "assistant/message", data: { message: { content: [{ type: "text", text: "最新指令后的内容" }] } } },
    ]);
    const aligned = session.surface.nodes.map((seq, index) => ({ seq, tokens: 2000 + index }));
    const range = svc._selectRange(session, { nodes: aligned }, 0);
    assert.ok(range);
    assert.ok(session.surface.nodes.indexOf(range.end) < 2, "待压缩区间不得包含最新 user/message");
    assert.throws(() => svc._selectRange(session, {
        nodes: aligned.map((node, index) => index === 1 ? { ...node, seq: 9999 } : node),
    }, 0), /seqs do not align/);
});

test("C9(c) compaction/end append 失败时不重试写第二枚 end", async (t) => {
    const { svc } = await setup(t, { window: 128000, perNode: 2000 });
    const session = stubSession([
        { type: "user/message", data: { content: "历史请求 " + "旧上下文。".repeat(500) } },
        { type: "tool/output", data: { content: "历史工具输出 " + "旧结果。".repeat(500) } },
        { type: "user/message", data: { content: "当前指令" } },
    ]);
    const append = session.append;
    let endAttempts = 0;
    session.append = (type, ...args) => {
        if (type === "compaction/end") {
            endAttempts += 1;
            throw new Error("simulated end append failure");
        }
        return append(type, ...args);
    };
    await assert.rejects(() => svc.compactNow(stubAgent(session)), /事务失败|simulated/);
    assert.equal(endAttempts, 1);
});

test("auto:false 不注册 agent/pre-step 与 agent/request-error 自动钩子", async (t) => {
    const { ctx, svc } = await setup(t, { window: 100000, perNode: 30000, auto: false });
    let calls = 0;
    svc.compactIfNeeded = async () => { calls += 1; };
    const session = stubSession([{ type: "user/message", data: { content: "当前指令" } }]);
    const agent = stubAgent(session);
    await ctx.emit("agent/pre-step", { agent, signal: new AbortController().signal }, () => {});
    await ctx.emit("agent/request-error", {
        agent,
        failure: { code: "CONTEXT_WINDOW_EXCEEDED" },
        signal: new AbortController().signal,
    }, () => {});
    assert.equal(calls, 0);
    assert.equal(svc.config.auto, false);
});

test("C5 摘要连续失败退避，压力增长后重试，成功后清零", async (t) => {
    let shouldFail = true;
    let summaries = 0;
    const { svc, meter } = await setup(t, {
        window: 100000,
        perNode: 30000,
        summary: async () => {
            summaries += 1;
            if (shouldFail) throw new Error("temporary summarizer failure");
            return "short checkpoint";
        },
    });
    const session = stubSession([
        { type: "user/message", data: { content: "历史任务 " + "旧上下文内容。".repeat(500) } },
        { type: "tool/output", data: { content: "历史输出 " + "旧工具结果。".repeat(500) } },
        { type: "user/message", data: { content: "当前指令" } },
    ]);
    setWindowOnSession(session, 100000);
    const agent = stubAgent(session);
    let currentTotal = 85000;
    meter.measure = (currentSession) => {
        const totalTokens = currentSession.surface.replaceGeneration > 0 ? 70000 : currentTotal;
        const nodes = currentSession.surface.nodes.map((seq) => ({ seq, tokens: Math.floor(totalTokens / currentSession.surface.nodes.length) }));
        return { totalTokens, nodes };
    };
    meter.currentTokens = () => session.surface.replaceGeneration > 0 ? 70000 : currentTotal;
    for (let index = 0; index < 3; index += 1) {
        await assert.rejects(() => svc.compactIfNeeded(agent, "pressure"));
    }
    assert.equal(summaries, 3);
    assert.equal(await svc.compactIfNeeded(agent, "pressure"), null);
    assert.equal(summaries, 3, "连续失败达到门槛后，不应每一步都再次调用 LLM");

    shouldFail = false;
    currentTotal = 90000;
    const result = await svc.compactIfNeeded(agent, "pressure");
    assert.ok(result, "压力比上次失败增加 5 个百分点后应允许再试");
    assert.equal(svc.summaryFailures.has(session), false, "成功后失败计数清零");

});

test("C4 摘要等待期间 agentSignal 取消时返回 cancelled 且不提交检查点", async (t) => {
    let release;
    const { svc } = await setup(t, {
        window: 128000,
        perNode: 30000,
        summary: (_request, _input, signal) => new Promise((resolve, reject) => {
            release = resolve;
            signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
    });
    const session = stubSession([
        { type: "user/message", data: { content: "历史请求 " + "旧上下文。".repeat(500) } },
        { type: "tool/output", data: { content: "历史输出 " + "旧结果。".repeat(500) } },
        { type: "user/message", data: { content: "当前指令" } },
    ]);
    const controller = new AbortController();
    const agent = {
        session,
        async runMaintenance(fn) { return fn(controller.signal); },
    };
    const pending = svc.compactNow(agent);
    await waitFor(() => typeof release === "function", 1000);
    controller.abort(new Error("cancelled by test"));
    await assert.rejects(() => pending, (error) => error.code === "cancelled");
    assert.equal(session.events.some((event) => event.type === "compaction/summary"), false);
    assert.equal(session.events.some((event) => event.type === "user/message"), false);
});


test("A12④ context-overflow 触发：直接调用会走摘要事务，重试上限由 request-error 钩子管理", async (t) => {
    // meter 读数：total 60k > retain 16k（选区可压缩）；overflow 触发不看压力阈值
    const { svc, meter } = await setup(t, { window: 128000, perNode: 30000 });
    const session = stubSession([
        { type: "user/message", data: { content: "旧请求 " + "溢出前的大段历史。".repeat(300) } },
        { type: "tool/output", data: { content: "旧工具 " + "溢出前的工具输出。".repeat(300) } },
        { type: "user/message", data: { content: "当前溢出恢复指令" } },
    ]);
    const agent = stubAgent(session);
    setMeter(meter, 60000);
    const r1 = await svc.compactIfNeeded(agent, "context-overflow", undefined);
    assert.ok(r1, "overflow 必须触发摘要事务");
});
