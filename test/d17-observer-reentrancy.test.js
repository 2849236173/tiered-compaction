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

/* ────────────────────────────────────────────────────────────────
 * D19 补：宿主 commit 同步派发语义下的自触发防线
 *
 * 这个场景与上面四条不同：上面是「同一事件被外部派发两次」，
 * 这里是「观察者自己 append 的替换事件，被宿主 commit **同步**派发回
 * 观察者自己」——真实宿主的 Session.commit() 同步调用所有 session/event
 * 监听器且不 await，所以写回的那条替换事件会在 handleEvent 内部再次
 * 进入 handleEvent。
 *
 * 三道防线缺一就是无限递归（OOM 崩溃）：
 *   1. 替换内容带 PRUNE_MARKER → 内容判定拦下
 *   2. 事件带 surfaceOp: replace → 形状判定拦下
 *   3. 该 seq 已在 done / evicted → 去重拦下
 *
 * 当时 194 条测试全绿放走了这个 bug：桩的 append 不派发，
 * 桩比现实安静。这条测试造的是**真实派发语义**的桩。
 * ──────────────────────────────────────────────────────────────── */

/**
 * 造一个「append 会同步派发 session/event」的会话桩——与真实宿主 commit 语义一致。
 *
 * 与 makeSession 的差别只在一点：append 之后，同步调用本会话上注册的
 * 所有 session/event 监听者，不 await 它们的返回值。这是真实宿主的行为，
 * 也是 OOM 那个 bug 能存在的前提。
 *
 * @returns {object} 会话桩
 */
function makeSessionWithSyncDispatch() {
    const log = [];
    const nodes = [];
    const listeners = [];

    const session = {
        surface: { nodes },
        eventAt: (s) => log.find((e) => e.seq === s),
        /** 与宿主 ctx.on("session/event", ...) 同构的注册面。 */
        on(type, listener) {
            if (type !== "session/event") {
                return () => {};
            }
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
            } else if (type === "tool/result") {
                nodes.push(seq);
            }

            // 真实宿主语义（dsh-session lib:1580 `const callbackArgs = [this, event]`）：
            // 按位置参数 (session, event) 派发，且不等待监听器的 Promise。
            // 观察者的监听器是 async，这里故意不 await——与宿主一致。
            // 注意：必须传 (session, event) 两个位置参数——只传裸事件会让
            // 观察者的解构拿到 undefined，递归链建立不起来，测试就成了假绿。
            for (const listener of listeners) {
                try {
                    const result = listener(session, event);
                    // async 监听器返回 Promise；真实宿主不 await，这里同样不 await。
                    // 若观察者防线齐全，递归会在第二层被拦下，不会堆栈爆炸。
                    if (result !== undefined && typeof result.catch === "function") {
                        result.catch(() => {});
                    }
                } catch {
                    // 同步异常不阻断记账（与宿主口径一致）
                }
            }

            return event;
        },
    };

    session.append("tool/result", {
        message: { content: [{ type: "text", text: "原始内容".repeat(50) }] },
    });
    return session;
}

test("宿主 commit 同步派发：写回的替换事件再次进入观察者，必须被三道防线拦下（OOM 防线）", async () => {
    const engine = makeEngine({ delayMs: 0 });

    // 关键：这个桩的 append 会同步派发——与真实宿主一致。
    const session = makeSessionWithSyncDispatch();

    // 必须走真实注册路径（observer.register() → ctx.on("session/event")），
    // 不能直接调 handleEvent——直接调绕过了派发链，递归根本建立不起来，
    // 测试就成了「测了但没真验」（D17 的教训同源：单测直接调 handleEvent 全绿，宿主能跑才是真的）。
    const ctxWithSession = { logger: { info() {}, warn() {} }, on: (type, listener) => session.on(type, listener) };
    const observer = new ToolResultObserver({ engine, ctx: ctxWithSession });
    observer.register();

    const event = session.eventAt(0);

    // 真实派发：observer 的钩子在 append 时被同步调用。若防线缺失，
    // 这里无限递归直到 OOM——测试进程直接崩溃，断言根本走不到。
    await observer.handleEvent(session, event);

    // 给同步派发的递归链留一拍：防线若缺，递归早已堆栈爆掉；
    // 防线若齐，递归在第二层被拦，这里静默结束。
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(engine.calls.length, 1, "引擎只处理最初的源事件一次");

    // 写回的替换事件被拦截，不得再次处理（否则每次处理都产生新处理，无限循环）
    assert.equal(
        observer.stats.replaced,
        1,
        `必须恰好 1 次替换，实得 ${observer.stats.replaced}——超过 1 说明自触发防线失效`,
    );
    assert.equal(
        session.surface.nodes.length,
        1,
        "表面必须仍是 1 个节点：替换事件再触发时不得产生第二次替换",
    );
});

test("宿主 commit 同步派发：防线必须逐道有效（撤一道就该爆炸或重复处理）", async () => {
    // 这条验证防线不是「碰巧」拦住的：单独撤掉 PRUNE_MARKER 内容判定，
    // surfaceOp 形状判定必须兜住；再撤掉 surfaceOp 判定，去重必须兜住。
    const engine = makeEngine({ delayMs: 0 });
    const observer = new ToolResultObserver({ engine, ctx });
    const session = makeSessionWithSyncDispatch();
    const event = session.eventAt(0);

    await observer.handleEvent(session, event);
    await new Promise((r) => setTimeout(r, 50));

    // 直接构造一条「不带 PRUNE_MARKER、不带 surfaceOp」的替换事件，
    // 模拟防线 1、2 都不认识的形状——只有防线 3（去重）能拦。
    const seq = session.seq;
    const bare = session.append("tool/result", {
        message: { content: [{ type: "text", text: "不带任何标记的替换内容" }] },
    });

    await new Promise((r) => setTimeout(r, 50));

    // 去重防线：新 seq 不在 done 里，会被正常处理一次；
    // 但它处理后的写回又带 PRUNE_MARKER + surfaceOp，被防线 1、2 拦下 → 递归终止。
    assert.ok(engine.calls.length >= 1, "不带标记的事件应被正常处理（它不是我们写回的）");

    // 关键断言：处理它写回的替换事件不得再次触发处理（防线 1、2 拦截）
    const callsAfterSettle = engine.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
        engine.calls.length,
        callsAfterSettle,
        "处理停止后引擎调用数必须稳定——持续增长说明递归未终止",
    );
});
