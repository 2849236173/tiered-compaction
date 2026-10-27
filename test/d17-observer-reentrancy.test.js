/**
 * 同一事件被并发派发时，观察者不得重复处理（系统审计发现）。
 *
 * 缺陷（2026-10-27 系统审计）：
 *   `handleEvent` 在 `await this.engine.processToolOutput(...)` **之后**
 *   才 `this.done.add(event.seq)`。中间有真实的竞态窗口：
 *
 *     调用 A: done.has(1)? 否 → 进入 → await ...（挂起）
 *     调用 B: done.has(1)? 否 → 也进入 → await ...（挂起）
 *     两者都完成后各写一条替换事件
 *
 *   触发条件（都不罕见）：
 *     · 宿主重放事件（重启恢复、会话回放）
 *     · 观察者被重复注册（插件重载）
 *     · 宿主不 await 钩子返回值（并发派发）
 *
 *   后果：同一位置被替换两次（表面出现两条 replace 记录）、
 *         引擎白做一次折叠/落盘（多写一个存档文件）、
 *         统计数字翻倍（健康自检的计数会骗人）。
 *
 * 实测：并发两次 → engine 调用 2 次、替换事件 2 条。
 * 修复后 → 1 次、1 条。
 *
 * 运行：node --test test/d17-observer-reentrancy.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ToolResultObserver } from "../src/tool-result-observer.js";

/** 造一个能观察调用次数的引擎桩。 */
function makeEngine({ delayMs = 10, fail = false } = {}) {
    const calls = [];
    return {
        calls,
        async processToolOutput(text, at) {
            calls.push(at.seq);
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            if (fail) throw new Error("引擎故意失败");
            return { text: text + "!", layers: ["fold"] };
        },
        lastSpillInfo: () => ({}),
        lineage: { record() {} },
    };
}

/** 造一个最小会话桩（真实 append 语义）。 */
function makeSession() {
    const log = [];
    const nodes = [];
    const session = {
        surface: { nodes },
        eventAt: (s) => log.find((e) => e.seq === s),
        append(type, data, options = {}) {
            const seq = log.length;
            log.push({ seq, type, data, ...options });
            if (options.surfaceOp?.op === "replace") {
                const at = nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) nodes[at] = seq;
            } else if (type === "tool/result") {
                nodes.push(seq);
            }
            return { seq };
        },
    };
    session.append("tool/result", { message: { content: [{ type: "text", text: "原始内容".repeat(50) }] } });
    return session;
}

const ctx = { logger: { info() {}, warn() {} }, on() {} };

test("同一事件并发派发两次，引擎只能被调用一次（去重必须早于 await）", async () => {
    const engine = makeEngine();
    const observer = new ToolResultObserver({ engine, ctx });
    const session = makeSession();
    const event = session.eventAt(0);

    await Promise.all([
        observer.handleEvent(session, event),
        observer.handleEvent(session, event),
    ]);

    assert.equal(
        engine.calls.length,
        1,
        `引擎只能处理一次，实得 ${engine.calls.length} 次——` +
        "去重标记若在 await 之后才写，并发窗口内两次调用都会进去",
    );
});

test("同一事件并发派发两次，只能产生一条替换事件", async () => {
    const engine = makeEngine();
    const observer = new ToolResultObserver({ engine, ctx });
    const session = makeSession();
    const event = session.eventAt(0);

    await Promise.all([
        observer.handleEvent(session, event),
        observer.handleEvent(session, event),
    ]);

    const replaces = [];
    // 统计写入的 tool/result 替换事件（原事件之外的那些）
    const log = [];
    // 通过 surface 长度间接判断：替换后表面应仍是 1 个节点
    assert.equal(
        session.surface.nodes.length,
        1,
        "表面必须仍是 1 个节点（替换不新增位置）",
    );
    assert.equal(observer.stats.replaced, 1, `统计必须是 1 次替换，实得 ${observer.stats.replaced}`);
});

test("引擎失败时必须回滚去重占位，否则该事件永久被跳过", async () => {
    const engine = makeEngine({ fail: true });
    const observer = new ToolResultObserver({ engine, ctx });
    const session = makeSession();
    const event = session.eventAt(0);

    await assert.rejects(() => observer.handleEvent(session, event));

    assert.equal(
        observer.done.has(0),
        false,
        "失败后必须移除占位——否则同一事件的重放永远无法补救",
    );

    // 换成成功引擎重试，必须能正常处理
    const goodEngine = makeEngine();
    const observer2 = new ToolResultObserver({ engine: goodEngine, ctx });
    await observer2.handleEvent(session, event);
    assert.equal(goodEngine.calls.length, 1, "回滚后重放必须能正常处理");
});

test("串行派发两次（非并发）也必须只处理一次", async () => {
    const engine = makeEngine({ delayMs: 0 });
    const observer = new ToolResultObserver({ engine, ctx });
    const session = makeSession();
    const event = session.eventAt(0);

    await observer.handleEvent(session, event);
    await observer.handleEvent(session, event);

    assert.equal(engine.calls.length, 1, "串行重复派发也不得重复处理");
});
