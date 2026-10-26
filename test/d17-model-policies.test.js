/**
 * modelPolicies：按模型分别设阈值（D17 对照原版 basic 补齐的能力）。
 *
 * 为什么需要这一层：
 *   不同模型窗口差 8 倍以上（128k vs 1M）。一套全局 headroom 必然对某一端
 *   不合适——对小窗口是灾难（余量吃掉全部预算），对 1M 窗口又过于保守
 *   （等到很晚才压）。原版 basic 用 modelPolicies 精确覆盖解决，我们照此补齐。
 *
 * 解析规则（本测试锁定的语义）：
 *   - 无 modelPolicies → 全部走全局值
 *   - 有匹配项 → 该模型的字段覆盖全局；未写的字段仍回落全局
 *   - 无匹配项 → 回落全局
 *   - 路由信息缺失（provider/model 不全）→ 回落全局，不抛错
 *
 * 运行：node --test test/d17-model-policies.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TieredCompactionEngineService } from "../src/contract.js";
import { HEADROOM_TOKENS } from "../src/lossy-summarize.js";

/**
 * 只测 policyFor 这一层，不构造完整 cordis Service。
 * 用原型上的方法 + 最小 this 桩，避免把 Service 的依赖面拖进来。
 */
function policyFor(config, target) {
    const fakeThis = { config };
    return TieredCompactionEngineService.prototype.policyFor.call(fakeThis, target);
}

test("无 modelPolicies：全部走全局默认值", () => {
    const p = policyFor({}, { provider: "a", model: "b" });
    assert.equal(p.thresholdRatio, 0.85, "默认阈值占比 0.85");
    assert.equal(p.headroomTokens, HEADROOM_TOKENS, "默认 headroom 取原版 65536");
    assert.equal(p.maxOverflowRetries, 1, "默认重试 1 次（对齐原版，不是旧的 3）");
});

test("全局值可配：覆盖默认", () => {
    const p = policyFor(
        { thresholdRatio: 0.9, headroomTokens: 32768, maxOverflowRetries: 2 },
        { provider: "a", model: "b" },
    );
    assert.equal(p.thresholdRatio, 0.9);
    assert.equal(p.headroomTokens, 32768);
    assert.equal(p.maxOverflowRetries, 2);
});

test("精确匹配：命中项的字段覆盖全局", () => {
    const config = {
        thresholdRatio: 0.85,
        headroomTokens: 65536,
        modelPolicies: [
            { provider: "small", model: "8k", thresholdRatio: 0.8, headroomTokens: 4096 },
        ],
    };
    const hit = policyFor(config, { provider: "small", model: "8k" });
    assert.equal(hit.thresholdRatio, 0.8, "命中项阈值覆盖");
    assert.equal(hit.headroomTokens, 4096, "命中项 headroom 覆盖");
    assert.equal(hit.maxOverflowRetries, 1, "未写的字段回落全局默认");
});

test("部分字段覆盖：只写 headroom 时其余仍取全局", () => {
    const config = {
        thresholdRatio: 0.9,
        modelPolicies: [{ provider: "p", model: "m", headroomTokens: 8192 }],
    };
    const p = policyFor(config, { provider: "p", model: "m" });
    assert.equal(p.headroomTokens, 8192, "覆盖了 headroom");
    assert.equal(p.thresholdRatio, 0.9, "没写的 thresholdRatio 仍取全局");
});

test("无匹配项：回落全局，不抛错", () => {
    const config = {
        thresholdRatio: 0.88,
        modelPolicies: [{ provider: "other", model: "model", thresholdRatio: 0.5 }],
    };
    const p = policyFor(config, { provider: "a", model: "b" });
    assert.equal(p.thresholdRatio, 0.88, "不该误用别的模型的策略");
});

test("路由缺失：回落全局，绝不抛错（会话早期没有 requestHeader）", () => {
    const config = {
        thresholdRatio: 0.85,
        modelPolicies: [{ provider: "a", model: "b", thresholdRatio: 0.5 }],
    };
    for (const target of [undefined, null, {}, { provider: "a" }, { model: "b" }]) {
        const p = policyFor(config, target);
        assert.equal(p.thresholdRatio, 0.85, `target=${JSON.stringify(target)} 应回落全局`);
    }
});

test("数组顺序即优先级：同 provider/model 重复时先用第一个", () => {
    const config = {
        modelPolicies: [
            { provider: "a", model: "b", thresholdRatio: 0.8 },
            { provider: "a", model: "b", thresholdRatio: 0.9 },
        ],
    };
    assert.equal(policyFor(config, { provider: "a", model: "b" }).thresholdRatio, 0.8);
});

test("策略真的影响阈值：小窗口模型能被压得更早", () => {
    // 同一窗口下，headroom 变小会让阈值占比上升（装得下更多）
    const wide = policyFor({ modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.85 }] }, { provider: "p", model: "m" });
    const tight = policyFor({ modelPolicies: [{ provider: "p", model: "m", thresholdRatio: 0.95 }] }, { provider: "p", model: "m" });
    assert.ok(tight.thresholdRatio > wide.thresholdRatio, "覆盖值必须真的生效");
});
