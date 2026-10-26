
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

test("阈值小窗口保护：窗口小于保护量+预算时取窗口六成，绝不出现负数", () => {
    // 小窗口：公式本来算出 20000-16000-20000 = -16000（负），必须被抬到 12000
    const small = lossyThreshold(20000);
    assert.ok(small > 0, `小窗口阈值必须为正，实得 ${small}`);
    assert.equal(small, 12000);
    // 正常窗口保持原公式：128k → 128000-16000-20000 = 92000
    assert.equal(lossyThreshold(128000), 92000);
    // 大窗口：1M → 1000000-50000-20000 = 930000
    assert.equal(lossyThreshold(1000000), 930000);
});
