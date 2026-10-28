/**
 * A8 fixture 重放脚本：对固定样例会话（test/fixture/sample-session.json）
 * 分别以 enabled=false/true 跑前两层管线，输出两轮指标对比。
 *
 * 用法：node test/fixture/replay.js
 * 输出：基线（enabled=false）与实验（enabled=true）的 token 估值均值对比，
 *      供测试员 M5 按 A8 判 PASS/FAIL（token 降 ≥30%）。
 *
 * 口径（与样例会话 JSON 中 metrics_definition 一致）：
 * token 估值 = 字符数 / 4（自算口径；M4 接入 ctx.tokenMeter 后换正式读数，双跑口径一致）。
 * 摘要调用计数：前两层零 LLM，本阶段两轮均应为 0（第 4 层接入后再计）。
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldRepeatedLines, unfold } from "../../src/lossless-fold.js";
import { spillIfNeeded, restoreSpilled } from "../../src/spill-to-disk.js";
import { Lineage } from "../../src/lineage.js";

/** 字符数/4 的 token 估值（fixture 阶段的自算口径）。 */
const tokensOf = (text) => Math.ceil(text.length / 4);

/** 展开样例会话中 content_repeat 定义的重复内容。 */
function expand(step) {
    if (step.content_repeat) {
        return step.content_repeat.unit.repeat(step.content_repeat.times);
    }
    return step.content ?? "";
}

/** 对单步执行前两层（enabled=false 时直通）。 */
async function processStep(step, enabled, archiveDir, lineage) {
    const original = expand(step);
    if (!enabled) return original;
    // 第 1 层：无损折叠
    const { folded, record } = foldRepeatedLines(original);
    // 第 1 层自校验：抽样逆变换（fixture 每步必抽）
    if (record.runs.length > 0) {
        assertReversible(folded, record);
        lineage.record(`sample-session#seq${step.seq}`, `fold:${step.seq}`, "lossless-fold");
    }
    // 第 2 层：落盘（>8k）
    const spill = await spillIfNeeded(folded, archiveDir, `sample-session-seq${step.seq}`);
    if (spill) {
        await restoreSpilled(spill.path, spill.sha256); // 写后即验（保真原则 1）
        lineage.record(`sample-session#seq${step.seq}`, spill.path, "spill-to-disk", spill.sha256);
        return spill.preview;
    }
    return folded;
}

function assertReversible(folded, record) {
    if (unfold(folded, record) !== record.original) {
        throw new Error("fixture 自校验失败：折叠不可逆");
    }
}

const session = JSON.parse(await readFile(new URL("./sample-session.json", import.meta.url), "utf8"));
const baselineDir = await mkdtemp(join(tmpdir(), "replay-baseline-"));
const enabledDir = await mkdtemp(join(tmpdir(), "replay-enabled-"));

try {
    const lineage = new Lineage();
    const baselineContext = [];
    const enabledContext = [];
    for (const step of session.steps) {
        baselineContext.push(await processStep(step, false, baselineDir, lineage));
        enabledContext.push(await processStep(step, true, enabledDir, lineage));
    }
    const mean = (arr) => Math.round(arr.reduce((sum, t) => sum + tokensOf(t), 0) / arr.length);
    const baselineMean = mean(baselineContext);
    const enabledMean = mean(enabledContext);
    const dropPct = Math.round((1 - enabledMean / baselineMean) * 100);
    console.log("=== D13 A8 fixture 重放（M3 前两层范围）===");
    console.log(`基线  enabled=false：token 均值 ${baselineMean}（字符均值 ${Math.round(baselineMean * 4)}）`);
    console.log(`实验  enabled=true ：token 均值 ${enabledMean}（字符均值 ${Math.round(enabledMean * 4)}）`);
    console.log(`上下文 token 降幅：${dropPct}%（M5 验收线 ≥30%）`);
    console.log(`LLM 摘要调用：基线 ${0} 次 / 实验 ${0} 次（前两层零 LLM，第 4 层接入后重新计数）`);
    console.log(`谱系登记 ${lineage.toArray().length} 条（A10 实物可查）`);
} finally {
    await rm(baselineDir, { recursive: true, force: true });
    await rm(enabledDir, { recursive: true, force: true });
}
