/**
 * M4 单测：软压力 / 有损摘要 / 目标切换旁路 / 熔断器与仲裁器。
 * 对照验收：A3（70%提醒 80% 驱逐、永不清理零丢失）、A4a（预算预留硬验证）、
 * A5（目标切换零 LLM + 胶囊 + 归档）、A7（落盘失败熔断降级主流程不炸）、A10（谱系登记）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pressureAction, evictVolatile, REMIND_RATIO, EVICT_RATIO } from "../src/soft-pressure.js";
import { lossyThreshold, summarizationRequest, summarizeSpan, RESERVE_TOKENS } from "../src/lossy-summarize.js";
import { purgeOnGoalSwitch } from "../src/goal-switch.js";
import { CircuitBreaker, arbitrate } from "../src/circuit-breaker.js";
import { Lineage } from "../src/lineage.js";

test("A3 压力动作：<70% 不动、70-80% 只提醒、≥80% 驱逐", () => {
    assert.equal(pressureAction(0.5), "none");
    assert.equal(pressureAction(REMIND_RATIO), "remind");
    assert.equal(pressureAction(0.79), "remind");
    assert.equal(pressureAction(EVICT_RATIO), "evict");
});

test("A3 驱逐：易失项被驱逐并登记谱系，永不清理项零丢失", () => {
    const lineage = new Lineage();
    const nodes = [
        { seq: 1, kind: "user-message", content: "用户原话" },
        { seq: 2, kind: "todo", content: "待办清单" },
        { seq: 3, kind: "goal", content: "当前目标" },
        { seq: 4, kind: "plan", content: "执行计划" },
        { seq: 5, kind: "summary", content: "上轮摘要" },
        { seq: 6, kind: "tool_output", tool: "pwsh", content: "大输出" },
        { seq: 7, kind: "read", content: "文件内容" },
        { seq: 8, kind: "system-reminder", content: "临时提醒" },
    ];
    // kind 直接用工具名同形（设计稿 §3 按 tool/kind 判）
    nodes[5].kind = "pwsh"; nodes[6].kind = "read"; nodes[7].kind = "system-reminder";
    const { evicted, kept } = evictVolatile(nodes, { lineage });
    // 永不清理 5 项全部保留
    const keptKinds = kept.map((n) => n.kind);
    for (const must of ["user-message", "todo", "goal", "plan", "summary"]) {
        assert.ok(keptKinds.includes(must), `永不清理项 ${must} 被误驱逐`);
    }
    // 易失 3 项全部驱逐且可重放性正确
    assert.equal(evicted.length, 3);
    const bySeq = new Map(evicted.map((e) => [e.seq, e]));
    assert.equal(bySeq.get(6).replayable, false, "pwsh 输出不可重放");
    assert.equal(bySeq.get(7).replayable, true, "read 可重放");
    assert.equal(bySeq.get(8).replayable, false);
    // 驱逐必须全部登记谱系（A10）
    for (const e of evicted) {
        assert.equal(lineage.findByOriginal(`node#${e.seq}`).length, 1);
    }
});

test("A4a 摘要预算预留：阈值公式与请求参数硬验证", () => {
    const window = 128000;
    // 阈值 = 窗口 − max(16k, 5%) − 20k 预留
    assert.equal(lossyThreshold(window), window - Math.max(16000, window * 0.05) - RESERVE_TOKENS);
    const req = summarizationRequest({ provider: "p", model: "m" });
    assert.equal(req.maxTokens, RESERVE_TOKENS, "摘要调用必须显式预留预算（杜绝 2048 截断的根）");
    assert.equal(req.purpose, "compaction");
});

test("A4a+A10 摘要流程：全量存档在先、预算不被篡改、谱系登记", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "lossy-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lineage = new Lineage();
    let captured;
    const fakeLlm = async (req) => { captured = req; return "摘要正文"; };
    const span = [
        { seq: 1, kind: "user-message", content: "问题" },
        { seq: 2, kind: "pwsh", content: "很长的输出".repeat(100) },
    ];
    const result = await summarizeSpan(span, fakeLlm, { archiveDir: dir, lineage, sessionId: "s1" }, { provider: "p", model: "m" });
    assert.equal(result.summary, "摘要正文");
    assert.equal(captured.maxTokens, RESERVE_TOKENS, "传给 LLM 的预算必须是预留值");
    assert.ok(result.archivePath !== "-", "摘要前必须有全量存档");
    const hits = lineage.findByOriginal("session#s1 span[1-2]");
    assert.equal(hits.length, 1, "摘要取代必须登记谱系");
    assert.equal(hits[0].replacedBy, "lossy-summarize");
});

test("A5 目标切换：缺显式信号拒绝、胶囊完整、零 LLM 调用", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "goal-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // 缺显式信号必须抛错（铁律：不做语义自动识别）
    await assert.rejects(() => purgeOnGoalSwitch({ nodes: [] }, { archiveDir: dir }), /缺显式信号/);

    const lineage = new Lineage();
    const event = {
        oldGoalId: "G1",
        newGoalId: "G2",
        nodes: [
            { seq: 1, kind: "todo", content: "旧目标待办1" },
            { seq: 2, kind: "plan", content: "旧目标计划" },
            { seq: 3, kind: "pwsh", content: "过程大输出".repeat(100) },
        ],
    };
    const result = await purgeOnGoalSwitch(event, { archiveDir: dir, lineage });
    assert.equal(result.llmCalls, 0, "目标切换全程零 LLM 调用");
    assert.deepEqual(result.capsule.carriedNodes.map((n) => n.seq), [1, 2], "胶囊必须带走旧目标 todo/plan");
    assert.equal(result.archived.length, 1, "过程内容必须归档");
    assert.equal(lineage.findByOriginal("node#3").length, 1);
});

test("A7 熔断器：连续失败达阈值熔断，冷却后半开试探恢复", async () => {
    let warned = null;
    const breaker = new CircuitBreaker({ name: "spill", threshold: 3, cooldownMs: 1, onOpen: (name, err) => { warned = { name, err }; } });
    const boom = async () => { throw new Error("落盘失败"); };
    for (let i = 0; i < 3; i += 1) {
        assert.equal(await breaker.exec(boom), null, "失败时返回 null 降级");
    }
    assert.equal(breaker.state, "open");
    assert.ok(warned, "熔断必须触发告警回调");
    // open 期冷却未过直接短路（cooldownMs=1，稍等即过）
    assert.equal(await breaker.exec(boom), null);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await breaker.exec(async () => "ok"), "ok", "半开试探成功必须恢复");
    assert.equal(breaker.state, "closed");
});

test("A7 仲裁器：落盘连续失败降级为跳过该层，主流程拿到原文继续", async (t) => {
    // 制造真实写失败：archiveDir 指向「已存在文件路径下的子目录」，mkdir/writeFile 必抛
    const blockerFile = join(tmpdir(), `arb-block-${Date.now()}.txt`);
    const badDir = join(blockerFile, "no-such-dir");
    t.after(() => rm(blockerFile, { force: true }));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(blockerFile, "blocker", "utf8");
    const lineage = new Lineage();
    const breaker = new CircuitBreaker({ name: "spill", threshold: 1, cooldownMs: 60000 });
    const big = "x".repeat(9000); // >8k，必触发落盘
    const r1 = await arbitrate(big, { seq: 1 }, { archiveDir: badDir, lineage, spillBreaker: breaker });
    assert.ok(r1.text === big, "落盘失败时主流程必须拿到原文继续");
    assert.ok(r1.layers.some((l) => l.includes("spill-to-disk")), "层数记录必须体现落盘层被尝试");
    assert.equal(breaker.state, "open", "首败即达阈值，必须熔断");
    const r2 = await arbitrate(big, { seq: 2 }, { archiveDir: badDir, lineage, spillBreaker: breaker });
    assert.ok(r2.layers[0].includes("bypassed"), "熔断后必须显式跳过落盘层");
    assert.equal(r2.text, big, "主流程必须拿到原文继续，绝不被压缩层故障阻断");
});

test("仲裁器短路：折叠后 ≤8k 的内容不再落盘（一层归属唯一）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "arb2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lineage = new Lineage();
    const dup = ("log line\n").repeat(3000); // 26k 全重复，折叠后远小于 8k
    const r = await arbitrate(dup, { seq: 9 }, { archiveDir: dir, lineage });
    assert.deepEqual(r.layers, ["lossless-fold"], "折叠后已达标不得重复落盘");
    assert.ok(r.text.length < 1000, "折叠后文本必须显著缩小");
});
