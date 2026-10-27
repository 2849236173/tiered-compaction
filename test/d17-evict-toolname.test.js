/**
 * 第 3 层驱逐必须能从真实事件结构里认出工具名。
 *
 * 缺陷（2026-10-27 用真实模型跑沙箱时暴露）：
 *   真实宿主的 `tool/result` 事件**没有工具名**。实测结构：
 *     data = { turn, step,
 *              message: { role, source: { kind, callId }, toolCallId,
 *                         content, isError, id },
 *              meta: { path, offset, lines, totalLines, lang } }
 *
 *   工具名只存在于配对的 `tool/call` 事件：
 *     data = { turn, step, callId, name: "read", arguments: "..." }
 *
 *   旧代码读 `source.toolName ?? data.toolName`——两个字段都不存在，
 *   永远得到 undefined，于是第 3 层**一个也挑不出可驱逐项**（evicted 恒 0）。
 *
 *   这个 bug 单测抓不到，因为之前的测试桩自己往 tool/result 里塞了 toolName，
 *   桩比现实"更好用"。又一次桩失真。
 *
 * 本文件的夹具严格照抄真实事件结构（不含 toolName），
 * 让"桩迁就代码"变成"代码适应现实"。
 *
 * 运行：node --test test/d17-evict-toolname.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

const quietLogger = { info() {}, warn() {}, error() {} };

function makeCtx(pressureTokens) {
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* () {
            yield { type: "finish", reason: { kind: "stop" } };
        },
    });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: pressureTokens, nodes: [] }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;
    return ctx;
}

/** 会话桩，事件结构严格照真实宿主。 */
function makeRealisticSession() {
    const log = [];
    const nodes = [];
    const session = {
        get seq() {
            return log.length;
        },
        surface: { nodes },
        requestHeader: () => ({ config: { provider: "p", model: "m" } }),
        requestContext: () => ({ provider: "p", model: "m", contextWindow: 10000 }),
        eventAt: (seq) => log.find((e) => e.seq === seq),
        append(type, data, options = {}) {
            const seq = log.length;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                const at = nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) nodes[at] = seq;
            } else if (["user/message", "assistant/message", "tool/result"].includes(type)) {
                nodes.push(seq);
            }
            return event;
        },
        log,
        nodes,
    };
    return session;
}

/** 按真实结构造一对 tool/call + tool/result（result 上**没有**工具名）。 */
function appendToolPair(session, { callId, name, text }) {
    session.append("tool/call", {
        turn: 1,
        step: 1,
        callId,
        name,
        arguments: JSON.stringify({ file_path: "src/x.js" }),
    });
    session.append("tool/result", {
        turn: 1,
        step: 1,
        message: {
            role: "tool",
            source: { kind: "tool", callId },
            toolCallId: callId,
            content: [{ type: "text", text }],
            isError: false,
            id: `msg-${callId}`,
        },
        meta: { path: "src/x.js", offset: 1, lines: [], totalLines: 10, lang: "js" },
    });
}

test("真实事件结构下（result 不带工具名），第 3 层必须能认出 read 并驱逐", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "evictname-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 窗口 10000 → 80% = 8000；给 9000 制造驱逐压力
    const ctx = makeCtx(9000);
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeRealisticSession();
    appendToolPair(session, {
        callId: "call_00_AAA|item_bbb",
        name: "read",
        text: "被读取文件的完整内容".repeat(300),
    });

    const before = [...session.surface.nodes];

    await service.compactIfNeeded({ session }, "pressure", undefined);

    assert.notDeepEqual(
        session.surface.nodes,
        before,
        "工具名在配对的 tool/call 上，必须能查到——否则第 3 层一个也挑不出来",
    );

    // 表面上的 result 必须被换成驱逐提示
    const latest = session.eventAt(session.surface.nodes[0]);
    const text = (latest.data.message.content ?? []).map((b) => b.text ?? "").join("");
    assert.match(text, /\[已驱逐：read/, `必须写入精确的驱逐提示，实得：${text.slice(0, 120)}`);
});

test("非可重放工具（如 pwsh）不得被驱逐——认名单必须准，不能误伤", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "evictname2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx(9000);
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeRealisticSession();
    appendToolPair(session, {
        callId: "call_01_CCC|item_ddd",
        name: "pwsh",
        text: "命令输出".repeat(300),
    });

    const before = [...session.surface.nodes];
    await service.compactIfNeeded({ session }, "pressure", undefined);

    assert.deepEqual(
        session.surface.nodes,
        before,
        "pwsh 结果不可靠重放（有副作用），绝不能当易失内容驱逐",
    );
});
