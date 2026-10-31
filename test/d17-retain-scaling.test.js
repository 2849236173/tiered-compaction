/**
 * 保留量必须随窗口收敛（D17 沙箱实测挖出的第三个真 bug）。
 *
 * 缺陷（2026-10-27 沙箱验证暴露）：
 *   旧公式 `retain = max(16000, window × 5%)` 在小窗口下会**吃掉整个窗口**。
 *   窗口 20000 时保留 16000（占 80%），可选区间被挤到只剩 92 token，
 *   于是摘要必然「比被取代的内容还大」，每一次都失败：
 *     summary is not smaller than the shadowed content (634 >= 92)
 *
 *   实测证据：沙箱会话里第 4 层虽然已经能调用 LLM（前两个 bug 已修），
 *   但这类「选区太小」的失败占了绝大多数事务。
 *
 * 原版 basic 的对应约束（lib/index.js:134）：
 *   retainTokens >= thresholdTokens 直接配置报错。
 * 我们照抄用意，但改成运行时收敛而非抛错——小窗口是合法场景，
 * 不该因此完全丧失压缩能力。
 *
 * 运行：node --test test/d17-retain-scaling.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * 造 ctx 与会话，并截获 _selectRange 收到的 retainTokens。
 *
 * 只测「保留量是否被正确收敛」，不关心摘要内容，
 * 所以 selectRange 直接返回 null（让事务不发生），只记录入参。
 */
function makeHarness(windowTokens) {
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* () {
            yield { type: "finish", reason: { kind: "stop" } };
        },
    });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: windowTokens, nodes: [] }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;
    return ctx;
}

/** 最小会话桩：只提供 _selectRange 与 contextWindowOf 会读到的东西（真实派发语义）。 */
function makeSession(window) {
    const listeners = [];
    const session = {
        surface: { nodes: [] },
        requestHeader: () => ({ config: { provider: "test-provider", model: "test-model" } }),
        // contextWindowOf 优先走官方 requestContext()，窗口必须与用例一致，
        // 否则保留量按错的窗口算（本文件第一版就栽在这）。
        requestContext: () => ({ provider: "test-provider", model: "test-model", contextWindow: window }),
        eventAt: () => undefined,
        /** 与宿主 ctx.on("session/event", ...) 同构的注册面。 */
        on(type, listener) {
            if (type !== "session/event") return () => {};
            listeners.push(listener);
            return () => {
                const at = listeners.indexOf(listener);
                if (at !== -1) listeners.splice(at, 1);
            };
        },
        // 桩没有事件产生路径（_selectRange 被替换、不进事务），
        // 但保留与宿主一致的注册面：一旦有 append，同步派发、不 await。
        append(type, data, options = {}) {
            const event = { seq: 0, type, data, ...options };
            for (const listener of listeners) {
                try {
                    const result = listener(session, event);
                    if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
                } catch { /* 宿主也是 catch 掉监听者的同步异常 */ }
            }
            return event;
        },
    };
    return session;
}

/** 用截获的 retainTokens 跑一次 _compactWithRetention。 */
async function captureRetain(window, threshold) {
    const dir = await mkdtemp(join(tmpdir(), "retain-"));
    try {
        const ctx = makeHarness(window);
        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");
        const session = makeSession(window);

        const captured = [];
        service._selectRange = (s, m, retainTokens) => {
            captured.push(retainTokens);
            return null; // 不真正进入事务
        };

        try {
            await service._compactWithRetention(session, { session }, undefined, {
                threshold,
                measure: () => window,
            });
        } catch {
            // 未压到阈值以下会抛错，本测试不关心
        }
        return captured;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("小窗口（20k）下保留量必须收敛到阈值的一半，不能吃掉整个窗口", async () => {
    // 窗口 20000 → 阈值 82% = 16400；保留量必须 <= 8200
    const captured = await captureRetain(20000, 16400);
    assert.ok(captured.length > 0, "必须至少选一次区间");
    const retain = captured[0];
    assert.ok(
        retain <= 8200,
        `窗口 20000 时保留量必须 <= 8200（阈值一半），实得 ${retain}——` +
        "旧实现给 16000，只剩 92 token 可压，摘要必然比原文大",
    );
    assert.ok(retain > 0, "保留量不能为 0（那等于不留任何近端上下文）");
});

test("1M 大窗口下保留量保持原行为（50k），不因修复而变小", async () => {
    // 窗口 1,000,000 → 阈值 85% = 850000；保留量原公式 = max(16000, 50000) = 50000
    // 阈值一半 = 425000，远大于 50000，所以取 50000，行为不变
    const captured = await captureRetain(1000000, 850000);
    assert.equal(
        captured[0],
        50000,
        `大窗口保留量必须仍是 50000（窗口 5%），实得 ${captured[0]}——修复不该改变大窗口行为`,
    );
});

test("重试时必须缩小保留量，不能原地重选（否则白付一次 LLM 调用）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "retain-retry-"));
    try {
        const ctx = makeHarness(20000);
        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");
        const session = makeSession(20000);

        const captured = [];
        service._selectRange = (s, m, retainTokens) => {
            captured.push(retainTokens);
            // 必须返回合法区间，否则循环第一轮就 return，走不到重试
            return { start: 0, end: 0 };
        };
        // 事务直接当作成功但不推进压力读数：模拟「压了但没压够」
        service._runTransaction = async () => ({ shadowedSeqs: [0], shadowedRange: { start: 0, end: 0 } });

        try {
            await service._compactWithRetention(session, { session }, undefined, {
                threshold: 16400,
                measure: () => 20000, // 永远不降到阈值以下 → 必然重试
            });
        } catch {
            // 用尽重试后抛错，本测试不关心
        }

        assert.ok(captured.length >= 2, `校验重试路径需要至少 2 次尝试，实得 ${captured.length}`);
        assert.ok(
            captured[1] < captured[0],
            `重试的保留量必须小于首次（${captured[1]} 应 < ${captured[0]}），` +
            "旧代码写成 `attempt === 0 ? retain : retain`，两边相同等于原地重选",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
