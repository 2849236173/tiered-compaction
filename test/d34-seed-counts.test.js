// beta8：计数从会话日志回填，重启后不从 0 开始；健康检查不再因重启误报
import test from "node:test";
import assert from "node:assert/strict";
import { seedCountsFromLog, layerCountsFor } from "../src/shared-stats.js";

function logSession(id, events) {
    const log = events.map((e, seq) => ({ ...e, seq }));
    return { id, get seq() { return log.length; }, eventAt: (s) => log[s] };
}
const prune = (tok) => ({ type: "compaction/prune", data: { shadowedSeqs: [0], shadowedTokenCount: tok } });
const result = (text) => ({ type: "tool/result", data: { message: { content: [{ type: "text", text }] } } });

test("D34-1 日志回填：折叠/落盘、驱逐、摘要分别计数，官方 pruner 不计", () => {
    const s = logSession("s-seed-1", [
        prune(1000), result("[tiered-compaction 原始输出已折叠/落盘，此处为预览]\nabc\n存档：x.txt"),
        prune(800), result("[已驱逐：read 的结果可随时重跑恢复]"),
        prune(500), result("[pruned by official pruner]"),
        { type: "compaction/summary", data: { shadowedTokenCount: 5000 } },
    ]);
    const c = seedCountsFromLog(s);
    assert.equal(c.processed, 1);
    assert.equal(c.evicted, 1);
    assert.equal(c.summaries, 1);
    assert.equal(c.summaryTokensSaved, 5000);
    assert.ok(c.l12TokensSaved > 0 && c.l12TokensSaved < 1000);
    assert.ok(c.evictTokensSaved > 0 && c.evictTokensSaved < 800);
});

test("D34-2 新会话条目（模拟重启后首次见到）自动带上日志里的累计值", () => {
    const s = logSession("s-seed-2", [prune(400), result("[已驱逐：grep 的结果可随时重跑恢复]")]);
    assert.equal(layerCountsFor(s).evicted, 1);
});

test("D34-3 读日志异常时退回全零，不抛错", () => {
    const s = { id: "s-seed-3", seq: 3, eventAt() { throw new Error("boom"); } };
    assert.equal(seedCountsFromLog(s).processed, 0);
});

test("D34-4 重启后观察者未登记的会话：快照按日志回填，健康检查不误报零驱逐", async () => {
    const { layerStatsSnapshot } = await import("../src/shared-stats.js");
    const { collectHealth } = await import("../src/health-check.js");
    const s = logSession("s-seed-4", [prune(400), result("[已驱逐：read 的结果可随时重跑恢复]")]);
    assert.equal(layerStatsSnapshot(s).evicted, 1);
    const h = collectHealth({
        observer: { statsFor: (x) => layerStatsSnapshot(x) },
        engine: { lineage: { toArray: () => [] } },
        session: s, window: 24000, currentTokens: 20000,
        config: { archiveDir: "/tmp/x", auto: true },
    });
    assert.ok(!h.problems.some((p) => p.includes("零驱逐")), JSON.stringify(h.problems));
});
