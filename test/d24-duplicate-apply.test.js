import { resetProcessState } from "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import * as tieredPlugin from "../src/index.js";
import { ToolResultObserver } from "../src/tool-result-observer.js";
import { inspectSingleWriter } from "../src/single-writer-guard.js";

const quietLogger = { info() {}, warn() {}, error() {} };

function makeContext() {
    const ctx = new Context();
    ctx.provide("llm", { stream: async () => ({}) });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: 0, nodes: [] }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;

    const listeners = [];
    const on = ctx.on.bind(ctx);
    ctx.on = (name, listener, options) => {
        if (name === "session/event") listeners.push(listener);
        return on(name, listener, options);
    };
    return { ctx, listeners };
}

function replayFirstBadShadowPrice(events) {
    const surface = [];
    for (const event of events) {
        if (event.type === "compaction/prune") {
            const seqs = event.data.shadowedSeqs;
            const range = event.data.shadowedRange;
            const start = surface.indexOf(range.start);
            const end = surface.indexOf(range.end);
            const current = start >= 0 && end >= start ? surface.slice(start, end + 1) : null;
            if (current === null || current.length !== seqs.length || current.some((seq, i) => seq !== seqs[i])) {
                return { event, surface: [...surface] };
            }
            continue;
        }

        if (event.type !== "tool/result") continue;
        if (event.surfaceOp === "append") {
            surface.push(event.seq);
            continue;
        }
        const operation = event.surfaceOp;
        if (operation?.op !== "replace") continue;
        const start = surface.indexOf(operation.startSeq);
        const end = surface.indexOf(operation.endSeq);
        if (start < 0 || end < start) return { event, surface: [...surface] };
        surface.splice(start, end - start + 1, event.seq);
    }
    return null;
}

test("同一插件模块重复 apply 到 root 与 preset 时不得留下悬空 prune", async (t) => {
    resetProcessState();
    const archiveDir = await mkdtemp(join(tmpdir(), "d24-double-apply-"));
    t.after(async () => {
        resetProcessState();
        await rm(archiveDir, { recursive: true, force: true });
    });

    const root = makeContext();
    const preset = makeContext();
    await root.ctx.plugin(tieredPlugin, { enabled: true, archiveDir, auto: false });
    // preset 挂载点按 gen-*-tc 的口径携带 scopeId；不带的话会被当成第二个 root 拒掉
    await preset.ctx.plugin(tieredPlugin, { enabled: true, archiveDir, auto: false, scopeId: "standard" });

    assert.ok(root.listeners.length > 0, "root writer 应注册会话事件监听");
    assert.ok(root.ctx.get("compaction")._ownObserver, "root 持有观察者");
    assert.equal(
        preset.ctx.get("compaction")._ownObserver,
        undefined,
        "beta3：observer 席位全进程一份，root 已持有时 preset 实例不得再挂观察者",
    );

    const listeners = [...root.listeners, ...preset.listeners];
    const events = [];
    const nodes = [];
    const session = {
        id: "d24-double-apply-repro",
        surface: { nodes },
        eventAt: (seq) => events.find((event) => event.seq === seq),
        append(type, data, options = {}) {
            const event = { seq: events.length, type, data, ...options };
            if (type === "tool/result" && options.surfaceOp?.op === "replace") {
                const start = nodes.indexOf(options.surfaceOp.startSeq);
                const end = nodes.indexOf(options.surfaceOp.endSeq);
                if (start < 0 || end < start) throw new Error("replace range is not on current surface");
                nodes.splice(start, end - start + 1, event.seq);
            }
            events.push(event);
            for (const listener of listeners) {
                const result = listener(session, event);
                if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
            }
            return event;
        },
    };
    const source = {
        seq: 0,
        type: "tool/result",
        surfaceOp: "append",
        data: {
            message: {
                role: "tool",
                toolCallId: "call-0",
                source: { kind: "tool", callId: "call-0" },
                content: [{ type: "text", text: "x".repeat(9000) }],
            },
        },
    };
    events.push(source);
    nodes.push(source.seq);

    await Promise.all(listeners.map((listener) => listener(session, source)));

    const firstBad = replayFirstBadShadowPrice(events);
    assert.equal(firstBad, null, firstBad === null
        ? "surface span replay must remain valid"
        : `seq=${firstBad.event.seq} ${firstBad.event.type} shadows ${JSON.stringify(firstBad.event.data.shadowedSeqs)} outside current surface ${JSON.stringify(firstBad.surface)}`);
    assert.equal(events.filter((event) => event.type === "compaction/prune").length, 1);
    assert.deepEqual(nodes, [events.at(-1).seq]);
});

test("不同 preset realm 各持一个 compaction 席位，并在 fiber dispose 时释放", async (t) => {
    resetProcessState();
    const archiveDir = await mkdtemp(join(tmpdir(), "d24-realm-seats-"));
    t.after(async () => {
        resetProcessState();
        await rm(archiveDir, { recursive: true, force: true });
    });

    const ptc = makeContext();
    const standard = makeContext();
    const ptcFiber = ptc.ctx.plugin(tieredPlugin, {
        enabled: true,
        scopeId: "ptc-tc",
        archiveDir,
        auto: false,
    });
    const standardFiber = standard.ctx.plugin(tieredPlugin, {
        enabled: true,
        scopeId: "standard",
        archiveDir,
        auto: false,
    });
    await Promise.all([ptcFiber, standardFiber]);

    // 先 apply 的 ptc-tc 拿到 observer 席位；standard 只持自己的 compaction 席位
    assert.ok(ptc.ctx.get("compaction")._ownObserver, "没有 root 时第一个 apply 的实例持有观察者");
    assert.equal(standard.ctx.get("compaction")._ownObserver, undefined, "观察者全进程只有一份");
    assert.deepEqual(
        inspectSingleWriter().scopes.map((seat) => seat.scope).sort(),
        ["compaction:ptc-tc", "compaction:standard", "observer"],
    );

    await ptcFiber.dispose();
    assert.deepEqual(inspectSingleWriter().scopes.map((seat) => seat.scope), ["compaction:standard"]);
    await standardFiber.dispose();
    assert.equal(inspectSingleWriter().taken, false);

    const root = makeContext();
    const rootFiber = root.ctx.plugin(tieredPlugin, { enabled: true, archiveDir, auto: false });
    await rootFiber;
    assert.ok(root.ctx.get("compaction")._ownObserver, "realm 卸载后 root 实例应能取得 observer 席位");
    assert.deepEqual(
        inspectSingleWriter().scopes.map((seat) => seat.scope).sort(),
        ["compaction:root", "observer"],
    );
    await rootFiber.dispose();
    assert.equal(inspectSingleWriter().taken, false);
});

test("双 observer 同流时第二个 observer 必须在写 prune 前发现源节点已离开表面（W8）", async () => {
    const engine = {
        async processToolOutput(text) {
            return { text: `${text}!`, layers: ["fold"] };
        },
        lastSpillInfo: () => ({}),
    };
    const observerA = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });
    const observerB = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });
    const events = [];
    const nodes = [0];
    const session = {
        id: "d24-double-observer-repro",
        surface: { nodes },
        eventAt: (seq) => events.find((event) => event.seq === seq),
        append(type, data, options = {}) {
            const event = { seq: events.length, type, data, ...options };
            if (type === "tool/result" && options.surfaceOp?.op === "replace") {
                const start = nodes.indexOf(options.surfaceOp.startSeq);
                const end = nodes.indexOf(options.surfaceOp.endSeq);
                if (start < 0 || end < start) throw new Error("replace range is not on current surface");
                nodes.splice(start, end - start + 1, event.seq);
            }
            events.push(event);
            return event;
        },
    };
    const source = {
        seq: 0,
        type: "tool/result",
        surfaceOp: "append",
        data: {
            message: {
                role: "tool",
                toolCallId: "call-0",
                source: { kind: "tool", callId: "call-0" },
                content: [{ type: "text", text: "x".repeat(9000) }],
            },
        },
    };
    events.push(source);

    const outcomes = await Promise.allSettled([
        observerA.handleEvent(session, source),
        observerB.handleEvent(session, source),
    ]);
    const prunes = events.filter((event) => event.type === "compaction/prune");
    const replacements = events.filter((event) => event.surfaceOp?.op === "replace");
    const firstBad = replayFirstBadShadowPrice(events);

    // beta3 W8 之前：两个 observer 各写一枚 prune，第二枚是 stale span（冷加载失败）。
    // 现在 replace() 写 prune 前同步复核 surface.nodes / eventAt，第二个直接跳过。
    assert.equal(prunes.length, 1, "第二个 observer 不得再写 stale prune");
    assert.equal(replacements.length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 0, "跳过不是失败");
    assert.equal(firstBad, null, "回放检查不得发现任何坏 span");
    assert.equal(observerA.stats.skipped + observerB.stats.skipped, 1, "跳过的一方必须计入 skipped");
    assert.deepEqual(nodes, [replacements[0].seq]);
});
