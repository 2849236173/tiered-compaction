/**
 * 三方交叉审计第三批（2026-10-27）：turn 字段与 overflow 强制恢复。
 *
 * 这两条由 gpt-6-astra 与 gpt-5.6-sol 分别报出，我查宿主源码确认。
 *
 * 运行：node --test test/d17-turn-overflow.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

async function makeService() {
    const dir = await mkdtemp(join(tmpdir(), "to-"));
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* () {
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
    return { service: ctx.get("compaction"), dir };
}

function makeSession({ window = 1000000 } = {}) {
    const log = [];
    const nodes = [];
    const listeners = [];
    const session = {
        id: "S",
        get seq() { return log.length; },
        surface: { nodes },
        requestHeader: () => ({ config: { provider: "p", model: "m" } }),
        requestContext: () => ({ provider: "p", model: "m", contextWindow: window }),
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
        log,
        nodes,
    };
    return session;
}

test("compaction/start 与 end 必须带 turn（宿主格式契约必填）", async (t) => {
    const { service, dir } = await makeService();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const session = makeSession();
    session.append("turn/start", { turn: 7 });
    session.append("user/message", { content: [{ type: "text", text: "历史内容".repeat(3000) }] });

    await service._runTransaction(session, 1, 1, { session }, undefined);

    const start = session.log.find((e) => e.type === "compaction/start");
    const end = session.log.find((e) => e.type === "compaction/end");
    assert.equal(start?.data?.turn, 7, "compaction/start 必须带 turn=7（宿主 dsh-session-format 要求必填）");
    assert.equal(end?.data?.turn, 7, "compaction/end 必须带 turn=7");
});

test("空闲态（无 open turn）时 turn 必须为 null，而不是 undefined", async (t) => {
    const { service, dir } = await makeService();
    t.after(() => rm(dir, { recursive: true, force: true }));

    const session = makeSession();
    // 只有已关闭的 turn
    session.append("turn/start", { turn: 1 });
    session.append("turn/end", { turn: 1 });
    session.append("user/message", { content: [{ type: "text", text: "历史内容".repeat(3000) }] });

    await service._runTransaction(session, 2, 2, { session }, undefined);

    const start = session.log.find((e) => e.type === "compaction/start");
    assert.ok("turn" in start.data, "turn 字段必须存在");
    assert.equal(start.data.turn, null, "空闲态必须是 null（原版口径），不能是 undefined");
});

test("overflow 必须用 retain=0 强制选择整段，不被保留尾部挡住", async (t) => {
    const { service, dir } = await makeService();
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 造 5 个节点的表面：总量小（各 100 token），保留 16000 时选不出区间。
    // 注意至少要有 2 个节点——原版在只有 1 个节点时也会返回 null
    // （`keepFromIdx <= firstIdx`），那是"无从压缩"的正常边界，不是 bug。
    const session = makeSession({ window: 20000 });
    for (let i = 0; i < 5; i += 1) {
        session.append("user/message", { content: [{ type: "text", text: `节点${i}` }] });
    }

    const priced = session.surface.nodes.map((seq) => ({ seq, tokens: 100 }));
    // 保留 16000 时选出的是全部节点 → keepFromIdx <= firstIdx → null（这正是旧 bug 的表现）
    const withRetain = service._selectRange(session, { nodes: priced }, 16000);
    assert.equal(withRetain, null, "测试前提：保留大量内容时确实选不出区间");

    // retain=0 时必须能选出区间（把最后一个节点之前的部分都压掉）
    const forced = service._selectRange(session, { nodes: priced }, 0);
    assert.ok(forced !== null, "retain=0 时必须能选出区间——overflow 强制恢复依赖这一点");
    assert.equal(forced.start, session.surface.nodes[0], "强制选区必须从第一个节点开始");
});
