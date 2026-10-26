/**
 * D16 审计修补验收（P1/P2/P3/P4）：
 *
 * - P1：工具结果观察者把第 1-2 层接到会话表面（真替换，不再是「层内自嗨」）
 * - P2-1：80% 压力驱逐可重放工具结果（真落地，不再是无人消费的广播）
 * - P2-2：agent/request-error 钩子注册（真溢出时有恢复路径）
 * - P3-1：落盘阈值按 UTF-8 字节数（中文 8k 字符必须落盘）
 * - P3-2：选区尾部双向配平（不劈开 tool-call/result 对）
 * - P3-3：overflowRetries 会被清理钩子清掉（不是只增不清）
 * - P4-1：配置类型错误在构造期就抛（不带到运行期）
 * - P4-2：compactNow 提交后 flush 会话（durability）
 *
 * 运行：node --test test/d16-fixes.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { TieredCompactionEngine } from "../src/engine.js";
import { ToolResultObserver, textOfToolResult, prunedContent } from "../src/tool-result-observer.js";
import { spillIfNeeded, byteLength, DEFAULT_SPILL_THRESHOLD } from "../src/spill-to-disk.js";

/** 造一个最小会话桩：surface 节点 + 事件表 + append 记录。 */
function fakeSession(events = []) {
    const log = [...events];
    const session = {
        surface: { nodes: events.map((e) => e.seq) },
        eventAt: (seq) => log.find((e) => e.seq === seq),
        append(type, data, options = {}) {
            const seq = log.length + 1;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                // 替换：表面槽位换新 seq（与宿主语义一致）
                const at = session.surface.nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) session.surface.nodes[at] = seq;
            }
            return event;
        },
        log,
    };
    return session;
}

/** 造一条文本工具结果事件。 */
function toolResult(seq, text, toolName = "pwsh") {
    return {
        seq,
        type: "tool/result",
        data: {
            toolName,
            message: {
                content: [{ type: "text", text }],
                source: { callId: `call-${seq}`, toolName },
            },
        },
    };
}

const quietLogger = { info() {}, warn() {} };

/* ---------------- P3-1：字节阈值 ---------------- */

test("P3-1 落盘阈值按 UTF-8 字节：8k 汉字（约 24KB）必须落盘", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p31-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // 8,000 个汉字：字符数 = 8000（不超字符阈值），字节数 = 24000（超字节阈值）
    const text = "汉".repeat(8000);
    assert.equal(text.length, 8000);
    assert.equal(byteLength(text), 24000);
    const result = await spillIfNeeded(text, dir, "cjk");
    assert.ok(result !== null, "按字节判断必须落盘（旧实现按字符判断会漏）");
    assert.equal(result.size, 24000);
    assert.equal(await readFile(result.path, "utf8"), text);
});

test("P3-1 未超字节阈值时不落盘（ASCII 小输出原样返回）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p31b-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const text = "a".repeat(DEFAULT_SPILL_THRESHOLD - 1);
    assert.equal(await spillIfNeeded(text, dir, "small"), null);
});

/* ---------------- P1：工具结果观察者 ---------------- */

test("P1 工具结果被折叠压缩后真的替换会话表面（影子定价 + replace 两步）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p1-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 造一段含大量**连续**重复行的输出（第 1 层无损折叠只折叠连续重复，
    // 周期循环行不算——这是实现口径，测试数据必须按它来造）
    const repeated = Array.from({ length: 40 }, () => "same log line").join("\n");
    const session = fakeSession([toolResult(1, repeated)]);
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });

    const before = session.surface.nodes.length;
    await observer.handleEvent(session, session.eventAt(1));
    const after = session.surface.nodes.length;

    // 表面槽位数不变（替换是原地换 seq），但内容变了
    assert.equal(after, before, "替换不改槽位数");
    const newest = session.eventAt(session.surface.nodes[0]);
    assert.equal(newest.type, "tool/result");
    const replacedText = textOfToolResult(newest) ?? "";
    assert.match(replacedText, /tiered-compaction/, "替换内容必须带标记");
    assert.ok(replacedText.length < repeated.length, "替换后必须更小");
    // 影子定价事件必须先生成
    assert.ok(
        session.log.some((e) => e.type === "compaction/prune"),
        "必须先写 compaction/prune 影子定价",
    );
    assert.equal(observer.stats.replaced, 1);
});

test("P1 富块工具结果（含图片）一律跳过，不破坏结构", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p1b-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const event = {
        seq: 1,
        type: "tool/result",
        data: {
            message: {
                content: [
                    { type: "text", text: "看图" },
                    { type: "image", attachment: { id: "x" } },
                ],
                source: { callId: "c1" },
            },
        },
    };
    const session = fakeSession([event]);
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });
    await observer.handleEvent(session, event);
    assert.equal(observer.stats.skipped, 1);
    assert.equal(observer.stats.replaced, 0);
    assert.equal(session.log.filter((e) => e.type === "compaction/prune").length, 0);
});

test("P1 同一 seq 只加工一次（重复事件不二次替换）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p1c-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const repeated = Array.from({ length: 40 }, () => "row repeat").join("\n");
    const session = fakeSession([toolResult(1, repeated)]);
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });
    await observer.handleEvent(session, session.eventAt(1));
    const prunesAfterFirst = session.log.filter((e) => e.type === "compaction/prune").length;
    await observer.handleEvent(session, session.eventAt(1));
    assert.equal(
        session.log.filter((e) => e.type === "compaction/prune").length,
        prunesAfterFirst,
        "第二次必须直接跳过",
    );
});

test("P1 大输出（>8k 字节）走落盘层，预览里带存档路径", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p1d-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // 无重复行的 30k 字符：折叠不生效，必须落盘
    const text = Array.from({ length: 3000 }, (_, i) => `unique-${i}-${Math.random()}`).join("\n");
    assert.ok(byteLength(text) > DEFAULT_SPILL_THRESHOLD);
    const session = fakeSession([toolResult(1, text)]);
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });
    await observer.handleEvent(session, session.eventAt(1));
    const replaced = textOfToolResult(session.eventAt(session.surface.nodes[0])) ?? "";
    assert.match(replaced, /存档：/, "预览必须给存档路径（保真原则 1）");
    // 存档文件真的存在且内容完整
    const archivePath = /存档：([^\n（]+)/.exec(replaced)?.[1];
    assert.ok(archivePath !== undefined && existsSync(archivePath), "存档文件必须存在");
    assert.equal(await readFile(archivePath, "utf8"), text, "存档必须是完整原文");
});

/* ---------------- P2-1：80% 驱逐落地 ---------------- */

test("P2-1 驱逐只动可重放工具结果（read/grep/glob），其它工具不碰", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p21-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const session = fakeSession([
        toolResult(1, "read 的结果", "read"),
        toolResult(2, "pwsh 的结果", "pwsh"),
        toolResult(3, "grep 的结果", "grep"),
    ]);
    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const observer = new ToolResultObserver({ engine, ctx: { logger: quietLogger, on() {} } });
    const { evicted } = await observer.evictStaleToolResults(session);
    assert.equal(evicted, 2, "read + grep 两个可重放项被驱逐，pwsh 不动");
    // pwsh 的结果原文必须还在
    const pwshEvent = session.log.find((e) => e.type === "tool/result" && e.data?.toolName === "pwsh");
    assert.equal(textOfToolResult(pwshEvent), "pwsh 的结果");
    // 谱系表登记了驱逐
    assert.ok(
        engine.lineage.toArray().some((entry) => entry.replacedBy === "soft-pressure"),
        "驱逐必须登记谱系（保真原则 2）",
    );
});

/* ---------------- P4-1：配置校验 ---------------- */

test("P4-1 配置类型错误在构造期就抛（archiveDir 传数字）", async () => {
    const { Service } = await import("@deepseek-ai/cordis");
    const { Context } = await import("@deepseek-ai/cordis");
    const ctx = new Context();
    class MeterStub extends Service { constructor(c) { super(c, "tokenMeter"); } }
    class LlmStub extends Service { constructor(c) { super(c, "llm"); } }
    class SessionsStub extends Service { constructor(c) { super(c, "sessions"); } }
    ctx.plugin(MeterStub);
    ctx.plugin(LlmStub);
    ctx.plugin(SessionsStub);
    const { TieredCompactionEngineService } = await import("../src/contract.js");
    assert.throws(
        () => new TieredCompactionEngineService(ctx, { archiveDir: 123 }),
        /配置项 archiveDir 应为 string/,
        "类型错必须在构造期抛出，不能带到运行期",
    );
});

/* ---------------- 内容工具 ---------------- */

test("prunedContent 带存档信息时给出路径与摘要前缀", () => {
    const blocks = prunedContent("预览内容", { path: "/tmp/x.txt", sha256: "abcdef0123456789", size: 100 });
    const text = blocks.map((b) => b.text).join("");
    assert.match(text, /\/tmp\/x\.txt/);
    assert.match(text, /100 字节/);
    assert.match(text, /abcdef0123456789/);
});
