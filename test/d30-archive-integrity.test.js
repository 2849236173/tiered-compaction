/**
 * D30（beta3 审计 S2/S3/S5/S6/S7/S8）：存档归属、原子落盘、文件名消毒、状态 API 不回传路径。
 *
 * 会话级用例走真实宿主 `Session.create`（自检规矩 R5/R6）。
 *
 * 运行：node --test test/d30-archive-integrity.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { spillIfNeeded, restoreSpilled, sanitizeArchiveName, sha256 } from "../src/spill-to-disk.js";
import { arbitrate } from "../src/circuit-breaker.js";
import { Lineage } from "../src/lineage.js";
import { ToolResultObserver } from "../src/tool-result-observer.js";
import { TieredCompactionEngine } from "../src/engine.js";
import { Session, wire, seedTool, eventsOf, settle, quietLogger, skipWithoutHost } from "./d30-helpers.js";

const foldOnly = () => Array.from({ length: 200 }, () => "repeat line abcdefghij").join("\n");
const foldAndSpill = () =>
    `${Array.from({ length: 400 }, () => "same repeated log line with some width ......").join("\n")}\n${"y".repeat(9000)}`;

test("S5 折叠与落盘同时命中只写一份存档，落盘复用折叠存档", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d30-s5-"));
    const lineage = new Lineage();
    const text = foldAndSpill();
    const result = await arbitrate(text, { seq: 7, sessionId: "session-aaaaaaaa" }, { archiveDir: dir, lineage });
    assert.deepEqual(result.layers, ["lossless-fold", "fold-archive", "spill-to-disk"]);
    const files = await readdir(dir);
    assert.equal(files.length, 1, `只应有一份存档，实际 ${files.join(",")}`);
    assert.equal(await readFile(result.archive.path, "utf8"), text, "存档是原文全文");
    const kinds = lineage.toArray();
    assert.equal(kinds.find((e) => e.replacedBy === "spill-to-disk").newLocation, result.archive.path);
    assert.equal(kinds.find((e) => e.replacedBy === "lossless-fold").newLocation, result.archive.path);
    assert.ok(result.text.length < text.length, "表面拿到的是预览");
});

test("S6 只折叠不落盘时 arbitrate 也返回本次存档", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d30-s6-"));
    const result = await arbitrate(foldOnly(), { seq: 9, sessionId: "session-bbbbbbbb" }, { archiveDir: dir, lineage: new Lineage() });
    assert.deepEqual(result.layers, ["lossless-fold", "fold-archive"]);
    assert.ok(result.archive?.path, "只折叠也要有存档入口");
    assert.equal(result.archive.size, Buffer.byteLength(foldOnly(), "utf8"));
    assert.equal(await restoreSpilled(result.archive.path, result.archive.sha256, { archiveDir: dir }), foldOnly());
});

test("S2/S6 跨会话同 seq：B 的预览挂 B 自己的存档，不串到 A", { skip: skipWithoutHost }, async () => {
    const archiveDir = await mkdtemp(join(tmpdir(), "d30-s2-"));
    const engine = new TieredCompactionEngine({ archiveDir, logger: quietLogger });
    const listeners = [];
    const observer = new ToolResultObserver({
        engine,
        ctx: { logger: quietLogger, on: (name, fn) => { if (name === "session/event") listeners.push(fn); } },
    });
    observer.register();
    const A = Session.create("session-AAAAAAAA-1111-0000");
    const B = Session.create("session-BBBBBBBB-2222-0000");
    wire(A, listeners);
    wire(B, listeners);
    const a = seedTool(A, `A-secret-${"z".repeat(9000)}`);
    const b = seedTool(B, foldOnly());
    assert.equal(a.seq, b.seq, "夹具前提：两个会话的工具结果同 seq");
    await settle();
    const textOf = (session) => eventsOf(session).at(-1).data.message.content[0].text;
    const aPath = /存档：(.+?)（/.exec(textOf(A))?.[1];
    const bPath = /存档：(.+?)（/.exec(textOf(B))?.[1];
    assert.ok(aPath && bPath, "两边预览都必须给出存档入口（S6：只折叠也给）");
    assert.notEqual(aPath, bPath);
    // 文件名带会话 id 末 8 位（spillBaseName）
    assert.ok(basename(bPath).includes(B.id.slice(-8)), "B 的预览指向 B 的存档");
    assert.equal(await readFile(bPath, "utf8"), foldOnly());
    // 谱系键带会话维度
    const locations = engine.lineage.toArray().map((e) => e.originalLocation);
    assert.ok(locations.includes(`${A.id}#node#${a.seq}`));
    assert.ok(locations.includes(`${B.id}#node#${b.seq}`));
});

test("S3 落盘原子：无残留临时文件，同名不覆盖已有存档", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d30-s3-"));
    const occupied = join(dir, "same-name.txt");
    await writeFile(occupied, "pre-existing");
    const first = await spillIfNeeded("a".repeat(9000), dir, "same-name");
    const second = await spillIfNeeded("b".repeat(9000), dir, "same-name");
    assert.equal(await readFile(occupied, "utf8"), "pre-existing", "已有文件不得被覆盖");
    assert.equal(basename(first.path), "same-name-2.txt");
    assert.equal(basename(second.path), "same-name-3.txt");
    assert.equal(await readFile(first.path, "utf8"), "a".repeat(9000));
    assert.equal(first.sha256, sha256("a".repeat(9000)));
    const files = await readdir(dir);
    assert.equal(files.filter((n) => n.includes(".tmp-")).length, 0, "临时文件必须清掉");
    assert.equal(files.length, 3);
});

test("S3 放置失败时临时文件被删除（候选名全被占）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d30-s3f-"));
    const { mkdir } = await import("node:fs/promises");
    // 1000 个候选名全部被目录占住：tmp 已写好，但 link/wx 全部 EEXIST → 抛错
    await mkdir(join(dir, "full.txt"));
    await Promise.all(Array.from({ length: 999 }, (_, i) => mkdir(join(dir, `full-${i + 2}.txt`))));
    await assert.rejects(() => spillIfNeeded("c".repeat(9000), dir, "full"), /拒绝落盘以免覆盖/);
    const files = await readdir(dir);
    assert.equal(files.filter((n) => n.includes(".tmp-")).length, 0, "失败路径必须删掉临时文件");
    assert.equal(files.length, 1000);
});
test("S7 文件名白名单消毒：ADS 冒号、通配符、保留设备名、结尾点空格", async () => {
    const cases = {
        "goal-switch-a:b-node1": "goal-switch-a-b-node1",
        "goal-switch-a?b-node1": "goal-switch-a-b-node1",
        "a*b|c<d>e\"f": "a-b-c-d-e-f",
        CON: "_CON",
        nul: "_nul",
        "COM1.log": "_COM1.log",
        LPT9: "_LPT9",
        "trail. ": "trail.-",
        "trail...": "trail",
        "..\\..\\evil": "-..-evil".replace(/^[.\-]+/, ""),
        "中文-名字_1": "中文-名字_1",
        "": "archive",
    };
    for (const [input, expected] of Object.entries(cases)) {
        const out = sanitizeArchiveName(input);
        assert.equal(out, expected, JSON.stringify(input));
        assert.match(out, /^[\w.\-\u4e00-\u9fff]+$/);
        assert.ok(!/[.\s]$/.test(out), "不得以点或空格结尾");
    }
    const dir = await mkdtemp(join(tmpdir(), "d30-s7-"));
    for (const input of ["goal-switch-a:b-node1", "goal-switch-a?b-node1", "CON", "trail. "]) {
        const spilled = await spillIfNeeded("q".repeat(9000), dir, input);
        assert.equal(await restoreSpilled(spilled.path, spilled.sha256, { archiveDir: dir }), "q".repeat(9000));
    }
    const listing = await readdir(dir);
    assert.equal(listing.length, 4, `四个输入四个可见文件（无 ADS），实际 ${listing.join(",")}`);
});

test("S8 状态 API 只回 hasArchiveDir 布尔，不回传绝对路径", async () => {
    const { Context, Service } = await import("@deepseek-ai/cordis");
    const { apply } = await import("../src/index.js");
    const { STATUS_ROUTE_PATH } = await import("../src/status-route.js");
    const dir = await mkdtemp(join(tmpdir(), "d30-s8-"));
    const specs = [];
    class WebServerStub extends Service {
        constructor(c) { super(c, "webServer"); }
        register(spec) { specs.push(spec); return () => {}; }
    }
    class MeterStub extends Service { constructor(c) { super(c, "tokenMeter"); } }
    class LlmStub extends Service { constructor(c) { super(c, "llm"); } }
    class SessionsStub extends Service { constructor(c) { super(c, "sessions"); } }
    const ctx = new Context();
    for (const P of [MeterStub, LlmStub, SessionsStub, WebServerStub]) await ctx.plugin(P, {});
    await apply(ctx, { enabled: true, archiveDir: dir, summarizeFn: async () => "s", summaryTarget: { provider: "t", model: "t" } });
    const res = { statusCode: 0, body: "", setHeader() {}, end(b) { this.body = b ?? ""; } };
    specs.find((s) => s.path === STATUS_ROUTE_PATH).handler({ method: "GET" }, res);
    const payload = JSON.parse(res.body);
    assert.equal(payload.hasArchiveDir, true);
    assert.ok(!("archiveDir" in payload));
    assert.ok(!res.body.includes(basename(dir)), "响应体里不得出现存档目录名");
});
