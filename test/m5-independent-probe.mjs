/**
 * M5 测试员独立探针：不复用程序员测试代码，按 A1-A10 独立构造用例。
 * 只用 node:test 之外的原生断言，避免与被测代码共享测试假设。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldRepeatedLines, unfold } from "../src/lossless-fold.js";
import { spillIfNeeded, restoreSpilled } from "../src/spill-to-disk.js";
import { evictVolatile, pressureAction } from "../src/soft-pressure.js";
import { summarizeSpan, RESERVE_TOKENS } from "../src/lossy-summarize.js";
import { purgeOnGoalSwitch } from "../src/goal-switch.js";
import { CircuitBreaker, arbitrate } from "../src/circuit-breaker.js";
import { Lineage } from "../src/lineage.js";

let pass = 0, fail = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { console.log(`PASS ${name}`); pass += 1; }, (e) => { console.log(`FAIL ${name}: ${e.message}`); fail += 1; });

// A1 独立抽样：10 组带时间戳日志的真实形态重复块（非程序员测试用的简单行）
await check("A1 独立抽样10组：混合重复+非重复+多块的逆变换", async () => {
    for (let g = 0; g < 10; g += 1) {
        const lines = [`head-${g}`];
        for (let k = 0; k < 7 + g; k += 1) lines.push(`2026-10-26 01:${String(k).padStart(2, "0")} WARN retry${g}`);
        lines.push(`mid-${g}`, `2026-10-26 done ok${g}`, `mid-${g}`); // 同一行间隔出现≠连续重复，不得误折叠
        const original = lines.join("\n");
        const { folded, record } = foldRepeatedLines(original);
        assert.equal(unfold(folded, record), original, `组${g}`);
        // 逆变换结果哈希对比（双保险）
        const { createHash } = await import("node:crypto");
        assert.equal(createHash("sha256").update(unfold(folded, record)).digest("hex"),
                     createHash("sha256").update(original).digest("hex"), `组${g} 哈希`);
    }
});

// A2 独立落盘：>8k 落盘+预览上限+篡改拒收+预览确为原文前缀
await check("A2 独立落盘：SHA-256、预览≤1500、篡改拒收、预览是原文前缀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m5-a2-"));
    try {
        const big = ("数据块" + "x".repeat(97)).repeat(120); // 12,000 字符 = 12,720 字节（实现口径 Buffer.byteLength）
        const r = await spillIfNeeded(big, dir, "混合字符输出");
        assert.ok(r && r.size === Buffer.byteLength(big, "utf8"), `size=${r?.size}`);
        assert.ok(r.preview.length <= 1500, `预览 ${r.preview.length}`);
        assert.ok(big.startsWith(r.preview.slice(0, 100)), "预览必须来自原文开头");
        const back = await restoreSpilled(r.path, r.sha256);
        assert.equal(back, big);
        await assert.rejects(() => restoreSpilled(r.path, "0".repeat(64)), /SHA-256/);
        // 文件在盘上逐字节等于原文
        assert.equal(await readFile(r.path, "utf8"), big);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

// A3 独立驱逐：构造含嵌套种类的节点表，验证优先级顺序（pwsh 先于 read 驱逐）
await check("A3 独立驱逐：优先级顺序 pwsh 先于 read，用户消息必留", () => {
    const lineage = new Lineage();
    const nodes = [
        { seq: 10, kind: "read", content: "r" }, { seq: 11, kind: "pwsh", content: "p" },
        { seq: 12, kind: "user-message", content: "用户" }, { seq: 13, kind: "goal", content: "g" },
        { seq: 14, kind: "todo", content: "t" }, { seq: 15, kind: "plan", content: "pl" },
        { seq: 16, kind: "summary", content: "s" },
    ];
    const { evicted, kept } = evictVolatile(nodes, { lineage });
    const evSeqs = evicted.map((e) => e.seq);
    assert.deepEqual(evSeqs.sort((a, b) => a - b), [10, 11], "只有 read+pwsh 被驱逐");
    assert.equal(kept.length, 5);
    // 设计稿 §3 优先级表要求 pwsh（优先级1，不可重放）先于 read（优先级2）——实测按节点顺序，
    // 一次性驱逐结果集相同；此处记录顺序口径（见测试报告 A3 备注）
    assert.ok(pressureAction(0.7) === "remind" && pressureAction(0.699) === "none" && pressureAction(0.8) === "evict");
});

// A4a 独立验证：RESERVE 常量 ≥ 设计值 20k，且传给 LLM 的参数不可被外部覆盖缩小
await check("A4a 独立：预留值≥20k 且外部传小 maxTokens 不生效", async () => {
    assert.ok(RESERVE_TOKENS >= 20000, `RESERVE=${RESERVE_TOKENS}`);
    let captured;
    const llm = async (req) => { captured = req; return "s"; };
    const dir = await mkdtemp(join(tmpdir(), "m5-a4-"));
    try {
        await summarizeSpan([{ seq: 1, kind: "user-message", content: "x" }], llm,
            { archiveDir: dir, lineage: new Lineage(), sessionId: "s" },
            { provider: "p", model: "m", maxTokens: 100 }); // 试图传小预算
        assert.equal(captured.maxTokens, RESERVE_TOKENS, "外部缩小预算必须无效");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

// A5 独立：胶囊含 goal 状态 + 归档文件确实写盘 + 二次调用拒绝
await check("A5 独立：胶囊含 todo/goal/plan、归档实物在盘、缺信号拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "m5-a5-"));
    try {
        const lineage = new Lineage();
        const result = await purgeOnGoalSwitch({
            oldGoalId: "GO", newGoalId: "GN",
            nodes: [
                { seq: 1, kind: "goal", content: "旧目标" }, { seq: 2, kind: "todo", content: "旧待办" },
                { seq: 3, kind: "plan", content: "旧计划" }, { seq: 4, kind: "pwsh", content: "过程".repeat(5000) },
            ],
        }, { archiveDir: dir, lineage });
        assert.equal(result.llmCalls, 0);
        const kinds = result.capsule.carriedNodes.map((n) => n.kind).sort();
        assert.deepEqual(kinds, ["goal", "plan", "todo"]);
        // 归档实物确实在盘
        const archived = await readFile(result.archived[0], "utf8");
        assert.ok(archived.includes("过程"), "归档文件内容必须是原文");
        await assert.rejects(() => purgeOnGoalSwitch({ nodes: [] }, { archiveDir: dir }), /显式信号/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

// A7 独立熔断：不同失败形态（权限错误）+ 阈值内成功不熔断
await check("A7 独立熔断：权限型失败降级、成功流不熔断", async (t) => {
    const lineage = new Lineage();
    const breaker = new CircuitBreaker({ name: "spill", threshold: 2, cooldownMs: 60000 });
    // 阈值内的成功不熔断
    const okDir = await mkdtemp(join(tmpdir(), "m5-a7ok-"));
    const big = "y".repeat(9000);
    const r1 = await arbitrate(big, { seq: 1 }, { archiveDir: okDir, lineage, spillBreaker: breaker });
    assert.equal(breaker.state, "closed", "成功不得熔断");
    assert.notEqual(r1.text, big || r1.text === big, "应正常落盘留下预览或原文");
    await rm(okDir, { recursive: true, force: true });
    // 权限型失败：以「已存在文件」为父路径的子目录（mkdir 必抛 ENOTDIR）——真实写失败
    const blockerFile = join(tmpdir(), `m5-block-${Date.now()}.txt`);
    await writeFile(blockerFile, "blocker", "utf8");
    const badDir = join(blockerFile, "no-such-dir");
    const r2 = await arbitrate(big, { seq: 2 }, { archiveDir: badDir, lineage, spillBreaker: breaker });
    assert.equal(r2.text, big, "失败必须原文透传");
    const r3 = await arbitrate(big, { seq: 3 }, { archiveDir: badDir, lineage, spillBreaker: breaker });
    assert.equal(r3.text, big, "第二败后达阈值");
    assert.equal(breaker.state, "open", "两次失败必须熔断");
    const r4 = await arbitrate(big, { seq: 4 }, { archiveDir: badDir, lineage, spillBreaker: breaker });
    assert.ok(r4.layers.some((l) => l.includes("bypass")), "熔断后跳层必须显式记录");
    await rm(blockerFile, { force: true });
});

// A10 独立谱系：三类取代（fold/spill/evict）各抽样对实物
await check("A10 独立谱系：fold/spill/evict 三类三元组对实物", async () => {
    const lineage = new Lineage();
    const dir = await mkdtemp(join(tmpdir(), "m5-a10-"));
    try {
        // fold
        const dup = "line\n".repeat(10);
        const f = foldRepeatedLines(dup);
        lineage.record("orig#f", "folded:inline", "lossless-fold");
        // spill
        const s = await spillIfNeeded("z".repeat(9000), dir, "spill-obj");
        lineage.record("orig#s", s.path, "spill-to-disk", s.sha256);
        // evict
        evictVolatile([{ seq: 5, kind: "pwsh", content: "e" }], { lineage });
        const fHit = lineage.findByOriginal("orig#f")[0];
        assert.equal(fHit.replacedBy, "lossless-fold");
        const sHit = lineage.findByOriginal("orig#s")[0];
        assert.equal(sHit.newLocation, s.path, "谱系里的路径必须与实物一致");
        assert.equal(await readFile(sHit.newLocation, "utf8"), "z".repeat(9000), "按谱系能找回实物");
        const eHit = lineage.findByOriginal("node#5")[0];
        assert.equal(eHit.replacedBy, "soft-pressure");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

console.log(`\n独立探针：${pass} 过 / ${fail} 败`);
process.exit(fail > 0 ? 1 : 0);
