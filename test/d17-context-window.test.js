/**
 * 窗口读数必须走宿主官方 API（D17 沙箱实测挖出的真因）。
 *
 * 缺陷（2026-10-27 沙箱验证暴露）：
 *   旧实现遍历 `session.surface.nodes` 找 type === "request/context" 来读窗口。
 *   但 `request/context` 是**路由元数据**，未必出现在表面节点里
 *   （表面只承载消息类节点）。
 *
 *   后果链：窗口永远读不到 → 回落兜底 128,000 → 压力按 128k 计算，
 *   与实际窗口完全无关 → 沙箱里把窗口设成 20,000 也毫无反应。
 *   **全程不报错**，因为兜底值本身是个合法数字。
 *
 * 为什么这个 bug 特别危险：
 *   它属于「读不到就用合理默认值」的静默降级。这类降级在日志里看起来
 *   一切正常，只有把实际窗口调小、观察压力是否随之变化才能发现。
 *
 * 宿主官方途径：`session.requestContext()`（dsh-session lib：
 *   "Return the latest resolved route metadata"），它内部 fold 了
 *   `request/context` 事件。
 *
 * 运行：node --test test/d17-context-window.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { __test } from "../src/contract.js";

const { contextWindowOf } = __test;

test("优先走 requestContext()：官方 API 给出的窗口必须被采用", () => {
    const session = {
        requestContext: () => ({ contextWindow: 20000, provider: "p", model: "m" }),
        // 表面上**没有** request/context 事件，旧实现会在此回落到 128k
        surface: { nodes: [] },
        eventAt: () => undefined,
        seq: 0,
    };
    assert.equal(contextWindowOf(session), 20000, "必须采用 requestContext() 的窗口，而不是兜底值");
});

test("官方 API 有值时必须优先于日志扫描（即便日志里有别的值）", () => {
    // 关键场景：日志里残留着上一次路由的旧窗口，官方 API 给的是**当前**路由。
    // 只有 API 路径存在时才能拿到正确值——这条专门用来证明 API 路径不可省。
    const events = {
        1: { seq: 1, type: "request/context", data: { contextWindow: 1000000 } }, // 旧路由的
    };
    const session = {
        requestContext: () => ({ contextWindow: 20000 }), // 当前路由（切换后）
        surface: { nodes: [1] },
        eventAt: (seq) => events[seq],
        seq: 2,
    };
    assert.equal(
        contextWindowOf(session),
        20000,
        "必须用官方 API 的当前路由窗口，不能拿日志里旧路由的 1M 顶上",
    );
});

test("requestContext() 缺失时回落到表面扫描（兼容旧宿主）", () => {
    const events = {
        1: { seq: 1, type: "user/message", data: {} },
        2: { seq: 2, type: "request/context", data: { contextWindow: 64000 } },
    };
    const session = {
        surface: { nodes: [1, 2] },
        eventAt: (seq) => events[seq],
        seq: 3,
    };
    assert.equal(contextWindowOf(session), 64000, "无 API 时应能从表面读到");
});

test("requestContext() 与表面都没有时，扫全量日志（不只表面）", () => {
    // request/context 在日志里但**不在表面**——旧实现在这里会失败
    const events = {
        1: { seq: 1, type: "user/message", data: {} },
        2: { seq: 2, type: "request/context", data: { contextWindow: 32000 } },
        3: { seq: 3, type: "assistant/message", data: {} },
    };
    const session = {
        surface: { nodes: [1, 3] }, // 注意：2 不在表面
        eventAt: (seq) => events[seq],
        seq: 4,
    };
    assert.equal(contextWindowOf(session), 32000, "必须能扫到不在表面上的 request/context");
});

test("全部缺失时才回落兜底 128000", () => {
    const session = { surface: { nodes: [] }, eventAt: () => undefined, seq: 0 };
    assert.equal(contextWindowOf(session), 128000);
});

test("窗口值非法（0/负数/非数）时继续找下一条，不用非法值", () => {
    const events = {
        1: { seq: 1, type: "request/context", data: { contextWindow: 0 } },
        2: { seq: 2, type: "request/context", data: { contextWindow: 50000 } },
    };
    const session = {
        requestContext: () => ({ contextWindow: -1 }), // API 给了非法值
        surface: { nodes: [1, 2] },
        eventAt: (seq) => events[seq],
        seq: 3,
    };
    assert.equal(contextWindowOf(session), 50000, "非法值必须跳过，继续找有效的");
});

test("窗口随路由变化：始终取最新一条", () => {
    const events = {
        1: { seq: 1, type: "request/context", data: { contextWindow: 1000000 } },
        2: { seq: 2, type: "request/context", data: { contextWindow: 128000 } },
    };
    const session = {
        requestContext: () => ({ contextWindow: 128000 }), // 官方 API 给最新的
        surface: { nodes: [1, 2] },
        eventAt: (seq) => events[seq],
        seq: 3,
    };
    assert.equal(contextWindowOf(session), 128000, "切换模型后必须用新窗口");
});
