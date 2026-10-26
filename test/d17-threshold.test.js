/**
 * D17 阈值公式（第 4 层触发线）——**唯一权威断言**。
 *
 * 背景（对照原版 dsh-compaction-basic 后的择优结论）：
 *
 *   原版：`min(窗口 × thresholdRatio, 窗口 − 输出预留 − headroom)`
 *         ratio 默认 0.85、headroom 65536。
 *         优点：大窗口按比例封顶，压缩及时。
 *         缺点：窗口 < reserve+headroom 时压力预算为负，直接抛
 *               TargetPressureConfigError——小模型根本用不了。
 *
 *   旧公式：`窗口 − max(16k, 5%) − 20k`（纯绝对值）。
 *         优点：小窗口不炸。
 *         缺点：1M 窗口要等到 93% 才压，留给压缩事务的空间被压到极限。
 *
 *   现公式（本文测试的对象）：
 *     - 窗口 ≤ reserve+headroom  → 固定 60%（极小窗口仍可工作）
 *     - reserve+headroom < 窗口 < (reserve+headroom)/(1−ratio)
 *       → 占比在 [60%, ratio] 之间线性过渡（消除断崖）
 *     - 窗口 ≥ 上述上沿 → 窗口 × ratio（85%）
 *
 * 为什么必须有过渡带（实测驱动，不是理论洁癖）：
 *   最初写成「装得下 85%、装不下 60%」的二选一，实测发现窗口
 *   85536 → 85537（只差 1 个 token）阈值占比从 60% 跳到 85%——
 *   加一个 token 就换了整套压缩策略，属于不可接受的断崖。
 *
 * 运行：node --test test/d17-threshold.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { lossyThreshold, RESERVE_TOKENS, HEADROOM_TOKENS } from "../src/lossy-summarize.js";

const EDGE_LOW = RESERVE_TOKENS + HEADROOM_TOKENS;              // 85536
const EDGE_HIGH = Math.ceil(EDGE_LOW / (1 - 0.85));             // ≈ 570240
/** 第 4 层下限占比：必须晚于第 3 层的 80% 驱逐（四层递进底线）。 */
const FLOOR_RATIO = 0.82;

test("窗口无效时返回 Infinity：绝不反向强触发", () => {
    for (const bad of [0, -1, -100000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.equal(lossyThreshold(bad), Number.POSITIVE_INFINITY, `窗口 ${bad} 必须永不触发`);
    }
});

test("极小窗口按 82% 下限：永不早于第 3 层 80% 驱逐", () => {
    for (const window of [8000, 20000, 64000, EDGE_LOW]) {
        const threshold = lossyThreshold(window);
        assert.equal(threshold, Math.floor(window * FLOOR_RATIO), `窗口 ${window} 应按下限 82%`);
        // 用乘法比较而非除法：6560/8000 在浮点下是 0.8199999…，除法断言会假失败
        assert.ok(threshold >= Math.floor(window * 0.8) + 1, "绝不能抢在第 3 层 80% 驱逐之前");
    }
});

test("大窗口落到比例线 85%", () => {
    for (const window of [EDGE_HIGH, 1000000, 2000000]) {
        assert.equal(lossyThreshold(window), Math.floor(window * 0.85), `窗口 ${window} 应为 85%`);
    }
});

test("阈值随窗口单调递增：不允许「窗口更大反而更早压」", () => {
    let previous = -1;
    for (let window = 8000; window <= 2000000; window += 8000) {
        const threshold = lossyThreshold(window);
        assert.ok(
            threshold > previous,
            `窗口 ${window} 的阈值 ${threshold} 必须大于前一个 ${previous}`,
        );
        previous = threshold;
    }
});

test("过渡带无断崖：相邻 1 token 的占比变化必须极小", () => {
    for (const edge of [EDGE_LOW, EDGE_HIGH]) {
        for (let window = edge - 3; window <= edge + 3; window += 1) {
            const a = lossyThreshold(window) / window;
            const b = lossyThreshold(window + 1) / (window + 1);
            assert.ok(
                Math.abs(b - a) < 0.01,
                `窗口 ${window}→${window + 1} 占比跳变 ${(Math.abs(b - a) * 100).toFixed(2)} 个百分点，超过 1%`,
            );
        }
    }
});

test("层次不抢跑：第 4 层阈值永远不早于第 3 层的 70% 提醒/80% 驱逐", () => {
    // 这条是本公式最硬的约束：四层必须递进，轻量手段先上，最贵的一层最后。
    // 实测教训：过渡带初版下限取 60%，导致 100k→60.7%、200k→65.9%，
    // 有损摘要在第 3 层提醒之前就启动——被 A12② 直接抓出。
    for (let window = 8000; window <= 2000000; window += 4000) {
        const pct = lossyThreshold(window) / window;
        assert.ok(
            pct >= 0.7,
            `窗口 ${window} 的第 4 层占比 ${(pct * 100).toFixed(2)}% 早于第 3 层 70% 提醒`,
        );
        assert.ok(
            pct <= 0.85 + 1e-9,
            `窗口 ${window} 占比 ${(pct * 100).toFixed(2)}% 高于 85%`,
        );
    }
});

test("摘要预算预留与 headroom 为设计常量，不随窗口漂移", () => {
    assert.equal(RESERVE_TOKENS, 20000, "摘要输出预算必须固定 20k（A4a 硬验证项）");
    assert.equal(HEADROOM_TOKENS, 65536, "压缩余量取原版 basic 默认值，不自行发明");
});
