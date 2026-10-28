/**
 * M3 单测：第 1 层无损折叠 / 第 2 层落盘 / 谱系表。
 * 对照验收：A1（逆变换逐字节一致）、A2（>8k 全落盘 + SHA-256 + 预览 ≤1.5k）、A10（谱系可查）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { foldRepeatedLines, unfold, foldRatio } from "../src/lossless-fold.js";
import { spillIfNeeded, restoreSpilled, sha256, DEFAULT_PREVIEW_LIMIT } from "../src/spill-to-disk.js";
import { Lineage } from "../src/lineage.js";

test("A1 无损折叠：折叠标记正确且逆变换逐字节还原", () => {
    const original = ["ok", "warn-x", "warn-x", "warn-x", "warn-x", "done"].join("\n");
    const { folded, record } = foldRepeatedLines(original);
    assert.ok(folded.includes("…[folded 4x]"), "必须出现 4 次重复的折叠标记");
    assert.ok(!folded.includes("done") === false, "非重复行必须保留");
    assert.equal(unfold(folded, record), original, "逆变换必须逐字节还原原文");
});

test("A1 无损折叠：少于阈值次数的重复不折叠", () => {
    const original = ["a", "b", "b", "c"].join("\n");
    const { folded, record } = foldRepeatedLines(original);
    assert.equal(folded, original, "连续重复 <3 次必须原样保留");
    assert.equal(unfold(folded, record), original);
});

test("A1 折叠率与抽样自校验（10 组随机重复块）", () => {
    for (let i = 0; i < 10; i += 1) {
        const chunks = [];
        for (let j = 0; j < 5 + i; j += 1) chunks.push(`line-${j}`);
        // 每组插入一段 5 次重复的日志行
        chunks.splice(2, 0, "2026-10-25 INFO heartbeat", "2026-10-25 INFO heartbeat", "2026-10-25 INFO heartbeat", "2026-10-25 INFO heartbeat", "2026-10-25 INFO heartbeat");
        const original = chunks.join("\n");
        const { folded, record } = foldRepeatedLines(original);
        assert.equal(unfold(folded, record), original, `第 ${i} 组还原失败`);
        assert.ok(foldRatio(original, folded) < 1, "存在重复块时折叠率必须 <1");
    }
});

test("A1 谱系损坏防护：错配记录逆变换必须抛错", () => {
    const { folded, record } = foldRepeatedLines("x\nx\nx\n");
    const forged = { ...record, original: "other\n" };
    assert.throws(() => unfold(folded, forged), /不一致/);
});

test("A2 落盘：未超阈值返回 null 且不写文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-"));
    try {
        const result = await spillIfNeeded("short text", dir, "a");
        assert.equal(result, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("A2 落盘：>8k 全量落盘、SHA-256 可校验、预览 ≤1.5k 字符", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spill-"));
    try {
        const big = "0123456789".repeat(1000); // 10,000 字符
        const result = await spillIfNeeded(big, dir, "big-output");
        assert.ok(result, "超阈值必须落盘");
        assert.equal(result.size, 10000);
        assert.equal(result.sha256, sha256(big));
        assert.ok(result.preview.length <= DEFAULT_PREVIEW_LIMIT);
        // 回读校验
        const restored = await restoreSpilled(result.path, result.sha256);
        assert.equal(restored, big);
        // 篡改检测：换期望摘要必须抛错
        await assert.rejects(() => restoreSpilled(result.path, "deadbeef".repeat(8)), /SHA-256 校验失败/);
        // 文件确实整体在盘上
        const onDisk = await readFile(result.path, "utf8");
        assert.equal(onDisk, big);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("A10 谱系表：登记后可按原位置查询三元组", () => {
    const lineage = new Lineage();
    const entry = lineage.record("session#seq12", "archives/big-output.txt", "spill-to-disk", sha256("x"));
    assert.equal(entry.id, "L0001");
    const hits = lineage.findByOriginal("session#seq12");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].newLocation, "archives/big-output.txt");
    assert.equal(hits[0].replacedBy, "spill-to-disk");
    assert.equal(lineage.findByOriginal("不存在").length, 0);
    assert.equal(lineage.toArray().length, 1);
});
