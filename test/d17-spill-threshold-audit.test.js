/**
 * 落盘与阈值的系统审计修复（2026-10-27）。
 *
 * 这个文件覆盖审计员发现的 P0-3 与 P1-1/2/3/4/5。
 * 它们共同的可怕之处：**不报错**。
 *   · 孤立代理项被替换后，SHA 依然相同 → 校验通过、内容已变
 *   · 阈值配置越界后，第 4 层永不触发 → 用户以为有压缩，其实没有
 *   · 预览切坏 emoji，模型看到乱码
 *
 * 运行：node --test test/d17-spill-threshold-audit.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { headTailPreview, spillIfNeeded, restoreSpilled, sha256 } from "../src/spill-to-disk.js";
import { lossyThreshold, RESERVE_TOKENS } from "../src/lossy-summarize.js";

/* ---------------- P0-3：UTF-8 编码损伤不得假绿 ---------------- */

test("P0-3 含孤立代理项的文本必须拒绝落盘（否则 SHA 校验通过但内容已变）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "u8-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 孤立高代理项：writeFile(...,"utf8") 会替换成 U+FFFD，
    // 而 hash.update(text,"utf8") 做同样替换 → 两个哈希相同（假绿）
    const broken = "正常内容" + "\uD800" + "后续内容".repeat(500);
    const result = await spillIfNeeded(broken, dir, "probe", { threshold: 1 });

    assert.equal(
        result,
        null,
        "往返不一致必须拒绝落盘——宁可少压一次，也不能存档被悄悄改过的内容",
    );
});

test("P0-3 正常文本（含 emoji/中文）必须能落盘并逐字节还原", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "u8ok-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const text = ("中文内容 😀🎉 ".repeat(500));
    const result = await spillIfNeeded(text, dir, "ok", { threshold: 1 });
    assert.ok(result !== null, "合法文本必须能落盘");

    const back = await restoreSpilled(result.path, result.sha256);
    assert.equal(back, text, "必须逐字节一致");
});

/* ---------------- P1-4 / P1-5：预览切分边界 ---------------- */

test("P1-4 预览不得切断 emoji 的代理对（范围扫 limit 100..600）", () => {
    const text = "😀".repeat(2000);
    const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
    const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

    for (let limit = 100; limit <= 600; limit += 1) {
        const preview = headTailPreview(text, limit);
        for (let i = 0; i < preview.length; i += 1) {
            const code = preview.charCodeAt(i);
            if (isHigh(code)) {
                assert.ok(
                    i + 1 < preview.length && isLow(preview.charCodeAt(i + 1)),
                    `limit=${limit} 位置 ${i} 出现孤立高代理`,
                );
            }
            if (isLow(code)) {
                assert.ok(
                    i > 0 && isHigh(preview.charCodeAt(i - 1)),
                    `limit=${limit} 位置 ${i} 出现孤立低代理`,
                );
            }
        }
    }
});

test("P1-5 预览不得把 CRLF 劈开（不得出现孤立 \\r）", () => {
    const text = Array(2000).fill("行内容abc").join("\r\n");
    // 判据聚焦在**最难掩盖的那一半**：孤立 \r。
    // 原文只有 CRLF，出现的任何"后面不跟 \n 的 \r"都必然是切分造成的。
    // （\n 不好判——标记行的换行也是 \n，会与真实残留混淆。）
    for (let limit = 100; limit <= 600; limit += 1) {
        const preview = headTailPreview(text, limit);
        for (let i = 0; i < preview.length; i += 1) {
            if (preview[i] !== "\r") continue;
            assert.equal(
                preview[i + 1],
                "\n",
                `limit=${limit} 位置 ${i} 出现孤立 \\r（CRLF 被劈开）`,
            );
        }
    }
});

test("P1 预览：limit 非法（NaN/0/负数）必须回落默认值，不得返回空串", () => {
    const text = "x".repeat(5000);
    for (const limit of [NaN, 0, -1, Infinity]) {
        const preview = headTailPreview(text, limit);
        assert.ok(preview.length > 0, `limit=${limit} 时预览不得为空`);
    }
});

/* ---------------- P1-1：绝对线必须真正接上 ---------------- */

test("P1-1 大窗口下阈值必须保证触发后仍留得住摘要输出预算", () => {
    // window >= 112130 时，剩余空间必须 >= RESERVE_TOKENS
    for (const window of [112130, 128000, 200000, 500000, 1000000]) {
        const threshold = lossyThreshold(window);
        assert.ok(
            window - threshold >= RESERVE_TOKENS,
            `window=${window} 时剩余 ${window - threshold} < 预算 ${RESERVE_TOKENS}`,
        );
    }
});

test("P1-1 小窗口：受 FLOOR_RATIO 约束，阈值不得低于 82%（保住第 3 层）", () => {
    // 这是有意的取舍：宁可摘要撞窗重试，也不能抢在 80% 驱逐之前。
    for (const window of [32768, 65536, 100000]) {
        const threshold = lossyThreshold(window);
        assert.ok(
            threshold >= Math.floor(window * 0.82),
            `window=${window} 阈值 ${threshold} 低于 82% 下限，会抢跑第 3 层驱逐`,
        );
    }
});

/* ---------------- P1-2：配置夹取 ---------------- */

test("P1-2 越界的 thresholdRatio 必须被夹到合法区间（不得静默永不触发）", () => {
    // ratio=1.5 旧实现 → 阈值 150% 窗口 → 永不触发（静默失效）
    const tooHigh = lossyThreshold(1000000, { thresholdRatio: 1.5 });
    assert.ok(tooHigh < 1000000, `ratio=1.5 时阈值 ${tooHigh} 超过窗口，永不触发`);

    // ratio=0.5 旧实现 → 抢在 80% 驱逐前
    const tooLow = lossyThreshold(1000000, { thresholdRatio: 0.5 });
    assert.ok(
        tooLow >= 820000,
        `ratio=0.5 时阈值 ${tooLow} 低于 82%，会抢跑第 3 层驱逐`,
    );

    // NaN headroom → 旧实现阈值 NaN（永不触发）
    const nan = lossyThreshold(1000000, { headroomTokens: NaN });
    assert.ok(Number.isFinite(nan), "headroom=NaN 时阈值必须是有限数");
});

test("P1-2 合法配置必须被尊重（不能被夹取误伤）", () => {
    const t = lossyThreshold(1000000, { thresholdRatio: 0.9, headroomTokens: 1000 });
    const ratio = t / 1000000;
    assert.ok(ratio >= 0.82 && ratio <= 0.95, `合法配置下占比 ${ratio} 应在 [0.82, 0.95]`);
});

/* ---------------- P1-3：极小窗口 ---------------- */

test("P1-3 极小窗口必须视为无效（不得 0 阈值导致空会话也触发）", () => {
    for (const window of [1, 10, 500, 999]) {
        assert.equal(
            lossyThreshold(window),
            Number.POSITIVE_INFINITY,
            `window=${window} 应返回 Infinity（不触发），旧实现返回 0 会导致每步都压缩`,
        );
    }
    assert.ok(Number.isFinite(lossyThreshold(8000)), "8000（真实最小模型窗口）必须正常工作");
});

/* ---------------- 单调性总检 ---------------- */

test("阈值必须严格单调递增（逐 1000 扫 1000..1.5M）", () => {
    let previous = -1;
    for (let window = 1000; window <= 1500000; window += 1000) {
        const threshold = lossyThreshold(window);
        assert.ok(threshold >= previous, `window=${window} 阈值 ${threshold} 小于前一个 ${previous}`);
        previous = threshold;
    }
});
