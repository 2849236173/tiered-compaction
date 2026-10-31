/**
 * 选区必须按表面位置切片，不能按 seq 数值区间过滤（D17 沙箱实测挖出的第四个真 bug）。
 *
 * 缺陷（2026-10-27 沙箱验证暴露）：
 *   `_runTransaction` 用 `surfaceNodes.filter(seq => seq >= start && seq <= end)`
 *   取选区。但**表面上的 seq 不是单调递增的**：一次 replace 会把新事件的 seq
 *   放回被替换节点原来的位置（压缩检查点就插在旧位置）。
 *
 *   于是过滤会漏掉「位置在区间内、但 seq 数值在区间外」的节点，首尾比对
 *   必然失败，报：
 *     compaction: the selected span is no longer a valid replacement target
 *
 *   更隐蔽的是：过滤得到的 shadowedSeqs 与稳定性校验（用位置切片计算期望值）
 *   对不上，于是校验必然判「选区变动」，报：
 *     the selected span changed during summarization; refusing to commit
 *
 *   实测证据（小窗口沙箱单次会话）：4 次前者、13 次后者，
 *   而真正成功的摘要只有 2 次——绝大多数事务败在选区口径不一致上。
 *
 * 原版 basic 全程用位置索引：
 *   prepareCompaction / assertSelectedSpanStable 都是 nodes.slice(startIdx, endIdx + 1)。
 *
 * 运行：node --test test/d17-span-positional.test.js
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

function makeCtx() {
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* () {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "简短检查点" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "简短检查点" } };
            yield { type: "finish", reason: { kind: "stop" } };
        },
    });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: 0, nodes: [] }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;
    return ctx;
}

/**
 * 造一个**表面 seq 非单调**的会话桩——这正是真实宿主在发生 replace 之后的形状。
 *
 * 真实语义：append 分配递增 seq；但 surfaceOp: replace 不改变节点位置，
 * 只把「该位置上的 seq」换成新事件的 seq。所以表面数组里的数值可以乱序。
 */
function makeSessionWithNonMonotonicSurface() {
    const log = [];
    const nodes = [];
    const listeners = [];

    const session = {
        get seq() {
            return log.length;
        },
        surface: { nodes },
        requestHeader: () => ({ config: { provider: "test-provider", model: "test-model" } }),
        requestContext: () => ({ provider: "test-provider", model: "test-model", contextWindow: 1000000 }),
        eventAt: (seq) => log.find((e) => e.seq === seq),
        /** 与宿主 ctx.on("session/event", ...) 同构的注册面。 */
        on(type, listener) {
            if (type !== "session/event") return () => {};
            listeners.push(listener);
            return () => {
                const at = listeners.indexOf(listener);
                if (at !== -1) listeners.splice(at, 1);
            };
        },
        append(type, data, options = {}) {
            const seq = log.length;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                const at = nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) {
                    const removeCount = nodes.filter(
                        (s) => s >= options.surfaceOp.startSeq && s <= options.surfaceOp.endSeq,
                    ).length;
                    nodes.splice(at, Math.max(1, removeCount), seq);
                }
            } else if (["user/message", "assistant/message", "tool/result"].includes(type)) {
                nodes.push(seq);
            }
            // 宿主语义：append 同步派发 session/event，不 await 返回的 Promise
            for (const listener of listeners) {
                try {
                    const result = listener(session, event);
                    if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
                } catch { /* 宿主也是 catch 掉监听者的同步异常 */ }
            }
            return event;
        },
        log,
        nodes,
    };
    return session;
}

test("表面 seq 非单调时，事务必须按位置取到整段选区（不得误报「不是有效替换目标」）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "spanpos-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeSessionWithNonMonotonicSurface();
    // 造历史：seq 0、1 两条消息
    session.append("user/message", { content: "旧历史一".repeat(200) });
    session.append("user/message", { content: "旧历史二".repeat(200) });

    // 关键：模拟一次已发生的 replace —— 把位置 0 的节点换成一个**大号 seq**。
    // 此后表面 = [大号seq, 1]，数值不再单调，但位置顺序完好。
    session.append("compaction/start", { compactionId: "prev" });
    session.append("user/message", { content: "更早的检查点" }, {
        surfaceOp: { op: "replace", startSeq: 0, endSeq: 0 },
    });
    session.append("compaction/end", { compactionId: "prev" });

    assert.ok(
        session.surface.nodes[0] > session.surface.nodes[1],
        "测试前提：表面 seq 必须非单调（本用例的全部意义）",
    );

    // 现在对整个表面做一次压缩：选 start=位置0 的 seq, end=位置1 的 seq。
    // 旧实现按数值过滤会得到空区间或错区间，必然抛「不是有效替换目标」。
    const start = session.surface.nodes[0];
    const end = session.surface.nodes[1];

    const result = await service._runTransaction(session, start, end, { session }, undefined);

    assert.ok(result !== null && result !== undefined, "事务必须成功，不得误报无效选区");
    assert.deepEqual(
        result.shadowedSeqs,
        [start, end],
        `选区必须是表面上这两段（按位置），实得 ${JSON.stringify(result.shadowedSeqs)}`,
    );
    // 且真的写入了替换事件（说明提交成功，不是半途返回）
    const replaced = session.log.filter((e) => e.surfaceOp?.op === "replace");
    assert.equal(replaced.length, 2, "本次替换事件必须写入（前一次 prev 也算一条）");
});
