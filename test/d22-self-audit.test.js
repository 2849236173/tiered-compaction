/**
 * D22 自身审计问题修复验证。
 *
 * 这四条来自「22 个压缩插件全景对比」审计中指向我们自己代码的发现。
 * 每条都对应一个「静默失效」——功能看着在跑、日志看着正常、实际没做。
 * 所以测试的重点不是「代码能跑」，而是**失效时会不会有人说出来**。
 *
 *   问题 3：外部插件写 engine.config.thresholdRatio，夹取必须留痕
 *   问题 4：摘要请求记下目标模型（可被 purpose='compaction' 改道）
 *   问题 0：preset realm 内另有压缩引擎时必须告警
 *
 * 运行：node --test test/d22-self-audit.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    lossyThreshold,
    setThresholdWarnSink,
    warnClampedRatio,
    resetThresholdWarnings,
    MIN_THRESHOLD_RATIO,
    MAX_THRESHOLD_RATIO,
} from "../src/lossy-summarize.js";

/**
 * 收集告警的 sink 工厂。
 * @returns {{messages: string[], sink: (m: string) => void}}
 */
function collector() {
    const messages = [];
    return { messages, sink: (m) => messages.push(m) };
}

/* ---------------- 问题 3：阈值夹取必须留痕 ---------------- */

test("D22-3 外部把 ratio 改成 0.17（session-manager 滑块最左）时必须告警", () => {
    resetThresholdWarnings();
    const { messages, sink } = collector();

    // 这就是 dsh-session-manager 会做的事：直接写 config.thresholdRatio
    const applied = lossyThreshold(1000000, { thresholdRatio: 0.17 });

    // 阈值仍然被夹到合法区间（行为不变，防抢跑第 3 层）
    assert.equal(applied, Math.floor(1000000 * MIN_THRESHOLD_RATIO));

    // 但夹取这件事必须说出来——把 sink 换成收集器再调一次才能验证文案
    resetThresholdWarnings();
    const { messages: m2, sink: s2 } = collector();
    warnClampedRatio(0.17, MIN_THRESHOLD_RATIO, s2);
    assert.equal(m2.length, 1, "夹取必须产生一条告警");
    assert.match(m2[0], /0\.17/, "告警里要出现用户设的原值");
    assert.match(m2[0], /0\.82/, "告警里要出现实际生效值");
    void messages;
    void sink;
});

test("D22-3 夹取告警去重：同一个错误值只报一次，不刷屏", () => {
    resetThresholdWarnings();
    const { messages, sink } = collector();

    warnClampedRatio(0.5, MIN_THRESHOLD_RATIO, sink);
    warnClampedRatio(0.5, MIN_THRESHOLD_RATIO, sink);
    warnClampedRatio(0.5, MIN_THRESHOLD_RATIO, sink);

    assert.equal(messages.length, 1, "同一组合重复调用只应告警一次");
});

test("D22-3 合法值不告警（正常路径必须安静）", () => {
    resetThresholdWarnings();
    const { messages, sink } = collector();

    warnClampedRatio(0.85, 0.85, sink);
    assert.equal(messages.length, 0, "未夹取时不应产生任何告警");
});

test("D22-3 上下界都夹得住：越界值不会原样生效", () => {
    resetThresholdWarnings();
    const W = 1000000;

    // 核心断言：越界值绝不会被当成合法值使用。
    // 为什么不断言精确数字：lossyThreshold 在 [lowerEdge, upperEdge] 之间有
    // 线性插值过渡带（消断崖），100 万窗口正好落在带内，结果是插值而非简单取小。
    // 断言精确值会把测试钉死在某个插值实现上——那是实现细节，不是契约。
    const upper = lossyThreshold(W, { thresholdRatio: 1.5 });
    const lower = lossyThreshold(W, { thresholdRatio: 0.2 });

    // 1.5 若被原样使用会算出 150 万（超过窗口），必须被夹到窗口内
    assert.ok(upper < W, `越上界的 ratio 必须夹到窗口内，实际 ${upper}`);
    assert.ok(upper > Math.floor(W * 0.82), "越上界的结果仍应高于层次底线");

    // 0.2 若被原样使用会算出 20 万，必须被抬到不抢跑第 3 层的水平
    assert.equal(lower, Math.floor(W * MIN_THRESHOLD_RATIO), "越下界必须抬到 0.82");

    // 边界内原样生效（无插值干扰的窗口下取比例线）
    assert.equal(lossyThreshold(2000000, { thresholdRatio: 0.9 }), Math.floor(2000000 * 0.9));
});

test("D22-3 setThresholdWarnSink 可把告警接进宿主 logger", () => {
    resetThresholdWarnings();
    const { messages, sink } = collector();
    setThresholdWarnSink(sink);

    // 走真实入口：lossyThreshold 内部会调用 warnClampedRatio（默认 sink 已被替换）
    lossyThreshold(1000000, { thresholdRatio: 0.1 });

    assert.ok(messages.length >= 1, "注入 sink 后夹取告警应能到达宿主");
    setThresholdWarnSink(() => {});
});

/* ---------------- 问题 4：摘要请求必须记下目标模型 ---------------- */

test("D22-4 摘要请求带 purpose=compaction（这是被路由插件改道的条件）", () => {
    const source = readFileSync(new URL("../src/contract.js", import.meta.url), "utf8");

    // purpose 是这个钩子的契约：dsh-auxiliary / dsh-compact-selected-model 都按它改道
    assert.match(source, /purpose:\s*"compaction"/, "摘要请求必须带 purpose: \"compaction\"");

    // 并且必须有一条日志记下实际目标模型，否则改道后无从追溯
    assert.match(
        source,
        /第 4 层摘要请求/,
        "发摘要前必须记录目标 provider/model，否则被改道后无法排查"
    );
});

/* ---------------- 问题 0：preset realm 内另有引擎必须告警 ---------------- */

test("D22-0 插件入口必须做 preset 共存检测", () => {
    const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

    // 检测函数必须存在并被调用——这是「装了但没用」唯一的可见化手段
    assert.match(source, /function reportCoexistingEngines/, "必须有 preset 共存检测函数");
    assert.match(source, /await reportCoexistingEngines\(ctx\)/, "检测必须在 apply 里真被调用");

    // 告警文案必须说清后果，否则用户看不懂
    assert.match(source, /实际压缩由 preset 内引擎执行/, "告警要说清「实际不是本插件在压」");
});

test("D22-0 检测逻辑：只对「自带 compaction 组」的 preset 告警", () => {
    const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

    // 判据是 id === 'compaction' 的组条目（shipped preset 的真实形状）
    assert.match(source, /entry\?\.id === "compaction"/, "必须按 id 识别 compaction 组");

    // 必须读 config.plugins（对象字段），而不是误以为它是数组字段
    assert.match(source, /row\?\.config\?\.plugins/, "必须从 config.plugins 读 preset 插件列表");
});

test("D22-0 宿主 patch 递归限制的证据仍在（这是问题 0 的根因）", () => {
    // 这条不测我们的代码，测「我们依赖的宿主行为没变」。
    // 若哪天宿主把 buildMap 改成递归所有 config，问题 0 自动消失，
    // 这条会变红，提醒我们回来复核告警是否还需要。
    const bootPath = "G:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js";
    let source;
    try {
        source = readFileSync(bootPath, "utf8");
    } catch {
        // 宿主不在预期位置（CI / 他人机器）：跳过而不是失败
        return;
    }
    assert.match(
        source,
        /entry\.group && Array\.isArray\(entry\.config\)/,
        "宿主 buildMap 仍只递归 group+数组；若已放宽，preset 告警需要重新评估"
    );
});
