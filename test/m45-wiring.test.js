/**
 * M4.5 wiring 验收（A-wire 四条）：
 * ① enabled=false 行为与 M2 骨架逐字一致（仅注册自检服务，不触碰 compaction 位）；
 * ② enabled=true 且槽位空闲时 ctx.compaction 被本插件接管（真实 cordis 语义验证）；
 * ③ 前三层各一例经 engine 端到端跑通；第 4 层由 contract.js 真实事务覆盖；
 * ④ 熔断器落盘失败降级不炸（复用 M4「文件当父目录」造失败法）。
 *
 * 用真实 cordis Context（new Context()）做宿主桩——construction-catch 探测
 * 的报错路径必须走真实 provide 冲突语义，stub 模拟不出（M2 旧 stub 不构造
 * Service，绕过了整条探测链）。
 *
 * 运行：node --test test/m45-wiring.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";

import { apply } from "../src/index.js";
import { Lineage } from "../src/lineage.js";

/** A-wire ①：enabled=false 与 M2 骨架行为逐字一致。 */
test("A-wire① enabled=false：仅注册自检服务，不触碰 compaction 位", async () => {
    const ctx = new Context();
    // D21：默认值已改为 true（装上即生效）。要与 basic 并存必须显式关闭。
    await apply(ctx, { enabled: false });
    // 自检服务以 tieredCompaction 名注册（ctx 上可读，A6 口径）
    assert.ok(ctx.tieredCompaction, "必须注册 tieredCompaction 自检服务");
    assert.equal(ctx.tieredCompaction.config.enabled, false);
    assert.equal(ctx.compaction, undefined, "绝不触碰 compaction 服务位");
});

/** A-wire ②：enabled=true 且槽位空闲，compaction 服务位被本插件接管。
 *  A12 起接管服务 = 契约层（contract.js）：CompactionEngine 基类 + 三入口 + 自动钩子。
 *  cordis 实测坑：static inject（llm/tokenMeter/sessions）必须由 Service 提供——
 *  裸属性不满足注入条件，服务会永久挂起不构造，本测试以 Service 桩补齐注入面。 */
test("A-wire② enabled=true：compaction 服务位被本插件接管", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "wire2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const ctx = new Context();
    const { Service } = await import("@deepseek-ai/cordis");
    class MeterStub extends Service { constructor(c) { super(c, "tokenMeter"); } }
    class LlmStub extends Service { constructor(c) { super(c, "llm"); } }
    class SessionsStub extends Service { constructor(c) { super(c, "sessions"); } }
    await ctx.plugin(MeterStub, {});
    await ctx.plugin(LlmStub, {});
    await ctx.plugin(SessionsStub, {});
    await apply(ctx, { enabled: true, archiveDir: dir });
    const svc = ctx.compaction;
    assert.ok(svc, "compaction 服务位必须被本插件接管");
    assert.equal(svc.config.enabled, true);
    // 契约面（A12）：宿主三入口必须存在
    for (const m of ["compactNow", "compactIfNeeded", "compactRegion", "summarize"]) {
        assert.equal(typeof svc[m], "function", `契约入口 ${m} 必须存在`);
    }
    assert.equal(svc.config.bypassMode, false, "槽位空闲时不得处于旁路模式");
});

/**
 * A-wire ②b：槽位被占（先注册占位引擎）→ construction-catch 降级旁路模式，
 * bypassMode 显式置位、不抛出（真实 cordis provide 冲突语义）。
 */
test("A-wire②b 槽位冲突：construction-catch 降级旁路模式", async (t) => {
    const { Service } = await import("@deepseek-ai/cordis");
    const ctx = new Context();
    // 预占 compaction 槽：占位引擎（构造即 provide 'compaction'）
    class Occupier extends Service {
        constructor(c, cfg) { super(c, "compaction"); this.cfg = cfg; }
    }
    await ctx.plugin(Occupier, {});
    assert.ok(ctx.compaction, "预占必须成功");
    // 契约层的 inject 面（llm/tokenMeter/sessions）也要有 Service 桩，
    // 否则 construction-catch 前的注入解析挂起，探测不到降级路径
    const { Service: Svc } = await import("@deepseek-ai/cordis");
    class MeterStub extends Svc { constructor(c) { super(c, "tokenMeter"); } }
    class LlmStub extends Svc { constructor(c) { super(c, "llm"); } }
    class SessionsStub extends Svc { constructor(c) { super(c, "sessions"); } }
    await ctx.plugin(MeterStub, {});
    await ctx.plugin(LlmStub, {});
    await ctx.plugin(SessionsStub, {});
    const dir = await mkdtemp(join(tmpdir(), "wire2b-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // 本插件 enabled=true 撞上已占槽位：必须降级而非抛错
    await apply(ctx, { enabled: true, archiveDir: dir });
    const bypass = ctx.tieredCompaction;
    assert.ok(bypass, "降级后必须注册旁路自检服务");
    assert.equal(bypass.bypassMode, true, "bypassMode 必须显式置位");
    assert.equal(bypass.config.bypassMode, true);
    // 槽被占后 compaction 位仍归占位者（本插件未接管）：契约层构造抛错被
    // construction-catch 捕获降级，占位者的 compaction 服务保持不动
    assert.ok(ctx.compaction, "槽被占后 compaction 位仍归占位者");
    assert.notEqual(ctx.compaction.constructor?.name, "TieredCompactionEngineService", "接管不得发生");
});

/** A-wire ③：四层各一例经 engine 端到端跑通（fixture 重放口径）。 */
test("A-wire③ 前三层经 engine 端到端", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "wire3-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { TieredCompactionEngine } = await import("../src/engine.js");
    const engine = new TieredCompactionEngine({ archiveDir: dir });

    // 第 1 层：重复日志折叠（fixture seq1 形状）
    const log = ["build start", ...Array(8).fill("2026-10-26 INFO heartbeat"), "build done"].join("\n");
    const r1 = await engine.processToolOutput(log, { seq: 1 });
    assert.ok(r1.layers.includes("lossless-fold"), "第 1 层必须命中");
    assert.ok(r1.text.includes("…[folded"), "重复块必须被折叠");
    assert.ok(engine.lineage.toArray().some((e) => e.replacedBy === "lossless-fold"), "谱系登记");

    // 第 2 层：>8k 落盘（fixture seq2 形状：12k 大输出）
    const big = "The quick brown fox jumps over the lazy dog. ".repeat(240);
    const r2 = await engine.processToolOutput(big, { seq: 2 });
    assert.ok(r2.layers.includes("spill-to-disk"), "第 2 层必须命中");
    assert.ok(r2.text.length <= 5120, "预览必须 ≤5120（D20 对齐原版 pruner 预算）");
    const entry = engine.lineage.toArray().find((e) => e.replacedBy === "spill-to-disk");
    assert.ok(entry?.digest, "落盘必须带 SHA-256 谱系");

    // 第 3 层：70% 提醒 / 80% 驱逐
    const window = 1000;
    const meter = (cur) => ({ currentTokens: () => cur, contextWindow: () => window });
    const nodes = [
        { seq: 10, kind: "todo", content: "待办" },
        { seq: 11, kind: "pwsh", content: "大输出" },
        { seq: 12, kind: "read", content: "文件" },
    ];
    const r3a = await new TieredCompactionEngine({ archiveDir: dir, tokenMeter: meter(700) }).applySoftPressure(nodes);
    assert.equal(r3a.action, "remind", "70% 必须只提醒");
    assert.ok(r3a.reminder.includes("70%"));
    // 80% 驱逐 + 谱系登记（同一 engine 的谱系表可查）
    const engine3b = new TieredCompactionEngine({ archiveDir: dir, tokenMeter: meter(850) });
    const r3b = await engine3b.applySoftPressure(nodes);
    assert.equal(r3b.action, "evict", "80% 必须驱逐");
    // A-P0-4（2026-10-27 系统审计）：只有可重放的 read 能动；
    // pwsh 输出不可重放且无存档，驱逐它等于永久丢数据。
    assert.deepEqual(r3b.evicted.map((e) => e.seq).sort(), [12], "只有可重放的 read 可驱逐");
    assert.ok(engine3b.lineage.toArray().some((e) => e.replacedBy === "soft-pressure"), "驱逐登记谱系");

    // 第 4 层由 contract.js 的真实事务路径负责；engine 不提供该摘要入口。
    assert.ok(engine.status().lineageEntries > 0, "谱系表贯穿可查");


    // 旁路：目标切换零 LLM（显式信号才执行）
    const r5 = await engine.purgeOnGoalSwitch({ oldGoalId: "g1", newGoalId: "g2", nodes: [{ seq: 20, kind: "goal", content: "旧目标" }] });
    assert.equal(r5.llmCalls, 0);
    assert.equal(r5.capsule.carriedNodes.length, 1);
    await assert.rejects(engine.purgeOnGoalSwitch({ nodes: [] }), /显式信号/, "无显式信号拒绝");
});

/**
 * A-wire ④：熔断器落盘失败降级不炸——经 engine 主入口复现 M4 造失败法
 * （archiveDir 指向「已存在文件路径下的子目录」）。
 */
test("A-wire④ 熔断器落盘失败降级不炸", async (t) => {
    const blockerFile = join(tmpdir(), `wire-block-${Date.now()}.txt`);
    const badDir = join(blockerFile, "no-such-dir");
    await writeFile(blockerFile, "blocker", "utf8");
    t.after(() => rm(blockerFile, { force: true }));
    const { TieredCompactionEngine } = await import("../src/engine.js");
    const engine = new TieredCompactionEngine({ archiveDir: badDir });
    const big = "x".repeat(9000); // >8k 必触发落盘
    // 默认阈值 3：三次失败内主流程每次都拿原文，绝不炸
    for (let i = 1; i <= 3; i += 1) {
        const r = await engine.processToolOutput(big, { seq: i });
        assert.equal(r.text, big, `第 ${i} 次失败：主流程拿到原文`);
    }
    assert.equal(engine.status().spillBreaker, "open", "三连败后熔断器必须 open");
    const rAfter = await engine.processToolOutput(big, { seq: 4 });
    assert.equal(rAfter.text, big, "熔断后：主流程仍拿原文，不炸");
    assert.ok(rAfter.layers.some((l) => l.includes("bypassed")), "必须显式记录熔断跳过");
});

/** 谱系表独立可查（A10 贯穿口径的补充确认）。 */
test("A-wire 补充：Lineage 基础可查", () => {
    const l = new Lineage();
    l.record("a", "-", "lossless-fold");
    assert.equal(l.findByOriginal("a").length, 1);
});
