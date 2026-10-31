/**
 * D18 复核回归测试：GLM 独立复核（P5）挖出的三处语义缺口。
 *
 * 这三条在修复前**全都有真实缺陷**，但当时的 194 条测试**一条都测不到**——
 * 这本身是最值得记住的教训：测试覆盖了「清单项」，不等于覆盖了「语义正确」。
 *
 * 三条缺陷：
 *   1. 纯空白摘要被放行
 *      旧口径只判 `summary.length === 0`，于是 "   " / "\n\n" / " \t \n "
 *      全部通过校验，最终把一条什么都没有的检查点写进会话、覆盖掉真实原文。
 *      原版 basic:331-333 的口径是 `block.text.trim().length > 0`。
 *
 *   2. 选区含 0 号节点时 system 头被投影两次
 *      buildSummaryInput 先单独放一次 system，选区循环又投影一次，
 *      消息前缀出现两个 system → 前缀顺序与正常对话请求不一致 → KV 缓存失效。
 *
 *   3. estimateInputTokens 跳过**全部** system 消息
 *      它本意只该跳过「选外」的那条 system 头。若选区里混入 system，
 *      它的体量被无视，分母偏小 → 判据变严 → 正常摘要被误拒绝。
 *
 * 运行：node --test test/d18-review-regression.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";
import { buildSummaryInput } from "../src/summary-input.js";

const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * 按真实宿主形状造会话桩：surface.nodes 是 seq 数字数组。
 *
 * @param {Map<number, object>} events seq → 事件
 * @param {object} [opts] 可选项
 * @returns {object} 会话桩
 */
function makeSession(events, opts = {}) {
    const session = {
        id: opts.id ?? "session-d18-review",
        surface: { nodes: [...events.keys()] },
        eventAt: (seq) => events.get(seq),
        requestHeader: () => opts.header ?? { config: { provider: "p", model: "m" } },
        deriveEventMessage: (event) => {
            if (event === undefined || event === null) return null;
            if (event.type === "user/message") {
                return { role: "user", content: event.data.content };
            }
            if (event.type === "assistant/message") {
                return { role: "assistant", content: event.data.message.content };
            }
            if (event.type === "system/message") {
                return { role: "system", content: event.data.message.content };
            }
            // 非消息事件由宿主投影为 null
            return null;
        },
    };
    if (opts.dropDerive === true) {
        delete session.deriveEventMessage;
    }
    if (opts.toolHistory !== undefined) {
        session.toolHistory = () => opts.toolHistory;
    }
    return session;
}

/**
 * 造一个带 system 头 + 两条正文事件的会话。
 *
 * @returns {object} 会话桩
 */
function makeStandardSession() {
    const events = new Map([
        [0, { seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "你是助手" }] } } }],
        [1, { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "改这段代码" }] } }],
        [2, { seq: 2, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "好的" }] } } }],
    ]);
    return makeSession(events);
}

/**
 * 造一个 Cordis ctx，llm.stream 记录收到的 options。
 *
 * 流块格式必须与宿主 BlockAssembler 的契约一致：
 * block-start / text-delta / block-end / finish，其中 finish 的形状是
 * `{ type: "finish", reason: { kind } }`（dsh-llm lib/index.js:992 会读 reason）。
 *
 * @param {Function} [onStream] 收到 options 时的回调
 * @param {string} [summaryText] 桩返回的摘要正文
 * @returns {Context} ctx
 */
function makeCtx(onStream, summaryText = "摘要正文") {
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* (options) {
            if (onStream !== undefined) onStream(options);
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: summaryText };
            yield { type: "block-end", index: 0, block: { type: "text", text: summaryText } };
            yield { type: "finish", reason: { kind: "stop" } };
        },
    });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: 0 }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;
    return ctx;
}

/* ─────────────── 缺口 1：纯空白摘要必须被拒绝 ─────────────── */

test("缺口1 纯空白摘要必须拒绝提交（对齐 basic 的 trim 口径）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d18rev-blank-"));
    try {
        const ctx = makeCtx(undefined, "   \n  \t ");
        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");
        const agent = {
            options: { provider: "p", model: "m" },
            session: makeStandardSession(),
        };
        const input = buildSummaryInput(agent.session, [1, 2]);

        await assert.rejects(
            () => service.summarize(input, agent, undefined),
            (error) => {
                assert.match(error.message, /摘要结果为空/);
                return true;
            },
            "纯空白摘要必须被拒绝：提交后会写一条什么都没说的检查点覆盖原文",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("缺口1 只有空格的摘要被拒，正常摘要仍放行（不能误伤）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d18rev-blank2-"));
    try {
        const ctx = makeCtx(undefined, "这是一段正常摘要");
        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");
        const agent = {
            options: { provider: "p", model: "m" },
            session: makeStandardSession(),
        };
        const input = buildSummaryInput(agent.session, [1, 2]);

        const result = await service.summarize(input, agent, undefined);
        assert.equal(result.summary, "这是一段正常摘要", "正常摘要不能被误拒");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

/* ─────────────── 缺口 2：system 头不得重复投影 ─────────────── */

test("缺口2 选区包含 0 号节点时 system 头只出现一次", () => {
    const session = makeStandardSession();

    // 选区把 0 号节点也包进来：这是边界情形，手动压缩可以构造出来
    const input = buildSummaryInput(session, [0, 1, 2]);

    const systemCount = input.messages.filter((m) => m.role === "system").length;
    assert.equal(systemCount, 1, "system 头只能出现一次，否则前缀顺序与正常请求不一致");
    assert.equal(input.messages[0].role, "system", "system 必须在最前");
    assert.equal(input.messages.length, 3, "system + 两条正文，不能有重复");
});

test("缺口2 选区不含 0 号节点时 system 头仍正常带出", () => {
    const session = makeStandardSession();

    const input = buildSummaryInput(session, [1, 2]);

    assert.equal(input.messages.length, 3, "system 头 + 两条正文");
    assert.equal(input.messages[0].role, "system");
});

/* ─────────────── 缺口 3：estimate 只跳过头那一条 system ─────────────── */

test("缺口3 选区内的 system 消息必须计入被压缩体量（否则正常摘要被误拒）", async () => {
    // 0 号是选外 system 头，1 号是选区内的 system，2 号是正文。
    // 1 号那 4000 个字符属于**会被压缩掉**的内容，必须进分母。
    const events = new Map([
        [0, { seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "头" }] } } }],
        [1, { seq: 1, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "x".repeat(4000) }] } } }],
        [2, { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "y".repeat(4000) }] } }],
    ]);
    const session = makeSession(events);
    const input = buildSummaryInput(session, [1, 2]);

    const { __test } = await import("../src/contract.js");
    const estimate = __test.estimateInputTokens(input);

    // 选区内容 4000 + 4000 = 8000 字符 → 约 2000 token。
    // 若选区内 system 被错误跳过，只剩 4000 字符 → 约 1000 token。
    // 直接断言数值区间，而不是只断言「summarize 没报错」——
    // 后者在旧实现下也会通过（误拒发生在事务层，不在 summarize 层）。
    assert.ok(
        estimate >= 1900 && estimate <= 2100,
        `选区内的 system 必须计入分母，期望约 2000，实得 ${estimate}`,
    );
});

test("缺口3 头 system 不计入被压缩体量（判据不能放水）", async () => {
    // 超长 system 头 + 极短正文：头若计入分母，判据会被放水到几乎永远成立
    const events = new Map([
        [0, { seq: 0, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "H".repeat(40000) }] } } }],
        [1, { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "短" }] } }],
    ]);
    const session = makeSession(events);
    const input = buildSummaryInput(session, [1]);

    const { __test } = await import("../src/contract.js");
    const estimate = __test.estimateInputTokens(input);

    // 正文只有 1 个字符 → 1 token（ceil(1/4)）。
    // 若 system 头（40000 字符 ≈ 10000 token）被计入，estimate 会是五位数。
    assert.equal(estimate, 1, `头 system 不能计入分母，期望 1，实得 ${estimate}`);
});
