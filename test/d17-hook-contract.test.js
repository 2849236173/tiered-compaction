/**
 * D17 钩子契约测试：`session/event` 必须按**宿主真实签名**接通。
 *
 * 为什么单独一个文件：
 *   D16 那批观察者测试全部直接调 `observer.handleEvent(...)`，并用
 *   `ctx: { on() {} }` 做空桩——这使「register() 里钩子签名写错」这类
 *   bug 完全测不到。真实宿主用位置参数 `(session, event)`（见
 *   dsh-compaction-basic/lib/index.js:856 与自家 contract.js:343），
 *   而 register() 里曾写成 `(payload) => payload?.session`，
 *   结果两个参数都是 undefined，钩子在第一行就 return：
 *   第 1-2 层在真实会话里从未执行，且不报任何错。
 *
 * 本文件的原则：**只通过 register() 注册的钩子驱动**，绝不直接调 handleEvent。
 * 这是「接入宿主的功能必须有一条走真实钩子的测试」这条纪律的落地。
 *
 * 运行：node --test test/d17-hook-contract.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TieredCompactionEngine } from "../src/engine.js";
import { ToolResultObserver, textOfToolResult } from "../src/tool-result-observer.js";

const quietLogger = { info() {}, warn() {} };

/** 造一个最小会话桩（与 d16-fixes 同口径）。 */
function fakeSession(events = []) {
    const log = [...events];
    const session = {
        surface: { nodes: events.map((e) => e.seq) },
        eventAt: (seq) => log.find((e) => e.seq === seq),
        append(type, data, options = {}) {
            const seq = log.length + 1;
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

function toolResult(seq, text, toolName = "pwsh") {
    return {
        seq,
        type: "tool/result",
        data: {
            toolName,
            message: {
                content: [{ type: "text", text }],
                source: { callId: `call-${seq}`, toolName },
            },
        },
    };
}

/**
 * 造一个「会真实记录并转发」的 ctx：`on` 把处理函数存下来，
 * 测试主动按宿主签名调用它，模拟宿主派发。
 */
function recordingCtx() {
    const handlers = new Map();
    return {
        logger: quietLogger,
        handlers,
        on(name, fn) {
            if (!handlers.has(name)) handlers.set(name, []);
            handlers.get(name).push(fn);
        },
        /** 按宿主真实签名派发（位置参数）。 */
        async emit(name, ...args) {
            const list = handlers.get(name) ?? [];
            for (const fn of list) await fn(...args);
        },
    };
}

/** 40 行连续重复：第 1 层无损折叠可折叠。 */
const REPEATED = Array.from({ length: 40 }, () => "same log line").join("\n");

test("D17 钩子契约：register() 后按宿主签名 (session, event) 派发即可触发压缩", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d17hook-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = recordingCtx();
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx });
    observer.register();

    assert.ok(ctx.handlers.has("session/event"), "register() 必须注册 session/event 钩子");

    const session = fakeSession([toolResult(1, REPEATED)]);
    const event = session.eventAt(1);

    // 关键：按宿主真实签名派发位置参数，而不是对象
    await ctx.emit("session/event", session, event);

    assert.ok(
        session.log.some((e) => e.type === "compaction/prune"),
        "走真实钩子必须产生 compaction/prune 影子定价（旧实现此处为 0，第 1-2 层从未执行）",
    );
    const replaced = session.eventAt(session.surface.nodes[0]);
    const text = textOfToolResult(replaced) ?? "";
    assert.match(text, /tiered-compaction/, "表面必须被替换成折叠后内容");
    assert.ok(text.length < REPEATED.length, "替换后必须更小");
});

test("D17 钩子契约：对象形式 ({session, event}) 也能接住（跨版本兼容）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d17hook2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = recordingCtx();
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx });
    observer.register();

    const session = fakeSession([toolResult(1, REPEATED)]);
    const event = session.eventAt(1);

    await ctx.emit("session/event", { session, event });

    assert.ok(
        session.log.some((e) => e.type === "compaction/prune"),
        "对象形式派发也应触发压缩（兼容分支）",
    );
});

test("D17 钩子契约：参数缺失时安静跳过，不抛错不误报", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d17hook3-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = recordingCtx();
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx });
    observer.register();

    // 只给一个参数 / 全空：必须安静返回，不产生任何统计副作用
    await ctx.emit("session/event", undefined, undefined);
    await ctx.emit("session/event", {}, undefined);

    assert.equal(observer.stats.replaced, 0);
    assert.equal(observer.stats.failed, 0, "缺参不是异常，不该记 failed");
});

test("D17 钩子契约：非 tool/result 事件不参与压缩", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d17hook4-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = recordingCtx();
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx });
    observer.register();

    const session = fakeSession([]);
    await ctx.emit("session/event", session, { seq: 1, type: "assistant/message", data: {} });

    assert.equal(session.log.length, 0, "非 tool/result 事件不应写任何事件");
    assert.equal(observer.stats.replaced, 0);
});
