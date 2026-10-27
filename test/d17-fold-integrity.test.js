/**
 * 无损折叠的"无损"必须是真的（系统审计 P0）。
 *
 * 审计发现（2026-10-27）：
 *   `unfold` 的实现本质是 `return record.original` —— "还原"只是把保存的
 *   原文吐回来，`runs` 从头到尾**没参与重建**。所谓自校验也只检查
 *   `seen >= count`，不是精确相等。
 *
 *   实测篡改矩阵（旧实现）：
 *     runs 清空      → 通过
 *     count 5→2      → 通过
 *     start 改 999   → 通过   ← start 还是死字段，从没被读过
 *
 *   这意味着：只要 record.original 在，任何对 runs 的篡改都无声通过；
 *   而一旦记录与原文分离存放（落盘后重读），就无法发现不一致。
 *
 * 现在改为**真正按 runs 重建**，并做三重校验。
 *
 * 运行：node --test test/d17-fold-integrity.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { foldRepeatedLines, unfold } from "../src/lossless-fold.js";

/** 造一段足够长、能被折叠的重复文本。 */
function repetitive(line, count) {
    const body = Array(count).fill(line).join("\n");
    return body;
}

test("正常折叠-还原必须逐字节一致", () => {
    const original = repetitive("这是一行足够长的重复内容 padding padding", 6);
    const { folded, record } = foldRepeatedLines(original);
    assert.ok(record.runs.length > 0, "本用例必须真的发生折叠");
    assert.equal(unfold(folded, record), original);
});

test("多组折叠：还原必须逐字节一致，且 runs 记录原文行号", () => {
    const a = "第一组重复行内容 padding padding padding";
    const b = "第二组重复行内容 padding padding padding";
    const original = ["开头", ...Array(5).fill(a), "中间", ...Array(7).fill(b), "结尾"].join("\n");
    const { folded, record } = foldRepeatedLines(original);

    assert.equal(record.runs.length, 2, "应有两个折叠组");
    assert.equal(unfold(folded, record), original);
    // start 必须是原文行号：第一组从第 1 行开始，第二组从第 7 行开始
    assert.equal(record.runs[0].start, 1, "第一组 start 应是原文行号 1");
    assert.equal(record.runs[1].start, 7, "第二组 start 应是原文行号 7");
});

test("runs 被清空必须拒绝（旧实现会静默通过）", () => {
    const original = repetitive("重复内容 padding padding padding", 5);
    const { folded, record } = foldRepeatedLines(original);
    assert.throws(
        () => unfold(folded, { original: record.original, runs: [] }),
        /没有对应项|只解析出/,
        "runs 清空后无法重建，必须拒绝",
    );
});

test("count 被改小必须拒绝（旧实现会静默通过）", () => {
    const original = repetitive("重复内容 padding padding padding", 5);
    const { folded, record } = foldRepeatedLines(original);
    assert.throws(
        () => unfold(folded, {
            original: record.original,
            runs: [{ ...record.runs[0], count: 2 }],
        }),
        /不一致/,
        "count 与实际标记不符时必须拒绝",
    );
});

test("start 被改大必须拒绝（旧实现里 start 是死字段）", () => {
    const original = repetitive("重复内容 padding padding padding", 5);
    const { folded, record } = foldRepeatedLines(original);
    assert.throws(
        () => unfold(folded, {
            original: record.original,
            runs: [{ ...record.runs[0], start: 999 }],
        }),
        /位置|不符/,
        "start 必须参与校验，否则它是死字段",
    );
});

test("记录缺失或格式不对必须拒绝，不得静默返回", () => {
    const original = repetitive("重复内容 padding padding padding", 5);
    const { folded } = foldRepeatedLines(original);
    assert.throws(() => unfold(folded, null), /记录缺失/);
    assert.throws(() => unfold(folded, {}), /记录缺失/);
    assert.throws(() => unfold(folded, { original }), /记录缺失/);
});

test("original 与重建结果不一致必须拒绝（防记录与文本被同时篡改）", () => {
    const original = repetitive("重复内容 padding padding padding", 5);
    const { folded, record } = foldRepeatedLines(original);
    assert.throws(
        () => unfold(folded, { original: "完全不同的内容", runs: record.runs }),
        /不一致/,
    );
});

test("未折叠的文本也必须能正常还原（runs 为空且无标记）", () => {
    const original = "a\nb\nc\nd";
    const { folded, record } = foldRepeatedLines(original);
    assert.equal(record.runs.length, 0);
    assert.equal(unfold(folded, record), original);
});
