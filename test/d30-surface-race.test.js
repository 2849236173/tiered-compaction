/**
 * D30（beta3 审计 W8/W9）：写 prune 前的同步表面复核 + 自产物守卫。
 *
 * 全部用真实宿主 `Session.create` + 宿主派发语义（wire），不用假会话（自检规矩 R5/R6）。
 *
 * 运行：node --test test/d30-surface-race.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { setup, seedTool, eventsOf, coldReplay, hostReplace, settle, skipWithoutHost } from "./d30-helpers.js";

const BIG = "line\n".repeat(6000) + "tail";

test("W8 handleEvent await 期间宿主 pruner 换掉同一 seq：不写 stale prune，冷加载通过", { skip: skipWithoutHost }, async () => {
    const { session, observer } = await setup("aaaaaaaa");
    const source = seedTool(session, BIG);
    // observer 已在 append 时异步启动（正在 await 落盘），宿主此刻同步替换同一 seq
    hostReplace(session, source.seq);
    await settle();
    const events = eventsOf(session);
    assert.equal(coldReplay(events), "OK", "会话日志必须能冷加载");
    assert.equal(events.filter((e) => e.type === "compaction/prune").length, 1, "只有宿主那一枚 prune");
    assert.equal(observer.stats.skipped, 1, "源节点离开表面 → 计入 skipped");
    assert.equal(observer.stats.failed, 0);
});

test("W8 handleEvent await 期间 80% 驱逐换掉同一 seq：observer 跳过，不写事件", { skip: skipWithoutHost }, async () => {
    const { session, observer } = await setup("bbbbbbbb");
    seedTool(session, "x".repeat(9000), "read", "c2");
    const { evicted } = await observer.evictStaleToolResults(session);
    await settle();
    const events = eventsOf(session);
    assert.equal(evicted, 1);
    assert.equal(coldReplay(events), "OK");
    assert.equal(events.filter((e) => e.type === "compaction/prune").length, 1, "只有驱逐那一枚 prune");
    assert.equal(observer.stats.replaced, 0);
    assert.equal(observer.stats.skipped, 1);
    assert.equal(observer.stats.failed, 0);
});

test("W8 evictStaleToolResults 循环内逐 seq 复核：快照里已被换掉的节点不再驱逐", { skip: skipWithoutHost }, async () => {
    const { session, observer, listeners } = await setup("cccccccc");
    seedTool(session, "r".repeat(500), "read", "c1");
    const second = seedTool(session, "s".repeat(500), "read", "c2");
    await settle(); // 小结果在第 1-2 层无收益，先让观察者跑完
    // 同步监听者：驱逐写下第一枚 prune 时，另一个写者把第二个结果换掉
    let fired = false;
    listeners.push((s, event) => {
        if (fired || event.type !== "compaction/prune") return;
        fired = true;
        hostReplace(s, second.seq);
    });
    const { evicted } = await observer.evictStaleToolResults(session);
    await settle();
    const events = eventsOf(session);
    assert.ok(fired, "夹具必须真的在循环中途改动表面");
    assert.equal(evicted, 1, "第二个 seq 已离开表面，只驱逐第一个");
    assert.equal(coldReplay(events), "OK");
});

test("W9 自产物守卫读顶层 surfaceOp：替换事件不再进入第 1-2 层", { skip: skipWithoutHost }, async () => {
    const { session, observer } = await setup("dddddddd");
    const calls = [];
    const original = observer.engine.processToolOutput.bind(observer.engine);
    observer.engine.processToolOutput = (text, at) => {
        calls.push(at.seq);
        return original(text, at);
    };
    const source = seedTool(session, "short", "read", "c3");
    await settle(100);
    const replacement = session.append("tool/result", {
        ...source.data,
        message: { ...source.data.message, content: [{ type: "text", text: `${"x".repeat(9000)}\n[... tool result middle pruned ...]` }] },
    }, { surfaceOp: { op: "replace", startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq] });
    await settle();
    // 宿主契约：surfaceOp 在事件顶层，data 里没有
    assert.equal(replacement.surfaceOp.op, "replace");
    assert.equal(replacement.data.surfaceOp, undefined);
    assert.deepEqual(calls, [source.seq], "只加工 append 源事件，替换产物不得再加工");
});
