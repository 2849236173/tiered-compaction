/**
 * 系统审计发现的 4 个 P0 的回归测试（2026-10-27）。
 *
 * 这些 bug 的共同点：**现有 16 条测试全绿也一条都抓不到**。
 * 因为它们只覆盖「单会话、单次调用、表面变了」，
 * 而 P0 全部藏在「多会话 / 连续多轮 / 落盘内容是否正确」这些维度里。
 *
 * 本文件专测那四个维度。
 *
 * 运行：node --test test/d17-audit-p0.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolResultObserver } from "../src/tool-result-observer.js";
import { arbitrate } from "../src/circuit-breaker.js";
import { TieredCompactionEngine } from "../src/engine.js";
import { Lineage } from "../src/lineage.js";

const quietLogger = { info() {}, warn() {} };

/** 造会话桩：seq 从 0 开始（真实语义）。 */
function makeSession(id) {
    const log = [];
    const nodes = [];
    return {
        id,
        surface: { nodes },
        eventAt: (s) => log.find((e) => e.seq === s),
        append(type, data, options = {}) {
            const seq = log.length;
            log.push({ seq, type, data, ...options });
            if (options.surfaceOp?.op === "replace") {
                const at = nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) nodes[at] = seq;
            } else if (type === "tool/result") {
                nodes.push(seq);
            }
            return { seq };
        },
        log,
    };
}

function addReadResult(session, text, { isError = false } = {}) {
    const callId = `c${session.log.length}`;
    session.append("tool/call", { callId, name: "read", arguments: "{}" });
    session.append("tool/result", {
        message: {
            role: "tool",
            source: { kind: "tool", callId },
            toolCallId: callId,
            content: [{ type: "text", text }],
            isError,
        },
        meta: { path: "a.js" },
    });
}

function makeObserver() {
    const engine = {
        async processToolOutput(text) {
            return { text: text + "!", layers: ["fold"] };
        },
        lastSpillInfo: () => ({}),
        lineage: { record() {} },
    };
    const ctx = { logger: quietLogger, on() {} };
    return { observer: new ToolResultObserver({ engine, ctx }), engine };
}

/* ---------------- P0-1：跨会话串味 ---------------- */

test("P0-1 同一 observer 处理多个会话时，后续会话必须照常工作", async () => {
    const { observer } = makeObserver();

    const a = makeSession("A");
    for (let i = 0; i < 3; i += 1) addReadResult(a, "内容".repeat(100));
    for (const seq of [...a.surface.nodes]) await observer.handleEvent(a, a.eventAt(seq));
    const afterA = observer.stats.replaced;
    assert.equal(afterA, 3, "会话 A 应处理 3 条");

    // 会话 B 的 seq 同样从 0 开始——旧实现会全部命中 A 的记录
    const b = makeSession("B");
    for (let i = 0; i < 3; i += 1) addReadResult(b, "内容".repeat(100));
    for (const seq of [...b.surface.nodes]) await observer.handleEvent(b, b.eventAt(seq));

    assert.equal(
        observer.stats.replaced - afterA,
        3,
        "会话 B 必须照常处理 3 条——旧实现因 done 只按 seq 记账，" +
        "第二个会话起全部被挡，且零报错（第一个会话之后压缩就静默失效）",
    );
});

test("P0-1 三个连续新会话都必须工作（不只第二个）", async () => {
    const { observer } = makeObserver();
    for (const name of ["X", "Y", "Z"]) {
        const s = makeSession(name);
        addReadResult(s, "内容".repeat(100));
        const before = observer.stats.replaced;
        for (const seq of [...s.surface.nodes]) await observer.handleEvent(s, s.eventAt(seq));
        assert.equal(observer.stats.replaced - before, 1, `会话 ${name} 必须被处理`);
    }
});

/* ---------------- P0-2：重复驱逐 ---------------- */

test("P0-2 连续多轮驱逐不得重复吃同一节点（否则每轮追加 2 条事件、无限膨胀）", async () => {
    const { observer } = makeObserver();
    const s = makeSession("E");
    addReadResult(s, "内容".repeat(200));

    const round1 = await observer.evictStaleToolResults(s);
    assert.equal(round1.evicted, 1, "第一轮应驱逐 1 个");
    const eventsAfter1 = s.log.length;

    for (let round = 2; round <= 5; round += 1) {
        const r = await observer.evictStaleToolResults(s);
        assert.equal(r.evicted, 0, `第 ${round} 轮不得再驱逐同一节点`);
    }
    assert.equal(
        s.log.length,
        eventsAfter1,
        `事件数必须停在 ${eventsAfter1}——旧实现每轮 +2，pre-step 每步都调，" +
        "压力不降就无限增长`,
    );
});

/* ---------------- P0-3：落盘必须是原文 ---------------- */

test("P0-3 落盘的必须是原始文本，不能是折叠产物（否则存档不可独立还原）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p03-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const lineage = new Lineage();
    // 可折叠的重复 + 大量唯一行，使折叠后仍 >8k
    const parts = [Array(50).fill("重复行 repeated line").join("\n")];
    for (let i = 0; i < 300; i += 1) parts.push(`唯一行-${i}-` + "z".repeat(40));
    const original = parts.join("\n");

    const result = await arbitrate(original, { seq: 1, sessionId: "S" }, { archiveDir: dir, lineage });
    assert.ok(result.layers.includes("spill-to-disk"), "本用例必须真的落盘");

    const rec = lineage.toArray().find((x) => x.replacedBy === "spill-to-disk");
    const onDisk = await readFile(rec.newLocation, "utf8");

    assert.equal(
        onDisk,
        original,
        "存档必须逐字节等于原始文本——旧实现存的是折叠产物，" +
        "而折叠记录只在内存、重启即丢，「落盘=完整备份」是假的",
    );
    assert.doesNotMatch(onDisk, /…\[folded/, "存档里不得出现折叠标记");
});

/* ---------------- P0-4：重复注册 ---------------- */

test("P0-4 同一 observer 重复 register() 只能注册一次监听", async () => {
    let onCalls = 0;
    const engine = {
        async processToolOutput(text) { return { text, layers: [] }; },
        lastSpillInfo: () => ({}),
        lineage: { record() {} },
    };
    const ctx = { logger: quietLogger, on() { onCalls += 1; } };
    const observer = new ToolResultObserver({ engine, ctx });

    observer.register();
    observer.register();
    observer.register();

    assert.equal(
        onCalls,
        1,
        "只能注册 1 次——双实例/重复注册会产生悬空 compaction/prune，" +
        "污染宿主计量折叠链（has no adjacent shadow price）",
    );
});

/* ---------------- P1-1 / P1-2 / P2-2：驱逐的三条判据 ---------------- */

test("P1-1 驱逐必须保留第 1-2 层写入的存档路径（模型回读原文的唯一线索）", async () => {
    const { observer } = makeObserver();
    const s = makeSession("K");
    addReadResult(s, "[tiered-compaction 预览]\n内容\n存档：C:\\archive\\abc.txt（25089 字节）".repeat(5));

    await observer.evictStaleToolResults(s);
    const latest = s.eventAt(s.surface.nodes[0]);
    const text = (latest.data.message.content ?? []).map((b) => b.text ?? "").join("");

    assert.match(
        text,
        /原存档仍在：/,
        "存档路径必须保留（输出里写作「原存档仍在：」），否则原文在磁盘上但模型拿不到路径",
    );
    assert.match(text, /abc\.txt/, "必须保留具体文件名");
});

test("P1-2 失败的工具结果不得驱逐（错误信息是排障唯一线索）", async () => {
    const { observer } = makeObserver();
    const s = makeSession("F");
    addReadResult(s, "ENOENT: no such file or directory", { isError: true });

    const r = await observer.evictStaleToolResults(s);
    assert.equal(r.evicted, 0, "isError 的结果抹掉后模型只会盲目重跑同一命令");
});

test("P2-2 驱逐必须有净收益判据（不能把短内容换成更长的提示）", async () => {
    const { observer } = makeObserver();
    const s = makeSession("T");
    addReadResult(s, "ok"); // 2 字节，驱逐提示约 58 字节

    const r = await observer.evictStaleToolResults(s);
    assert.equal(r.evicted, 0, "越驱越大不算压缩——该跳过");
});

/* ---------------- P1-3：谱系字段语义 ---------------- */

test("P1-3 驱逐的谱系必须按契约逐节点登记（originalLocation = node#seq）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p13-"));
    try {
        const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
        const ctx = { logger: quietLogger, on() {} };
        const observer = new ToolResultObserver({ engine, ctx });
        const s = makeSession("L");
        addReadResult(s, "内容".repeat(200));

        await observer.evictStaleToolResults(s);

        const entries = engine.lineage.toArray().filter((e) => e.replacedBy === "soft-pressure");
        assert.equal(entries.length, 1, "每个被驱逐节点必须各有一条记录");
        assert.match(
            entries[0].originalLocation,
            /^node#\d+$/,
            "originalLocation 必须是 node#<seq>，否则 findByOriginal 查不到",
        );
        // 查询面必须能命中
        assert.equal(
            engine.lineage.findByOriginal(entries[0].originalLocation).length,
            1,
            "保真原则 2 的查询面必须对第 3 层有效",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
