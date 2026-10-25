/**
 * M6 真实链路观测（A4b / A8）— 运维对接员 2026-10-26
 *
 * 与 M5 的 fixture 阶段不同，这里用**真实 LLM** 做第 4 层摘要，
 * 观测：①真实摘要是否被触发调用；②预算预留（RESERVE_TOKENS=20k）是否生效；
 * ③摘要前后谱系是否登记；④全量存档是否落盘。
 *
 * 用法：node test/m6-real-llm.mjs
 * 凭据：从宿主 .credentials.yaml 注入的 DEEPSEEK_API_KEY 环境变量读取。
 */

import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TieredCompactionEngine } from "../src/engine.js";
import { lossyThreshold, RESERVE_TOKENS } from "../src/lossy-summarize.js";

const API_KEY = process.env.DEEPSEEK_API_KEY;
const results = [];
function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? "✔" : "✖"} ${name}${detail ? " — " + detail : ""}`);
}

if (!API_KEY) {
    console.log("✖ 缺少 DEEPSEEK_API_KEY，真实链路观测无法进行");
    console.log("（这是凭据缺口，不是插件缺陷 —— 见安装记录 §4）");
    process.exit(2);
}

/** 极简真实摘要实现：调 DeepSeek 官方接口。 */
async function realSummarizeFn(req, text, signal) {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
            model: "deepseek-chat",
            max_tokens: req.maxTokens,
            messages: [
                {
                    role: "system",
                    content:
                        "你是会话压缩器。把给定历史压缩成摘要，保留：用户目标、已完成结论、待办、关键文件名与数字。不要臆造。",
                },
                { role: "user", content: text },
            ],
        }),
        signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content ?? "";
}

const dir = await mkdtemp(join(tmpdir(), "m6-real-"));
console.log(`存档目录：${dir}\n`);

let calls = 0;
const countingFn = async (req, text, signal) => {
    calls++;
    return realSummarizeFn(req, text, signal);
};

// 造一段够长的历史区间（模拟真实会话历史）——必须是数组，summarizeSpan 按节点遍历
const span = Array.from({ length: 24 }, (_, i) => ({
    seq: i + 1,
    kind: "tool",
    tool: "read",
    content: `第 ${i + 1} 段：读取文件 src/module-${i}.js，返回内容较长，包含函数定义与注释若干行。`,
}));

console.log("=== A4b 阈值与预算 ===");
const WINDOW = 128_000;
const threshold = lossyThreshold(WINDOW);
record(
    "A4b-1 阈值公式 = 窗口 − max(16k,5%) − 预留",
    threshold === WINDOW - Math.max(16000, Math.floor(WINDOW * 0.05)) - RESERVE_TOKENS,
    `window=${WINDOW}, threshold=${threshold}, reserve=${RESERVE_TOKENS}`
);

// 未到阈值：不该调用摘要
const lowMeter = { contextWindow: () => WINDOW, currentTokens: () => 10_000 };
const engineLow = new TieredCompactionEngine({
    archiveDir: dir,
    tokenMeter: lowMeter,
    summarizeFn: countingFn,
    summaryTarget: { provider: "deepseek", model: "deepseek-chat" },
    logger: { info() {}, warn() {} },
});
const before = calls;
const skipped = await engineLow.summarizeIfNeeded(span);
record(
    "A4b-2 未到阈值时不触发摘要（零 LLM 调用）",
    skipped === null && calls === before,
    `result=${skipped}, calls=${calls - before}`
);

// 到阈值：应真实调用摘要，预算受限
const highMeter = { contextWindow: () => WINDOW, currentTokens: () => threshold + 5_000 };
const engine = new TieredCompactionEngine({
    archiveDir: dir,
    tokenMeter: highMeter,
    summarizeFn: countingFn,
    summaryTarget: { provider: "deepseek", model: "deepseek-chat" },
    logger: { info() {}, warn() {} },
});

console.log("\n=== A8 真实链路：触发真实 LLM 摘要 ===");
const t0 = Date.now();
const out = await engine.summarizeIfNeeded(span);
const ms = Date.now() - t0;

record(
    "A8-1 到阈值后真实调用摘要 LLM",
    calls > before && Boolean(out?.summary),
    `calls=${calls}, summaryLen=${out?.summary?.length ?? 0}, ${ms}ms`
);
record(
    "A8-2 摘要预算 ≤ 预留（未超 20k）",
    out?.budget <= RESERVE_TOKENS,
    `budget=${out?.budget}, reserve=${RESERVE_TOKENS}`
);

// 全量存档落盘
const files = await readdir(dir, { recursive: true }).catch(() => []);
record("A8-3 摘要前全量存档已落盘", files.length > 0, `archive files=${files.length}`);

// 谱系登记
record(
    "A10 真实链路谱系已登记",
    engine.status().lineageEntries > 0,
    `lineageEntries=${engine.status().lineageEntries}`
);

console.log("\n=== 摘要样例（前 240 字）===");
console.log((out?.summary ?? "").slice(0, 240));

await rm(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
}
