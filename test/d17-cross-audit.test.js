/**
 * 三方交叉审计发现的缺陷（2026-10-27）。
 *
 * 这一轮由三个模型（gpt-6-astra / gemini-3.8-flash / glm-5.3）独立审计，
 * glm 失败，另两个各报了一批。下面每条都是我**亲手实跑复现**后才修的，
 * 不是照抄报告。
 *
 * 最严重的一条（观察者自触发）直接把 node 进程跑到 OOM 崩溃——
 * 而当时 164 条测试全绿也毫无察觉，因为 fake session 的 append
 * 不会派发 session/event，桩比现实"更安静"。
 *
 * 运行：node --test test/d17-cross-audit.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { ToolResultObserver, PRUNE_MARKER } from "../src/tool-result-observer.js";
import { spillIfNeeded } from "../src/spill-to-disk.js";

/* ---------------- P0：观察者自触发 → OOM ---------------- */

/**
 * 造一个**照宿主真实语义**派发事件的会话：
 * `Session.commit()` 会同步调用所有 session/event 监听器，且不 await
 * （dsh-session lib:1592 + lib:1231）。fake session 若不这么做，
 * 就永远测不到自触发递归。
 */
function makeDispatchingSession(listeners, id = "S") {
    const log = [];
    const nodes = [];
    return {
        id,
        surface: { nodes },
        eventAt: (s) => log.find((e) => e.seq === s),
        append(type, data, options = {}) {
            const seq = log.length;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                const at = nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) nodes[at] = seq;
            } else if (type === "tool/result") {
                nodes.push(seq);
            }
            // 宿主语义：同步派发、不等待返回的 Promise
            for (const fn of listeners) {
                try { fn(event === undefined ? undefined : this, event); } catch { /* 宿主也是 catch 掉 */ }
            }
            return event;
        },
        log,
    };
}

function makeObserver() {
    const listeners = [];
    const ctx = {
        logger: { info() {}, warn() {} },
        on(name, fn) { if (name === "session/event") listeners.push(fn); },
    };
    const engine = {
        async processToolOutput(text) {
            return { text: text.slice(0, 100), layers: ["fold"] };
        },
        lastSpillInfo: () => ({}),
        lineage: { record() {} },
    };
    const observer = new ToolResultObserver({ engine, ctx });
    observer.register();
    return { observer, listeners };
}

test("P0 观察者不得被自己写回的替换事件再次触发（旧实现会递归到 OOM）", async () => {
    const { listeners } = makeObserver();
    const session = makeDispatchingSession(listeners, "S");

    const callId = "c1";
    session.append("tool/call", { callId, name: "read", arguments: "{}" });
    session.append("tool/result", {
        message: {
            role: "tool",
            source: { kind: "tool", callId },
            toolCallId: callId,
            content: [{ type: "text", text: "原始内容".repeat(500) }],
            isError: false,
        },
        meta: { path: "a.js" },
    });

    // 给递归足够时间发生（旧实现在这里会 OOM 崩掉）
    await new Promise((r) => setTimeout(r, 200));

    const toolResults = session.log.filter((e) => e.type === "tool/result");
    assert.ok(
        toolResults.length <= 2,
        `tool/result 事件必须 ≤2（源 + 一次替换），实得 ${toolResults.length}——` +
        "超过说明观察者在反复处理自己的产物",
    );
    assert.ok(
        session.log.length <= 6,
        `事件总数必须 ≤6，实得 ${session.log.length}——旧实现在此无限追加直到内存耗尽`,
    );
});

test("P0 观察者必须跳过带 PRUNE_MARKER 的替换事件", async () => {
    const { observer, listeners } = makeObserver();
    const session = makeDispatchingSession(listeners, "S2");

    const callId = "c1";
    session.append("tool/call", { callId, name: "read", arguments: "{}" });
    // 直接构造一条已被压缩过的结果（带标记），观察者必须直接跳过
    session.append("tool/result", {
        message: {
            role: "tool",
            source: { kind: "tool", callId },
            toolCallId: callId,
            content: [{ type: "text", text: `${PRUNE_MARKER} 已压缩过的内容` }],
            isError: false,
        },
        meta: { path: "a.js" },
    });

    await new Promise((r) => setTimeout(r, 50));
    // 没有产生新的 prune 记录 = 跳过了
    assert.equal(
        session.log.filter((e) => e.type === "compaction/prune").length,
        0,
        "带 PRUNE_MARKER 的事件必须被跳过，不得再次压缩",
    );
});

/* ---------------- P1：路径穿越 ---------------- */

test("P1 存档名不得穿越出 archiveDir（oldGoalId 等外部输入可注入 ../）", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "trav-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dir = join(base, "archive");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });

    const names = [
        "../../../escaped",
        "..\\..\\win-escaped",
        "a/b/c",
        "..",
        "\u0000null",
    ];
    for (const name of names) {
        const result = await spillIfNeeded("内容".repeat(100), dir, name, { threshold: 1 });
        assert.ok(result !== null, `names=${JSON.stringify(name)} 应能落盘（消毒后）`);
        const inside = resolve(result.path).startsWith(resolve(dir) + sep);
        assert.ok(
            inside,
            `names=${JSON.stringify(name)} 写入到了 archiveDir 外面：${result.path}`,
        );
    }
});

test("P1 正常存档名不得被消毒破坏", async (t) => {
    const base = await mkdtemp(join(tmpdir(), "trav-ok-"));
    t.after(() => rm(base, { recursive: true, force: true }));
    const dir = join(base, "archive");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });

    const result = await spillIfNeeded("内容".repeat(100), dir, "arbitrated-abc123-42-mvq1", { threshold: 1 });
    assert.ok(result.path.includes("arbitrated-abc123-42-mvq1"), "正常名字必须保留");
});

/* ---------------- P1：取消后不得提交 ---------------- */

test("P1 摘要期间被取消时，不得提交压缩（不得写 summary / 替换表面）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "abort-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const { Context } = await import("@deepseek-ai/cordis");
    const { apply } = await import("../src/index.js");

    let releaseSummary;
    const summaryGate = new Promise((r) => { releaseSummary = r; });
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* () {
            // 模拟慢摘要：等外部放行
            await summaryGate;
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "摘要内容" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "摘要内容" } };
            yield { type: "finish", reason: { kind: "stop" } };
        },
    });
    ctx.provide("tokenMeter", { measure: () => ({ totalTokens: 0, nodes: [] }), estimateMessage: () => 0 });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = { info() {}, warn() {}, error() {} };
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const log = [];
    const nodes = [];
    const listeners = [];
    const session = {
        id: "s-abort",
        get seq() { return log.length; },
        surface: { nodes },
        requestHeader: () => ({ config: { provider: "p", model: "m" } }),
        requestContext: () => ({ provider: "p", model: "m", contextWindow: 1000000 }),
        eventAt: (s) => log.find((e) => e.seq === s),
        /** 与宿主 ctx.on("session/event", ...) 同构的注册面。 */
        on(type, listener) {
            if (type !== "session/event") return () => {};
            listeners.push(listener);
            return () => {
                const at = listeners.indexOf(listener);
                if (at !== -1) listeners.splice(at, 1);
            };
        },
        append(type, data, options = {}) {
            const seq = log.length;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                const at = nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) nodes[at] = seq;
            } else if (["user/message", "assistant/message", "tool/result"].includes(type)) {
                nodes.push(seq);
            }
            // 宿主语义：append 同步派发 session/event，不 await 返回的 Promise
            for (const listener of listeners) {
                try {
                    const result = listener(session, event);
                    if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
                } catch { /* 宿主也是 catch 掉监听者的同步异常 */ }
            }
            return { seq };
        },
    };
    session.append("user/message", { content: [{ type: "text", text: "历史内容".repeat(2000) }] });

    const controller = new AbortController();
    const run = service._runTransaction(session, 0, 0, { session }, controller.signal);
    // 等摘要真的开始，再取消
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    releaseSummary();

    await assert.rejects(() => run, "取消后事务必须失败，不得静默提交");

    assert.equal(
        log.filter((e) => e.type === "compaction/summary").length,
        0,
        "取消后不得写 compaction/summary",
    );
    const replacements = log.filter((e) => e.surfaceOp?.op === "replace");
    assert.equal(replacements.length, 0, "取消后不得替换会话表面");
});
