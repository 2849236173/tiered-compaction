/**
 * 预览首尾都要有（D17 验收单 P2-1 建议的落地，D20 对齐原版预算）。
 *
 * 问题：原实现 `text.slice(0, 1500)` 只留开头。但工具输出的**结论常在末尾**——
 *   错误码、`exit code: N`、测试的 `pass/fail` 计数、git 的 `N files changed`、
 *   命令的汇总行。只留开头会让模型看到一堆中间过程却看不到结论，
 *   反而促使它重跑命令（白烧 token），压缩就失去了意义。
 *
 * D20 变更（2026-10-28 用户拍板对齐原版 pruner）：
 *   - 预算从 1500 提到 5120（原版 headChars 4096 + 标记 + tailChars 1024）
 *   - 头尾比例从 1:2 改为 4:1（照抄原版 4096:1024）
 *   硬约束不变：总长（含标记）必须 ≤ limit。
 *
 * 运行：node --test test/d17-preview-head-tail.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { headTailPreview, spillIfNeeded, DEFAULT_PREVIEW_LIMIT } from "../src/spill-to-disk.js";

test("短文本原样返回，不加任何标记", () => {
    const text = "短输出";
    assert.equal(headTailPreview(text), text);
});

test("长文本：头部和尾部都必须保留", () => {
    const lines = [];
    for (let i = 0; i < 500; i += 1) lines.push(`行${i} 内容 padding-padding-padding`);
    lines.push("FINAL: exit code: 0, pass 42 fail 0");
    const text = lines.join("\n");

    const preview = headTailPreview(text);
    assert.ok(preview.includes("行0 "), "头部必须保留第一行");
    assert.ok(preview.includes("FINAL: exit code: 0"), "尾部必须保留结论行——这是本改动的核心目的");
    assert.ok(preview.includes("中间省略"), "必须有省略标记说明");
});

test("总长（含省略标记）绝不超过限额——A2 验收项", () => {
    for (const size of [2000, 10000, 100000]) {
        const text = "x".repeat(size);
        const preview = headTailPreview(text, DEFAULT_PREVIEW_LIMIT);
        assert.ok(
            preview.length <= DEFAULT_PREVIEW_LIMIT,
            `原文 ${size} 字符时预览 ${preview.length} 字符，超过 ${DEFAULT_PREVIEW_LIMIT}`,
        );
    }
});

test("省略量数字很大时也不超限（兜底裁剪生效）", () => {
    // 1MB 文本，omitted 是 7 位数，标记变长，仍必须 ≤ limit
    const text = "y".repeat(1000000);
    const preview = headTailPreview(text, DEFAULT_PREVIEW_LIMIT);
    assert.ok(preview.length <= DEFAULT_PREVIEW_LIMIT, `实得 ${preview.length}`);
});

test("D20 预算对齐原版：5120 上限下头 4096 尾 1024 量级成立", () => {
    // 原版 pruner（dsh-compaction-tool-result-pruner lib:10-14）：
    //   thresholdChars 8192 / headChars 4096 / tailChars 1024
    // 我们的单一上限 5120 下，头部应接近 4/5、尾部接近 1/5
    const text = "x".repeat(100000);
    const preview = headTailPreview(text, DEFAULT_PREVIEW_LIMIT);

    assert.ok(preview.length <= DEFAULT_PREVIEW_LIMIT, `实得 ${preview.length}`);
    // 头部：以 x 开头的连续段（原文头）
    const headRun = preview.slice(0, preview.indexOf("…[")).length;
    assert.ok(
        headRun >= 3800 && headRun <= 4100,
        `头部预算应接近 4096，实得 ${headRun}`,
    );
});

test("头部占比大于尾部：对齐原版 pruner 的 4:1 预算", () => {
    // 造一个能区分的样本：头部和尾部内容不同且等长
    const headPart = "H".repeat(3000);
    const tailPart = "T".repeat(3000);
    const text = headPart + "M".repeat(3000) + tailPart;
    const preview = headTailPreview(text, 900);

    const headCount = (preview.match(/H/g) ?? []).length;
    const tailCount = (preview.match(/T/g) ?? []).length;
    assert.ok(headCount > 0, "头部必须有内容");
    assert.ok(tailCount > 0, "尾部必须有内容（结论行仍要保住）");
    assert.ok(headCount > tailCount, `头部(${headCount})应多于尾部(${tailCount})，对齐原版 4096:1024`);
});

test("落到实际落盘路径：spillIfNeeded 的预览也是首尾式", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d17preview-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const lines = [];
    for (let i = 0; i < 400; i += 1) lines.push(`记录${i} 唯一内容 abcdefghij-${i}`);
    lines.push("SUMMARY: total 400 records, 0 errors");
    const text = lines.join("\n");

    const result = await spillIfNeeded(text, dir, "preview-test");
    assert.ok(result !== null, "超阈值必须落盘");
    assert.equal(result.size, Buffer.byteLength(text, "utf8"), "size 口径为 UTF-8 字节");
    assert.ok(result.preview.length <= DEFAULT_PREVIEW_LIMIT, "预览不超限");
    assert.ok(result.preview.includes("SUMMARY: total 400 records"), "实际落盘路径也要保住结论行");
});
