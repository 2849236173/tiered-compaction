/**
 * D17 实测回归：**折叠不能越折越大**。
 *
 * 缺陷（2026-10-27 02:00 真实日志暴露）：
 *   `tiered-compaction: 工具结果 seq=10722 已压缩（lossless-fold），521 → 530 字符`
 *   折叠后比原文多 9 个字符——标记 `…[folded 3x]` 的成本超过了它省下的内容。
 *   表现：做了一次「压缩」，结果是净亏损，而且内容更难读。
 *
 * 为什么会这样：旧实现只要连续重复 ≥3 行就折叠，但判据里没算标记成本。
 *   短行（如 `}`、空行、`---`）连续重复 3 次时，省下 2 行原文（可能只有
 *   几个字符），却要塞进 1 行 13 字符的标记 → 净亏。
 *   中文行更明显：字符数看不出，字节数才是真实体积。
 *
 * 修法：只有「省下的字节 > 标记字节」才折；整体没有净省就原样返回。
 *
 * 运行：node --test test/d17-fold-net-gain.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { foldRepeatedLines, unfold } from "../src/lossless-fold.js";

const byteSize = (s) => Buffer.byteLength(s, "utf8");

test("折叠不得越折越大：短行重复 3 次必须原样返回", () => {
    // 极短行连续 3 次：省 2 行（约 2 字节），代价是 13 字节标记
    const text = ["a", "a", "a"].join("\n");
    const { folded, record } = foldRepeatedLines(text);

    assert.ok(byteSize(folded) <= byteSize(text), `折叠后不得变大：${byteSize(text)} → ${byteSize(folded)}`);
    assert.equal(folded, text, "净亏时应当原样返回，不做无意义折叠");
    assert.equal(record.runs.length, 0, "没有净省就不该记录折叠");
});

test("折叠不得越折越大：中文短行同理（字节口径）", () => {
    const text = ["嗯", "嗯", "嗯"].join("\n");
    const { folded } = foldRepeatedLines(text);
    assert.ok(byteSize(folded) <= byteSize(text), "中文短行按字节算同样不该折");
});

test("真正的长行重复仍然要折，且折得有意义", () => {
    const line = "这是一条相当长的日志行，重复出现多次，折叠才有收益 ".repeat(2);
    const text = Array.from({ length: 10 }, () => line).join("\n");
    const { folded, record } = foldRepeatedLines(text);

    assert.ok(record.runs.length > 0, "长行重复必须折叠");
    assert.ok(byteSize(folded) < byteSize(text) / 2, `应显著变小：${byteSize(text)} → ${byteSize(folded)}`);
    // 折叠必须可逆（A1 保真）
    assert.equal(unfold(folded, record), text, "折叠必须可无损还原");
});

test("混合场景：只折有净省的部分，不折亏的部分", () => {
    const longLine = "长行内容重复多次折叠有收益 abcdefghijklmnopqrstuvwxyz".repeat(2);
    const text = [
        "a", "a", "a",           // 短行重复：不该折
        longLine, longLine, longLine, longLine,  // 长行重复：该折
    ].join("\n");

    const { folded, record } = foldRepeatedLines(text);
    assert.ok(byteSize(folded) < byteSize(text), "整体必须有净省");
    assert.equal(record.runs.length, 1, "只应有长行那一处被折");
    assert.equal(unfold(folded, record), text, "整体仍必须可无损还原");
});

test("没有任何重复时原样返回，不产生任何记录", () => {
    const text = Array.from({ length: 50 }, (_, i) => `唯一行 ${i}`).join("\n");
    const { folded, record } = foldRepeatedLines(text);
    assert.equal(folded, text);
    assert.equal(record.runs.length, 0);
});
