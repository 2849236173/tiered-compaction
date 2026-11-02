/**
 * 修复工具物理契约测试 + 防回归 tripwire。
 *
 * tripwire 的意义（病案 2026-10-30，勿删）：
 * docs/修复/fix-compaction-turn.mjs 的前身（0.3.x 随 npm 包分发）用
 * zstdCompressSync 把整档压成单帧，违反宿主加载器「首帧必须恰好一行头行」
 * 的判罚，造成 session-1c03a983 等档案潜伏 44 小时后无法加载。
 * 同时该前身的自检用的是宽容校验器 dsh-session-format-v3-to-v4，
 * 发出过假绿灯。本文件锁三层：
 *  ① 帧指纹层：输出帧必须带 zstd 校验位（宿主 CHECKSUM_OPTIONS 同款）；
 *  ② 契约层：validateContract 必须能抓住「单帧整档」旧病产物（不许再假绿灯）；
 *  ③ 行为层：CLI 修复全流程、幂等、大档分帧、fixLines 语义。
 * 将来任何人把脚本改回单帧输出或不带校验位，npm test 在这里当场红灯。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { zstdCompressSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = join(HERE, "..", "..", "docs", "修复", "fix-compaction-turn.mjs");
const TOOL_URL = pathToFileURL(TOOL_PATH).href;

const {
    splitZstdFrames,
    encodeConformant,
    fixLines,
    validateContract,
    compressFrame,
} = await import(TOOL_URL);

let dir; // 每个用例独立的临时目录

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tc-repair-test-"));
});

// —— 合成档案工具 ——

// 造一份会话日志文本：头行 + n 个事件，可选择让 compaction 事件缺 turn
function buildLogText({ brokenTurns = true, turns = 3 } = {}) {
    const header = JSON.stringify({
        schemaVersion: 4,
        sessionId: "session-test",
        createdAt: "2026-10-30T01:00:00.000Z",
        host: "unit-test",
    });
    const evs = [];
    let seq = 0;
    const push = (type, data) =>
        evs.push(JSON.stringify({ seq: seq++, id: `e${seq}`, time: "2026-10-30T01:00:00.000Z", type, data }));
    for (let t = 1; t <= turns; t++) {
        push("turn/start", { turn: t });
        push("user/message", { text: `第 ${t} 轮用户消息 ${"内容".repeat(20)}` });
        push("assistant/message", { text: `第 ${t} 轮助手回复 ${"回应".repeat(20)}` });
        if (t === 2) {
            if (brokenTurns) {
                push("compaction/start", { compactionId: "c2" }); // 病：缺 turn
                push("compaction/summary", { compactionId: "c2" });
                push("compaction/end", { compactionId: "c2" }); // 病：缺 turn
            } else {
                push("compaction/start", { compactionId: "c2", turn: t });
                push("compaction/summary", { compactionId: "c2" });
                push("compaction/end", { compactionId: "c2", turn: t });
            }
        }
    }
    return `${header}\n${evs.join("\n")}\n`;
}

// 模拟旧版 0.3.x 修复脚本的产物：整档一把梭压成【单帧】，且无校验位
function buildLegacySingleFrame(text) {
    return zstdCompressSync(Buffer.from(text, "utf8")); // 默认参数，无 checksumFlag
}

// 运行 CLI 子进程
function runCli(args) {
    return execFileSync(process.execPath, [TOOL_PATH, ...args], { encoding: "utf8" });
}

// —— ① 帧指纹层 ——

test("TC-1 compressFrame 产物每帧带 zstd 内容校验位（FHD bit2=1，宿主同款指纹）", () => {
    const buf = compressFrame("hello\n");
    assert.equal(buf.subarray(0, 4).toString("hex"), "28b52ffd", "帧魔数应为 28 B5 2F FD");
    const fhd = buf[4];
    assert.notEqual(fhd & 0x04, 0, `帧描述符 0x${fhd.toString(16)} 应含校验位(bit2)；旧病产物是 0x80 无校验`);
});

test("TC-1b encodeConformant 整体输出的首帧同样带校验位", () => {
    const buf = encodeConformant(buildLogText({ brokenTurns: false }), []);
    const fhd = buf[4];
    assert.notEqual(fhd & 0x04, 0);
});

// —— ② 契约层（tripwire 核心） ——

test("TC-2 旧病产物（整档单帧、含缺 turn）必须被判罚——不许再发假绿灯", () => {
    const text = buildLogText({ brokenTurns: true });
    const frames = splitZstdFrames(buildLegacySingleFrame(text));
    assert.equal(frames.length, 1, "旧病产物应当只有一个帧");
    const verdict = validateContract(frames);
    assert.equal(verdict.ok, false, "宽容时代结束了：单帧整档必须红灯");
    assert.ok(
        verdict.violations.some((v) => v.includes("首帧")),
        `判罚应点名首帧契约，实际: ${JSON.stringify(verdict.violations)}`,
    );
});

test("TC-2b 新脚本产物按同一判罚器必须绿灯", () => {
    const text = buildLogText({ brokenTurns: true });
    const { lines, fixes } = fixLines(text);
    assert.equal(fixes.length, 2, "两条 compaction 事件需补 turn");
    for (const f of fixes) {
        const ev = JSON.parse(lines[f.i]);
        ev.data = { ...ev.data, turn: f.turn };
        lines[f.i] = JSON.stringify(ev);
    }
    const frames = splitZstdFrames(encodeConformant(lines.join("\n")));
    assert.ok(frames.length >= 2, "首帧头行 + 至少一个正文帧");
    const verdict = validateContract(frames);
    assert.deepEqual(verdict, { ok: true, violations: [] });
});

// —— ③ 行为层 ——

test("TC-3 CLI 全流程：dry-run 不落盘 → --apply 修语义并重排物理 → 复核通过", () => {
    const sickFile = join(dir, "sick.zstd");
    const dryFile = join(dir, "dry.zstd");
    const outDir = mkdtempSync(join(dir, "out-"));
    const outFile = join(outDir, "fixed.zstd");
    const text = buildLogText({ brokenTurns: true });
    writeFileSync(sickFile, buildLegacySingleFrame(text));

    // dry-run：正常退出且不产生输出文件
    const dry = runCli([sickFile, dryFile]);
    assert.match(dry, /\(dry-run/);
    assert.equal(existsSync(dryFile), false, "dry-run 不得写文件");

    // apply：修复 + 归一化
    const applied = runCli([sickFile, outFile, "--apply"]);
    assert.match(applied, /✅ 修复完成/);

    // 输出复核：逐行比对——非 compaction 行逐字节不变；compaction 行补上合法 turn
    const frames = splitZstdFrames(readFileSync(outFile));
    const outText = frames.join("");
    const outLines = outText.split("\n");
    const inLines = text.split("\n");
    assert.equal(outLines.length, inLines.length, "行数不得变化");
    for (let i = 0; i < inLines.length; i++) {
        if (inLines[i] === outLines[i]) continue;
        const ev = JSON.parse(outLines[i]);
        const t = ev.data?.turn;
        const legal = typeof t === "number" && Number.isSafeInteger(t) && t >= 0;
        assert.ok(
            (ev.type === "compaction/start" || ev.type === "compaction/end") && legal,
            `行 ${i + 1} 只允许是 compaction 行补 turn，实际 ${outLines[i]}`,
        );
    }
    assert.equal(validateContract(frames).ok, true);
});

test("TC-4 幂等：对合规档案再跑 --apply，内容一字不动", () => {
    const text = buildLogText({ brokenTurns: false });
    const in1 = join(dir, "a.zstd");
    const out2 = join(dir, "b.zstd");
    writeFileSync(in1, encodeConformant(text));
    const r1 = runCli([in1, out2, "--apply"]);
    assert.match(r1, /✅ 修复完成/);
    const frames2 = splitZstdFrames(readFileSync(out2));
    assert.equal(frames2.join(""), text, "合规档案重跑后事件文本必须一字不动");
    assert.equal(validateContract(frames2).ok, true);
});

test("TC-5 大档分帧：正文超过 128 KiB 时切成多个正文帧，头行永远独占首帧", () => {
    const header = JSON.stringify({ schemaVersion: 4, sessionId: "session-big", createdAt: "t", host: "x" });
    const lines = [header];
    for (let i = 0; i < 2400; i++) {
        lines.push(JSON.stringify({ seq: i, id: `e${i}`, time: "t", type: "user/message", data: { text: "x".repeat(80) } }));
    }
    const text = lines.join("\n") + "\n";
    assert.ok(text.length > 128 * 1024 + 4096, "测试文本应超过一帧容量");
    const frames = splitZstdFrames(encodeConformant(text));
    assert.equal(frames[0], header + "\n", "首帧必须恰好是头行");
    assert.ok(frames.length >= 3, `大档应切成多帧，实际 ${frames.length}`);
    for (const f of frames.slice(1)) {
        assert.ok(f.startsWith("{") && f.endsWith("\n"), "每个正文帧应以完整行构成");
    }
    assert.equal(frames.join(""), text);
});

test("TC-6 fixLines 语义：继承最近 open turn；找不到 open turn 要硬报错；坏行原样放行", () => {
    // 继承最近 open turn
    const t1 = [
        '{"seq":0,"type":"turn/start","data":{"turn":7}}',
        '{"seq":1,"type":"compaction/start","data":{"compactionId":"x"}}',
    ].join("\n") + "\n";
    assert.equal(fixLines(t1).fixes[0].turn, 7);

    // 没有 open turn 时不许瞎猜——直接抛错
    const t2 = '{"seq":1,"type":"compaction/start","data":{}}\n';
    assert.throws(() => fixLines(t2), /找不到 open turn/);

    // 坏 JSON 行原样保留（不参与修复，也不丢弃）
    const t3 = [
        "这不是JSON {{{",
        '{"seq":0,"type":"turn/start","data":{"turn":1}}',
        '{"seq":1,"type":"compaction/end","data":{"error":"boom"}}',
    ].join("\n") + "\n";
    const r3 = fixLines(t3);
    assert.equal(r3.fixes.length, 1, "带 error 的 end 也要补 turn");
});

test("TC-7 空档案判罚", () => {
    const v = validateContract([]);
    assert.equal(v.ok, false);
    assert.ok(v.violations[0].includes("空档案"));
});
