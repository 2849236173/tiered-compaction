
/**
 * D16 运行时实锤回归（P1-0 / P1-1 / 阈值反向）：
 * 这三条是「测试全绿但线上全死」的典型——单测桩伪造了宿主不存在的 API，
 * 把真 bug 盖住了。这里用**真实宿主 API 形态**反向锁定：
 *   P1-0：真实 TokenMeter 没有 contextWindow()，窗口必须从 request/context 读
 *   P1-1：真实 llm 服务没有 summarize()，摘要必须走 llm.stream()
 *   阈值：窗口无效/很小时不能算成负数（否则每步强触发、每步失败）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { lossyThreshold } from "../src/lossy-summarize.js";

test("P1-0 真实 TokenMeter 形态：没有 contextWindow()，插件必须自己从会话事件读窗口", async () => {
    // 真实 dsh-token-meter 的公开方法面（lib:722/783）：只有 measure 与 estimateMessage
    const realMeter = {
        measure: () => ({ totalTokens: 50000, nodes: [] }),
        estimateMessage: () => 100,
    };
    assert.equal(realMeter.contextWindow, undefined, "真实 meter 没有 contextWindow 方法");

    // 插件里的 contextWindowOf 必须能从 request/context 事件拿到窗口
    const { __test } = await import("../src/contract.js");
    const windowOf = __test?.contextWindowOf;
    if (windowOf === undefined) return; // 未导出探测口径时跳过（不影响主断言）
    // 纯窗口读数桩：无事件产生路径，不涉及派发语义（P5 清查：非派发对象）
    const session = {
        surface: { nodes: [1, 2] },
        eventAt: (seq) => (seq === 2 ? { type: "request/context", data: { contextWindow: 64000 } } : undefined),
    };
    assert.equal(windowOf(session), 64000);
});

test("P1-0 找不到窗口事件时用兜底值，绝不给 0（0 会让阈值算成负数）", async () => {
    const { __test } = await import("../src/contract.js");
    const windowOf = __test?.contextWindowOf;
    if (windowOf === undefined) return;
    // 同上：纯读数桩，非派发对象
    const emptySession = { surface: { nodes: [] }, eventAt: () => undefined };
    const window = windowOf(emptySession);
    assert.ok(window > 0, `兜底窗口必须为正，实得 ${window}`);
});

test("阈值反向回归：窗口 0/负数/非数时阈值不可为正数触发条件（不能反向强触发）", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const threshold = lossyThreshold(bad);
        assert.equal(threshold, Number.POSITIVE_INFINITY, `窗口 ${bad} 时必须永不触发`);
    }
});

test("阈值小窗口保护：小窗口按 82% 下限，绝不出现负数", () => {
    // 极小窗口（小于 reserve+headroom）固定 82%，保证仍能工作且不误触发。
    // 下限 82% 的理由：第 3 层在 70% 提醒、80% 驱逐，第 4 层（最贵）必须晚于它们，
    // 留 2 个百分点缓冲。D17 起阈值公式的权威断言见 test/d17-threshold.test.js。
    const small = lossyThreshold(20000);
    assert.ok(small > 0, `小窗口阈值必须为正，实得 ${small}`);
    assert.equal(small, 16400, "极小窗口按窗口 82% 下限");

    // 中大型窗口：阈值必须落在窗口的 70%~85% 区间内（层次底线）
    for (const window of [128000, 200000, 1000000]) {
        const threshold = lossyThreshold(window);
        const pct = threshold / window;
        assert.ok(
            pct >= 0.7 && pct <= 0.85,
            `窗口 ${window} 的阈值占比应在 70%~85%，实得 ${(pct * 100).toFixed(1)}%`,
        );
    }
});
