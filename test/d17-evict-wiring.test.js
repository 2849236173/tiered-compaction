/**
 * 第 3 层（80% 驱逐）必须真的改动会话表面，不能只广播事件。
 *
 * 缺陷（2026-10-27 对照 a12-contract 测试时发现）：
 *   `compactIfNeeded` 在压力 ≥80% 时只做了一件事：
 *     ctx.emit("tiered-compaction/evict", ...)
 *   而**生产代码里没有任何监听者**——只有测试在听这个事件。
 *
 *   于是真实会话里第 3 层的驱逐从未执行：
 *   日志照样打「已广播易失内容驱逐事件」，看起来做了事，
 *   实际会话表面一个字节都没变。
 *
 *   而 observer 上的 `evictStaleToolResults` 早就写好了（就是为这一层写的），
 *   只是从来没有人调用它。
 *
 * 这与本插件反复踩的坑完全同型：
 *   广播不等于落地（emit 出去了，没人接）；
 *   有实现不等于被调用（方法在，没接线）。
 *
 * 本文件的原则：**断言会话表面真的变了**，而不是断言事件被发出去了。
 * 只测 emit 的测试，正是当初放走这个 bug 的原因。
 *
 * 运行：node --test test/d17-evict-wiring.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * 造 ctx，压力读数由用例指定。
 *
 * 注意：这里**不伪造 tokenMeter**（D16 教训）——tokenMeter 的真实接口
 * 就是 measure(session) → { totalTokens, nodes }，我们按真实形状提供数据，
 * 只是数值由用例决定。窗口走真实 contextWindowOf 路径（requestContext）。
 */
function makeCtx(pressureTokens) {
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* () {
            yield { type: "finish", reason: { kind: "stop" } };
        },
    });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: pressureTokens, nodes: [] }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;
    return ctx;
}

/** 造一个带可重放工具结果（read）的会话桩（append 同步派发 session/event）。 */
function makeSessionWithReadResult() {
    const log = [];
    const nodes = [];
    const listeners = [];

    const session = {
        get seq() {
            return log.length;
        },
        surface: { nodes },
        requestHeader: () => ({ config: { provider: "test-provider", model: "test-model" } }),
        requestContext: () => ({ provider: "test-provider", model: "test-model", contextWindow: 10000 }),
        eventAt: (seq) => log.find((e) => e.seq === seq),
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
            return event;
        },
        log,
        nodes,
    };
    return session;
}

test("压力 ≥80% 时，第 3 层必须真的驱逐可重放工具结果（表面必须变化）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "evict-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 窗口 10000 → 80% = 8000；给 9000 制造驱逐压力
    const ctx = makeCtx(9000);
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeSessionWithReadResult();
    // 一条 read 工具结果（可重放，属于最该被驱逐的类别）
    session.append("tool/result", {
        toolName: "read",
        message: {
            role: "tool",
            source: { kind: "tool", toolName: "read", callId: "c1" },
            content: [{ type: "text", text: "被读取文件的完整内容".repeat(200) }],
        },
    });

    const originalSurface = [...session.surface.nodes];
    assert.equal(session.surface.nodes.length, 1, "测试前提：表面上应有一条工具结果");

    // 走真实的压力触发入口（不是直接调 observer）
    await service.compactIfNeeded({ session }, "pressure", undefined);

    assert.notDeepEqual(
        session.surface.nodes,
        originalSurface,
        "压力 ≥80% 时第 3 层必须改动会话表面——只广播事件而无人监听，等于没做",
    );

    // 且必须留下 compaction/prune 记录（可审计，不是静默删除）
    const prunes = session.log.filter((e) => e.type === "compaction/prune");
    assert.ok(prunes.length > 0, "驱逐必须留下 compaction/prune 审计记录");

    // 被驱逐的内容必须替换成「请重跑」提示，而不是丢失
    const latest = session.eventAt(session.surface.nodes[0]);
    const text = JSON.stringify(latest.data);
    assert.match(text, /驱逐|重跑/, `驱逐后的内容必须提示可重跑恢复，实得：${text.slice(0, 200)}`);
});

test("压力低于 70% 时第 3 层不得改动表面（不能误伤）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "evict2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 窗口 10000 → 50% = 5000，低于 70% 提醒线
    const ctx = makeCtx(5000);
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeSessionWithReadResult();
    session.append("tool/result", {
        toolName: "read",
        message: {
            role: "tool",
            source: { kind: "tool", toolName: "read", callId: "c1" },
            content: [{ type: "text", text: "内容".repeat(200) }],
        },
    });
    const originalSurface = [...session.surface.nodes];

    await service.compactIfNeeded({ session }, "pressure", undefined);

    assert.deepEqual(
        session.surface.nodes,
        originalSurface,
        "压力 50% 时不该发生任何驱逐——低压力区误伤比不驱逐更糟",
    );
});
