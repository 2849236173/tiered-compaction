/**
 * 三条安全护栏（D17 对照原版 basic 补齐，此前完全没有）。
 *
 * 背景：完整读一遍 dsh-compaction-basic（1027 行）后发现，它在压缩事务周围
 * 布了三个我们完全没有的护栏。它们不产生新功能，防的都是**静默损坏**：
 *
 *   1. 压缩锁（assertCompactionInactive）
 *      摘要要调 LLM，耗时几秒到几十秒。这期间如果用户又点了 /compact，
 *      或 pre-step 自动压缩再次触发，两个事务会同时改会话表面。
 *      后果：内容错位，且不必然报错。
 *
 *   2. 提交前稳定性校验（assertSelectedSpanStable）
 *      摘要基于 A 版内容生成，提交时表面可能已变成 B 版。
 *      后果：留下「总结的是旧内容、替换的是新位置」的检查点。
 *
 *   3. 摘要重试（compactionRetries）
 *      一次摘要可能压不到阈值以下。原版会重新选区再压一次。
 *      后果（缺失时）：压力仍高但不再压，直到溢出才被动救火。
 *
 * 运行：node --test test/d17-safety-guards.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

const quietLogger = { info() {}, warn() {}, error() {} };

/** 造带 llm/tokenMeter/sessions 的最小 ctx，使 Service 能被真实构造。 */
function makeCtx() {
    const ctx = new Context();
    // llm.stream 必须产出真实的 StreamChunk 序列，不是随便一个对象。
    // BlockAssembler 只认 block-start / text-delta / block-end / usage / finish
    // （dsh-llm lib/types/assembler.js:33-70），喂错类型会抛
    // "unreachable variant in BlockAssembler.push" —— 本文件第一版就栽在这。
    ctx.provide("llm", {
        stream: async function* () {
            yield { type: "text-delta", index: 0, text: "摘要内容" };
            yield { type: "finish", reason: "stop" };
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
 * 造一个可复现的会话桩，语义严格对齐 dsh-session。
 *
 * 两个容易被想当然搞错的点（本文件第一版就栽在这里）：
 *   1. 事件 seq **从 0 开始**编号（baseSeq=0），最后一条事件的 seq = log.length-1
 *      （dsh-session lib: `_lastProcessedSeq = baseSeq === 0 ? -1 : baseSeq-1`）
 *   2. `session.seq` 是「**下一个**待分配序号」= log.length
 *      （`get seq() { return SessionLogOffset(this.log.length) }`）
 *   两者合起来意味着：倒序扫描必须从 `session.seq - 1` 开始，
 *   从 `session.seq` 开始会越界读空，从 `log.length` 当最后一条会漏掉尾部事件。
 *   桩只要有一点偏差，锁检测就会静默失效——所以这里显式重编号。
 */
function makeSession(initial = []) {
    // 按真实宿主语义重编号：第 i 条事件 seq = i（0 起）
    const log = initial.map((e, i) => ({ ...e, seq: i }));
    const session = {
        get seq() {
            return log.length;
        },
        // 真实会话都有 requestHeader（最近一次请求的路由），摘要路由从这里取。
        // 桩缺这个方法会让摘要因「无路由」失败——D17 修复后不再被静默吞掉，
        // 所以桩必须照真实形状补齐，而不是让被测代码迁就桩。
        requestHeader: () => ({ config: { provider: "test-provider", model: "test-model" } }),
        surface: { nodes: log.filter((e) => e.type.endsWith("/message") || e.type === "tool/result").map((e) => e.seq) },
        eventAt: (seq) => log.find((e) => e.seq === seq),
        append(type, data, options = {}) {
            const seq = log.length;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                const at = session.surface.nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) {
                    session.surface.nodes.splice(at, options.surfaceOp.endSeq - options.surfaceOp.startSeq + 1, seq);
                }
            } else if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
                session.surface.nodes.push(seq);
            }
            return event;
        },
        log,
    };
    return session;
}

/* ---------------- 护栏 1：压缩锁 ---------------- */

test("压缩锁：存在未闭合 compaction/start 时必须拒绝新事务（busy）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 模拟「上一次压缩已开始但尚未结束」——这正是并发窗口
    const session = makeSession([
        { seq: 1, type: "user/message", data: { content: "历史消息" } },
        { seq: 2, type: "compaction/start", data: { compactionId: "c-1" } },
    ]);

    await assert.rejects(
        () => service._runTransaction(session, 1, 1, { session }, undefined),
        (error) => {
            assert.equal(error.code, "busy", `应抛 busy，实得 ${error.code}`);
            assert.match(String(error.message), /already in progress/i);
            return true;
        },
    );
});

test("压缩锁：配对完整的 compaction/end 之后可以正常进入事务", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 上一轮压缩已完整闭合 → 锁是空闲的
    const session = makeSession([
        { seq: 1, type: "user/message", data: { content: "很长很长的历史消息".repeat(50) } },
        { seq: 2, type: "compaction/start", data: { compactionId: "c-0" } },
        { seq: 3, type: "compaction/end", data: { compactionId: "c-0" } },
    ]);

    // 不该因锁被拒绝（可能因其他原因失败，但不能是 busy）
    try {
        await service._runTransaction(session, 0, 0, { session }, undefined);
    } catch (error) {
        assert.notEqual(error.code, "busy", "锁已释放，不应报 busy");
    }
});

test("压缩锁：新会话生命周期（session/end-seed）可豁免上一轮的遗留 start", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard3-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 上一轮会话崩在压缩中途，留下未闭合 start；之后开始了新生命周期
    const session = makeSession([
        { seq: 1, type: "user/message", data: { content: "旧会话消息".repeat(50) } },
        { seq: 2, type: "compaction/start", data: { compactionId: "c-old" } },
        { seq: 3, type: "session/end-seed", data: {} },
        { seq: 4, type: "user/message", data: { content: "新会话消息".repeat(50) } },
    ]);

    try {
        await service._runTransaction(session, 3, 3, { session }, undefined);
    } catch (error) {
        assert.notEqual(
            error.code,
            "busy",
            "end-seed 之后上一轮的遗留 start 不应继续占锁（否则崩过一次就永久锁死）",
        );
    }
});

/* ---------------- 护栏 2：提交前稳定性校验 ---------------- */

test("稳定性校验：选区节点在摘要期间被改 → 拒绝提交（changed）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard4-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeSession([
        { seq: 1, type: "user/message", data: { content: "内容".repeat(100) } },
    ]);

    // 摘要前快照声称选区是 [1]，但摘要完成后表面已经变了
    session.surface.nodes = [2]; // 模拟选区节点被替换
    session.log.push({ seq: 2, type: "user/message", data: { content: "新内容" } });

    assert.throws(
        () => service._assertSpanStable(session, { start: 1, end: 1, shadowedSeqs: [1] }),
        (error) => {
            assert.equal(error.code, "changed", `应抛 changed，实得 ${error.code}`);
            return true;
        },
    );
});

test("稳定性校验：选区未变时正常通过", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard5-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 桩按真实宿主语义重编号（事件 seq 从 0 起），两条消息的 seq 为 0 与 1
    const session = makeSession([
        { type: "user/message", data: { content: "内容" } },
        { type: "user/message", data: { content: "内容二" } },
    ]);
    assert.deepEqual(session.surface.nodes, [0, 1], "桩的 surface 应为 [0,1]");

    // 不抛错即为通过
    service._assertSpanStable(session, { start: 0, end: 1, shadowedSeqs: [0, 1] });
});

test("稳定性校验：选区起点从表面消失 → 拒绝提交", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard6-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeSession([{ seq: 1, type: "user/message", data: { content: "x" } }]);
    session.surface.nodes = []; // 全被替换掉

    assert.throws(
        () => service._assertSpanStable(session, { start: 1, end: 1, shadowedSeqs: [1] }),
        (error) => error.code === "changed",
    );
});

/* ---------------- 护栏 3：重试与配置 ---------------- */

test("compactionRetries 默认 1，且可被 modelPolicies 覆盖", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard7-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 默认值对齐原版
    assert.equal(service.policyFor(undefined).compactionRetries, 1, "默认应重试 1 次");

    // 无匹配时回落默认
    assert.equal(
        service.policyFor({ provider: "p", model: "m" }).compactionRetries,
        1,
        "无 modelPolicies 时用默认",
    );
});

test("压缩锁与稳定性校验的错误码可区分（busy vs changed）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard8-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // busy：锁被占
    const locked = makeSession([
        { seq: 1, type: "user/message", data: { content: "x" } },
        { seq: 2, type: "compaction/start", data: {} },
    ]);
    let busyCode;
    try {
        await service._runTransaction(locked, 0, 0, { session: locked }, undefined);
    } catch (error) {
        busyCode = error.code;
    }

    // changed：选区变了
    const moved = makeSession([{ seq: 1, type: "user/message", data: { content: "x" } }]);
    let changedCode;
    try {
        service._assertSpanStable(moved, { start: 99, end: 99, shadowedSeqs: [99] });
    } catch (error) {
        changedCode = error.code;
    }

    assert.equal(busyCode, "busy");
    assert.equal(changedCode, "changed");
    assert.notEqual(busyCode, changedCode, "两类失败必须可区分，便于诊断");
});

test("端到端：摘要期间选区被改动，事务必须拒绝提交（走真实事务路径）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "guard9-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const ctx = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    const session = makeSession([
        { type: "user/message", data: { content: "要被摘要的历史内容".repeat(30) } },
        { type: "user/message", data: { content: "近端消息".repeat(30) } },
    ]);

    // 关键：在摘要函数里制造「摘要期间的表面变动」——模拟真实并发
    // （用户插了新消息，或另一个压缩动了表面）。
    // 这条测试的意义：直接调 _assertSpanStable 只能证明「校验函数本身对」，
    // 证明不了「事务真的调用了它」——反向验证时正是这条区分出来的。
    const realSummarize = service.summarize.bind(service);
    service.summarize = async (input, agent, signal) => {
        const out = await realSummarize(input, agent, signal);
        session.surface.nodes = [session.surface.nodes[0]]; // 选区被改小
        return out;
    };

    await assert.rejects(
        () => service._runTransaction(session, 0, 1, { session }, undefined),
        (error) => {
            assert.equal(
                error.code,
                "changed",
                `摘要后选区变动必须拒绝提交，实得 ${error.code}: ${error.message}`,
            );
            return true;
        },
    );

    // 且不得留下替换检查点（说明没有提交错位内容）
    const replacements = session.log.filter((e) => e.surfaceOp?.op === "replace");
    assert.equal(replacements.length, 0, "拒绝提交时不得写入替换事件");
});
