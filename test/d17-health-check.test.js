/**
 * 运行时自检必须能识别"看起来在跑、实际没跑"的状态。
 *
 * 为什么需要这套测试（D17 全部教训）：
 *   这一轮挖出的 10 个 bug 里 8 个是同一形态——日志正常、单测全绿、
 *   不报错，但功能根本没跑。它们不能靠"看有没有报错"发现，
 *   只能靠**计数器**：某层长期为 0、或压力已高却零动作，就是异常信号。
 *
 *   所以自检的价值不在于"能打日志"，而在于**能判出异常并说清哪里异常**。
 *   本文件只测判定逻辑，不测日志格式——格式会变，判定不会。
 *
 * 运行：node --test test/d17-health-check.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectHealth, formatHealth, HealthReporter } from "../src/health-check.js";

/** 造一个健康依赖集（各层都有动作）。 */
function healthyDeps(overrides = {}) {
    return {
        observer: {
            stats: { replaced: 9, bytesSaved: 100000, skipped: 0, failed: 0 },
            done: new Set([1, 2, 3]),
            evicted: new Set([4]),
        },
        engine: {
            lineage: {
                toArray: () => [
                    { id: "L1", replacedBy: "spill-to-disk", newLocation: "/a.txt" },
                    { id: "L2", replacedBy: "lossless-fold", newLocation: "-" },
                ],
            },
        },
        session: { id: "s1" },
        window: 1000000,
        currentTokens: 50000,
        config: { archiveDir: "/tmp/x", auto: true },
        ...overrides,
    };
}

test("一切正常时 status=ok，且各层计数被如实收集", () => {
    const h = collectHealth(healthyDeps());
    assert.equal(h.status, "ok");
    assert.deepEqual(h.problems, []);
    assert.equal(h.window, 1000000);
    assert.equal(h.layers.l12Replaced, 9);
    assert.equal(h.layers.l3Evicted, 1);
    assert.equal(h.layers.spillCount, 1, "只数 spill-to-disk 条目，不数折叠");
    assert.equal(h.layers.lineageEntries, 2);
    assert.equal(h.config.hasArchiveDir, true);
});

test("窗口读数为 0 必须判为异常（D17 曾静默回落 128k）", () => {
    const h = collectHealth(healthyDeps({ window: 0, currentTokens: 0 }));
    assert.equal(h.status, "warn");
    assert.ok(
        h.problems.some((p) => p.includes("窗口读数为 0")),
        `必须报出窗口读数为 0，实得 ${JSON.stringify(h.problems)}`,
    );
});

test("压力 ≥80% 却第 3 层零驱逐、第 1-2 层零处理 → 必须报警（观察者可能没生效）", () => {
    const h = collectHealth(healthyDeps({
        observer: { stats: { replaced: 0, failed: 0 }, done: new Set(), evicted: new Set() },
        engine: { lineage: { toArray: () => [] } },
        window: 24000,
        currentTokens: 20000, // 83%
    }));
    assert.equal(h.status, "warn");
    assert.ok(
        h.problems.some((p) => p.includes("第 3 层零驱逐")),
        `压力 83% 却零动作必须报警，实得 ${JSON.stringify(h.problems)}`,
    );
});

test("第 1-2 层有失败且零成功 → 必须报警（钩子或引擎未接线）", () => {
    const h = collectHealth(healthyDeps({
        observer: { stats: { replaced: 0, failed: 5 }, done: new Set(), evicted: new Set() },
    }));
    assert.equal(h.status, "warn");
    assert.ok(h.problems.some((p) => p.includes("零成功")));
});

test("summaryTarget 只配一半 → 必须报警（会覆盖掉会话路由）", () => {
    const h = collectHealth(healthyDeps({
        config: { archiveDir: "/tmp", summaryTarget: { provider: "p" } }, // 缺 model
    }));
    assert.equal(h.status, "warn");
    assert.ok(h.problems.some((p) => p.includes("只配了一半")));
});

test("summaryTarget 是空对象（未配置的正常结果）不得误报警", () => {
    // schemastery 会把未配置的对象反序列化成 {}，这是正常的，
    // 靠回落会话路由工作——不能因此报警，否则天天误报。
    const h = collectHealth(healthyDeps({
        config: { archiveDir: "/tmp", summaryTarget: {} },
    }));
    assert.equal(h.status, "ok", `空对象是正常反序列化结果，不该报警：${JSON.stringify(h.problems)}`);
});

test("格式化输出必须包含关键计数，便于 grep 与人工扫读", () => {
    const line = formatHealth(collectHealth(healthyDeps()));
    assert.match(line, /window=1000000/);
    assert.match(line, /pressure=5\.0%/);
    assert.match(line, /l12=3\/9repl\/0fail/);
    assert.match(line, /l3=1evict/);
    assert.match(line, /status=ok/);
});

test("自检器必须节流：间隔内不重复输出", () => {
    const lines = [];
    const reporter = new HealthReporter({
        logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) },
        intervalMs: 600000,
        now: () => (reporter._t ??= 0),
    });
    const h = collectHealth(healthyDeps());
    // 用可变时钟模拟
    let t = 0;
    reporter.now = () => t;
    assert.equal(reporter.maybeReport(h), true, "首次必须输出");
    assert.equal(reporter.maybeReport(h), false, "间隔内不得重复输出");
    t += 600001;
    assert.equal(reporter.maybeReport(h), true, "超过间隔必须再输出");
    assert.equal(lines.length, 2);
});

test("状态从 ok 变 warn 必须立即输出，不等间隔（异常要早发现）", () => {
    const lines = [];
    let t = 0;
    const reporter = new HealthReporter({
        logger: { info: (l) => lines.push("I:" + l), warn: (l) => lines.push("W:" + l) },
        intervalMs: 600000,
        now: () => t,
    });
    reporter.maybeReport(collectHealth(healthyDeps())); // ok
    t += 1000; // 远未到间隔
    const warned = reporter.maybeReport(collectHealth(healthyDeps({ window: 0, currentTokens: 0 })));
    assert.equal(warned, true, "状态恶化必须立即输出，不能被节流挡住");
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith("W:"), "异常必须走 warn 级别");
});

test("日志器抛异常时自检器不得抛出（探针不能成为新故障点）", () => {
    const reporter = new HealthReporter({
        logger: {
            info: () => { throw new Error("logger 坏了"); },
            warn: () => { throw new Error("logger 坏了"); },
        },
        intervalMs: 0,
        now: () => 1,
    });
    assert.doesNotThrow(() => {
        reporter.maybeReport(collectHealth(healthyDeps()));
    });
});
