/**
 * 摘要失败不得被伪装成「摘要结果为空」（D17 沙箱实测挖出的真 bug）。
 *
 * 缺陷（2026-10-27 沙箱验证暴露）：
 *   `_summarizeFnFromCtx` 里读 `assembler.finish?.error` 判断失败，
 *   但 `BlockAssembler.finish` 的返回形状是 `{ kind, failure }`
 *   （dsh-llm lib/types/assembler.js:171-173），**没有 `error` 字段**。
 *
 *   于是这个判断永远为假 → 每一次 LLM 失败都被静默吞掉 →
 *   `blocks()` 为空 → 返回空串 → 外层只报「摘要结果为空，拒绝提交」。
 *
 *   真实代价（沙箱实测）：21 次压缩事务 21 次同样的「摘要结果为空」，
 *   限流、超时、密钥失效全都看不出来，用户只能反复重试。
 *
 *   原版 basic 用 `finishError(finish)` 按 kind 分派
 *   （dsh-compaction-basic/lib/index.js:358-369），我方抄了形状却抄错字段名。
 *
 * 本文件的原则：**只走真实的 summarize() 入口**，不给内部函数开洞。
 * 直接测 finishErrorOf 只能证明映射函数对，证明不了 summarize 真的调用了它。
 *
 * 运行：node --test test/d17-summary-finish.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * 造一个 ctx，llm.stream 按用例给出的脚本站产出流。
 *
 * 流必须是真实 StreamChunk 序列：BlockAssembler 只认
 * block-start / text-delta / reasoning-delta / tool-call-delta / block-end /
 * usage / finish（dsh-llm lib/types/assembler.js:33-83），
 * 喂别的类型会抛 "unreachable variant in BlockAssembler.push"。
 */
function makeCtx(streamImpl) {
    const ctx = new Context();
    ctx.provide("llm", { stream: streamImpl });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: 0 }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;
    return ctx;
}

/** 造一个能被 summarize() 接受的 agent（只需带路由）。 */
function makeAgent() {
    return {
        options: { provider: "test-provider", model: "test-model" },
        session: { id: "session-test", requestHeader: () => ({ config: { provider: "test-provider", model: "test-model" } }) },
    };
}

async function summarizeWith(streamImpl, input = "待摘要内容") {
    const dir = await mkdtemp(join(tmpdir(), "sumfin-"));
    try {
        const ctx = makeCtx(streamImpl);
        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");
        return await service.summarize(input, makeAgent(), undefined);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("摘要失败（finish.kind=error）必须抛出真实错误，不能伪装成「摘要为空」", async () => {
    await assert.rejects(
        () => summarizeWith(async function* () {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "" };
            yield {
                type: "finish",
                reason: {
                    kind: "error",
                    failure: { message: "429 rate limit exceeded", code: "RATE_LIMITED" },
                },
            };
        }),
        (error) => {
            // 关键断言：错误信息里必须能看见真实原因
            assert.match(
                String(error.message),
                /rate limit/i,
                `必须暴露 LLM 的真实失败原因，实得：${error.message}`,
            );
            // 且不能是笼统的「摘要结果为空」
            assert.doesNotMatch(
                String(error.message),
                /摘要结果为空/,
                "LLM 失败不得被降级成「摘要结果为空」——这正是被修掉的 bug",
            );
            return true;
        },
    );
});

test("摘要被 max-tokens 截断必须失败，不得把半截检查点当完整摘要提交", async () => {
    await assert.rejects(
        () => summarizeWith(async function* () {
            // 必须走完整块协议：只有 text-delta 而没有 block-start，
            // 会让 BlockAssembler 落到未知块类型上（本文件第一版就栽在这）。
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "这里只有一半的检查点" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "这里只有一半的检查点" } };
            // 真实宿主的 max-tokens 终止形状就是 { kind: "max-tokens" }（无 failure）
            yield { type: "finish", reason: { kind: "max-tokens" } };
        }),
        (error) => {
            assert.equal(error.code, "MAX_TOKENS", `截断必须报 MAX_TOKENS，实得 ${error.code}`);
            return true;
        },
    );
});

test("摘要正常（finish.kind=stop）必须返回文本，不得误报失败", async () => {
    const result = await summarizeWith(async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "## 检查点\n- 已完成 A\n- 下一步 B" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "## 检查点\n- 已完成 A\n- 下一步 B" } };
        yield { type: "finish", reason: "stop" };
    });

    assert.match(result.summary, /检查点/, "正常流必须返回真实摘要文本");
    assert.equal(result.provider, "test-provider");
    assert.equal(result.maxTokens, 20000, "预算必须固定为 RESERVE_TOKENS");
});

test("finish 缺失（流正常结束但没发 finish 块）按 stop 处理，返回已收文本", async () => {
    const result = await summarizeWith(async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "只有文本没有 finish 块" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "只有文本没有 finish 块" } };
    });

    assert.match(result.summary, /只有文本/, "BlockAssembler.finish 缺省为 stop，不该判失败");
});

test("aborted（用户取消）必须抛错，不得返回空摘要", async () => {
    await assert.rejects(
        () => summarizeWith(async function* () {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "半截" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "半截" } };
            yield {
                type: "finish",
                reason: { kind: "aborted", failure: { message: "用户取消了操作", code: "ABORTED" } },
            };
        }),
        (error) => {
            assert.equal(error.code, "ABORTED", `取消必须抛 aborted 错误，实得 ${error.code}`);
            return true;
        },
    );
});

test("配置里没写 summaryTarget 时必须回落到会话路由（schemastery 会把它变成空对象）", async () => {
    // 这条钉死 D17 的第二个真 bug：配置未写 → schemastery 反序列化成 {}，
    // `??` 短路失效 → 摘要请求带着 provider:undefined 发出去 → 必然失败。
    const result = await summarizeWith(async function* () {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "回落到会话路由的摘要" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "回落到会话路由的摘要" } };
        yield { type: "finish", reason: { kind: "stop" } };
    });

    assert.match(result.summary, /回落到会话路由/, "必须拿到摘要");
    assert.equal(result.provider, "test-provider", `路由必须来自会话，实得 ${result.provider}`);
    assert.equal(result.model, "test-model", `模型必须来自会话，实得 ${result.model}`);
});
