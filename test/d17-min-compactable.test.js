/**
 * 可压缩区间太小时必须放弃，而不是进事务里注定失败。
 *
 * 缺陷（2026-10-27 用真实生产模型跑沙箱时暴露）：
 *   真实会话窗口 24000、阈值 19680（82%）、retain 收敛后 9840，
 *   而当时可压缩表面总计只有约 11.8k token。
 *
 *   从尾往前累计到 9840 时，只剩**第一个节点（23 token）**可压，
 *   于是每一次摘要都必然失败：
 *     summary is not smaller than the shadowed content (306 >= 23)
 *
 *   实测：第 4 层 3 次事务 3 次失败、0 次成功。每一步都在重试同一件
 *   注定失败的事——既浪费 LLM 调用，也让日志充满噪声。
 *
 *   关键认知：这不是「摘要写得不够短」，而是**选区本身没有压缩空间**。
 *   原版 basic 的 selectCompactableRange 在 keepFromIdx <= firstIdx 时
 *   返回 null（本次不压）；我方口径相同却仍返回了 23 token 的区间。
 *
 *   修法：被取代区间的预估量低于 RESERVE_TOKENS × 5%（1000 token）时
 *   返回 null——不报错、不重试、不花 LLM 调用，语义等同「暂无可压内容」。
 *
 * 运行：node --test test/d17-min-compactable.test.js
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
            yield { type: "text-delta", index: 0, text: "摘要" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "摘要" } };
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
 * 造会话 + 指定每个表面节点的计价 token。
 * 这正是真实 measure(session).nodes 的形状：与表面一一对应、带 tokens。
 */
function makeSession(seqTokens) {
    const log = [];
    const nodes = [];
    const listeners = [];
    const session = {
        get seq() {
            return log.length;
        },
        surface: { nodes },
        requestHeader: () => ({ config: { provider: "p", model: "m" } }),
        requestContext: () => ({ provider: "p", model: "m", contextWindow: 24000 }),
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
                if (at !== -1) nodes[at] = seq;
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
    for (const [i, tokens] of seqTokens.entries()) {
        session.append("user/message", { content: `节点 ${i}` });
    }
    return { session, priced: seqTokens.map((tokens, i) => ({ seq: i, tokens })) };
}

test("可压缩区间低于下限时必须返回 null（不压），不得进事务注定失败", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "minc-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 复刻真实场景：总量约 11.8k，但 retain=9840 只留下一小口
    // 节点：[23, 4741, 140, 5643, 1234] → 从尾累计到 9840 只剩第一个节点
    const { session, priced } = makeSession([23, 4741, 140, 5643, 1234]);

    const range = service._selectRange(session, { nodes: priced }, 9840);

    assert.equal(
        range,
        null,
        "只剩 23 token 可压时必须返回 null——否则摘要必然「比原文大」，" +
        "每一步都白花一次 LLM 调用；这正是实测里 3 次事务 3 次失败的原因",
    );

    // 确认没有留下任何事务痕迹
    assert.equal(
        session.log.filter((e) => e.type.startsWith("compaction/")).length,
        0,
        "放弃时不得写入 compaction/* 事件（不留噪声、不占用锁）",
    );
});

test("可压缩区间足够大时必须正常返回区间，不能因守卫误伤", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "minc2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 总量 30000，retain 9840 → 可压约 20k，远大于下限
    const { session, priced } = makeSession([6000, 6000, 6000, 6000, 6000]);

    const range = service._selectRange(session, { nodes: priced }, 9840);
    assert.ok(range !== null, "可压区间充足时必须返回区间——守卫不能误伤正常压缩");
    assert.equal(range.start, session.surface.nodes[0]);
});
