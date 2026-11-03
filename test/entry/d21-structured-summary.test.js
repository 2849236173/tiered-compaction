/**
 * D21 真实宿主契约测试：SessionStore + JSONL persistence + register + transaction + cold restore。
 *
 * I 使用系统临时目录，不触碰用户会话；J 只读外部 fixture，由环境变量提供，不将真实日志入仓库。
 * L 真实会话/API 调用与宿主 patch 未经批准，本文件不执行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { Session, SessionStore } from "@deepseek-ai/dsh-session";
import { apply as applyPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { apply as applyCompaction } from "../../src/index.js";

const quietLogger = { info() {}, warn() {}, error() {} };
const UI_CLIENT = "G:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";
const FIXTURE_ROOT = process.env.D21_SESSION_FIXTURE_ROOT;
const FIXTURE_ID = process.env.D21_SESSION_FIXTURE_ID;
const FIXTURE_CWD = process.env.D21_SESSION_FIXTURE_CWD;

async function mountSessionPersistence(ctx, root) {
    await ctx.plugin(SessionStore);
    await applyPersistence(ctx, { root });
}

function userEvent(id, text) {
    return {
        role: "user",
        id,
        source: { kind: "user" },
        content: [{ type: "text", text }],
    };
}

/**
 * I：用真实 SessionStore、JSONL persistence、Cordis register 和事务路径完成摘要，
 * 冷建新 Context 后读取 JSONL，再用真实 Session.fromRestore 校验并核对块边界。
 */
test("D21 I real Session → register/transaction → JSONL flush → cold restore 保留 summary blocks", async (t) => {
    const temp = await mkdtemp(join(tmpdir(), "d21-roundtrip-"));
    const sessionsRoot = join(temp, "sessions");
    const archiveDir = join(temp, "archive");
    const sessionId = "session-d21-roundtrip";
    const summaryBlocks = [
        { type: "text", text: "恢复后仍保留事实块 A。" },
        { type: "text", text: "恢复后仍保留约束块 B。" },
    ];

    const ctx = new Context();
    ctx.logger = quietLogger;
    ctx.provide("llm", { stream: async function* () {} });
    ctx.provide("tokenMeter", { measure: () => ({ totalTokens: 100000 }) });

    let writer;
    let detach;
    try {
        await mountSessionPersistence(ctx, sessionsRoot);
        await applyCompaction(ctx, {
            enabled: true,
            auto: false,
            archiveDir,
            summaryTarget: { provider: "test-provider", model: "test-model" },
            summarizeFn: async (request) => {
                assert.deepEqual(request.messages.slice(0, 3).map((message) => message.role), ["user", "user", "user"]);
                return {
                    summary: summaryBlocks,
                    rawOutput: summaryBlocks,
                    llmStreamCall: true,
                    provider: "test-provider",
                    model: "test-model",
                    maxTokens: 20000,
                    usage: { inputTokens: 1200, outputTokens: 40 },
                };
            },
        });

        const session = ctx.sessions.prepare(sessionId, { meta: { cwd: temp } });
        writer = await ctx.sessionPersistence.create(session.header);
        detach = ctx.sessions.enter(session);
        ctx.sessions.announce(session);

        const source = [
            "用户的长任务要求、完成进展、精确约束与待办。".repeat(100),
            "已完成的技术分析、文件路径、命令证据和决策。".repeat(100),
            "新增用户修正：保留原始块结构，不得拍平。".repeat(100),
        ];
        const originalEvents = source.map((text, index) => session.append(
            "user/message",
            userEvent(`user-${index}`, text),
            { surfaceOp: "append" },
        ));

        const agent = {
            session,
            options: { provider: "test-provider", model: "test-model" },
            runMaintenance: async (fn) => fn(new AbortController().signal),
        };
        const result = await ctx.compaction.compactRegion(
            originalEvents[0].seq,
            originalEvents[2].seq,
            agent,
            undefined,
        );
        assert.deepEqual(result.summary, summaryBlocks);
        assert.equal(Object.hasOwn(result, "summaryBlocks"), false);

        const summaryEvent = session.eventAt(result.summarySeq);
        assert.deepEqual(summaryEvent.data.summary, summaryBlocks);
        const checkpointEvent = session.eventAt(session.surface.nodes[0]);
        assert.equal(checkpointEvent.type, "user/message");
        assert.deepEqual(checkpointEvent.data.content.slice(1, -1), summaryBlocks);
        assert.deepEqual(
            checkpointEvent.data.content,
            [
                checkpointEvent.data.content[0],
                ...summaryBlocks,
                checkpointEvent.data.content.at(-1),
            ],
        );
        assert.deepEqual(checkpointEvent.surfaceOp, {
            op: "replace",
            startSeq: originalEvents[0].seq,
            endSeq: originalEvents[2].seq,
        });

        await ctx.sessions.flush(session);
        await writer.close();
        writer = undefined;
        detach();
        detach = undefined;
        await ctx.fiber.dispose();

        // 全新 backend Context 执行真实 JSONL 读取，再走宿主 Session restore 校验。
        const coldCtx = new Context();
        coldCtx.logger = quietLogger;
        try {
            await applyPersistence(coldCtx, { root: sessionsRoot });
            const handle = await coldCtx.sessionPersistence.open(sessionId, "read");
            try {
                const restoredLog = await handle.read(0);
                const restored = Session.fromRestore(
                    sessionId,
                    restoredLog.events,
                    handle.header,
                    handle.inheritedEventCount,
                    restoredLog.eventState,
                );
                const restoredEvents = restoredLog.events;
                const restoredSummary = restoredEvents.find((event) => event.type === "compaction/summary");
                const restoredCheckpoint = restoredEvents.find((event) => event.type === "user/message" && event.surfaceOp?.op === "replace");
                assert.deepEqual(restored.eventAt(restoredSummary.seq).data.summary, summaryBlocks);
                assert.deepEqual(restoredCheckpoint.data.content.slice(1, -1), summaryBlocks);
                assert.deepEqual(restoredSummary.data.summary, restoredCheckpoint.data.content.slice(1, -1));
            } finally {
                await handle.close();
            }
        } finally {
            await coldCtx.fiber.dispose();
        }

    } finally {
        if (writer !== undefined) await writer.close().catch(() => {});
        if (detach !== undefined) detach();
        await ctx.fiber.dispose().catch(() => {});
        await rm(temp, { recursive: true, force: true });
    }
});

/**
 * G：依据安装的实际聊天 UI consumer 源码验证其数组分派和 marker 规则。
 * 不运行完整 React/UI renderer；L 的真实 Web 会话验收另行等待批准。
 */
test("D21 G host chat UI source consumes summary block[]; legacy string marker remains null", { skip: existsSync(UI_CLIENT) ? false : "本机未安装 dsh-client-ui-chat" }, async () => {
    const source = await readFile(UI_CLIENT, "utf8");
    assert.match(source, /function compactSummary\(match, checkpoint\)/);
    assert.match(source, /if \(Array\.isArray\(data\.summary\)\)/);
    assert.match(source, /data\.summary\.map\(\(block\) => block\.type === "text" \? block\.text : ""\)\.join\(""\)/);
    assert.match(source, /summary = text\.trim\(\) === "" \? null : text/);

    const summaryBlocks = [{ type: "text", text: "事实块" }, { type: "text", text: "约束块" }];
    const renderMarker = (summary) => {
        if (!Array.isArray(summary)) return null;
        const text = summary.map((block) => block.type === "text" ? block.text : "").join("");
        return text.trim() === "" ? null : text;
    };
    assert.equal(renderMarker(summaryBlocks), "事实块约束块");
    assert.equal(renderMarker("旧版字符串摘要"), null, "legacy string marker 的既有限制不在本任务迁移");
});

/**
 * J：只读通过真实 JSONL parser 与 Session.fromRestore 检查外部 fixture。
 * 设置 D21_SESSION_FIXTURE_ROOT、D21_SESSION_FIXTURE_ID，可选 D21_SESSION_FIXTURE_CWD。
 */
test("D21 J external historical fixture restores string and block[] summary records", {
    skip: FIXTURE_ROOT && FIXTURE_ID ? false : "未提供 D21_SESSION_FIXTURE_ROOT 与 D21_SESSION_FIXTURE_ID，只读历史 fixture 验收未运行",
}, async (t) => {
    const ctx = new Context();
    ctx.logger = quietLogger;
    try {
        await applyPersistence(ctx, { root: FIXTURE_ROOT });
        const handle = await ctx.sessionPersistence.open(FIXTURE_ID, "read");
        try {
            const loaded = await handle.read(0);
            const restored = Session.fromRestore(
                FIXTURE_ID,
                loaded.events,
                handle.header,
                handle.inheritedEventCount,
                loaded.eventState,
            );
            const summaryEvents = loaded.events.filter((event) => event.type === "compaction/summary");
            const stringEvents = summaryEvents.filter((event) => typeof event.data?.summary === "string");
            const blockEvents = summaryEvents.filter((event) => Array.isArray(event.data?.summary));
            assert.ok(stringEvents.length > 0, "fixture 必须含至少一个历史 string summary event");
            assert.ok(blockEvents.length > 0, "fixture 必须含至少一个 block[] summary event");
            assert.ok(restored.eventAt(stringEvents[0].seq), "历史 string event 经 Session.fromRestore 后仍存在");
            assert.ok(restored.eventAt(blockEvents[0].seq), "block[] event 经 Session.fromRestore 后仍存在");
            t.diagnostic(`restore ${loaded.events.length} events; legacy string=${stringEvents.length}; block[]=${blockEvents.length}; fixture cwd supplied=${Boolean(FIXTURE_CWD)}`);
        } finally {
            await handle.close();
        }
    } finally {
        await ctx.fiber.dispose();
    }
});

/**
 * A–K 未额外授权的项到此覆盖；真实 DSH 会话与对用户模型发请求的 L 不执行。
 */
