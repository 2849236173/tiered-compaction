/**
 * D18 端到端链路验证脚本。
 *
 * 用途：每次改完压缩插件，跑一次就能确认「真实链路没断」——
 * 不用重启宿主，不用等自然触发，不用打真实 LLM。
 *
 * 它走的是真实路径：真实会话（zstd 解压）→ 宿主真实 foldSurface →
 * 真实 Cordis 装配 → 真实 compactRegion → 真实 summarize → llm.stream（在此拦截）。
 * 只有 LLM 输出是桩，其余全部是真的。
 *
 * 验证四件事：
 *   1. 摘要请求真的发出了，且 messages 是结构化的（不是拍平纯文本）
 *   2. tools / toolHistory / sessionId 三个 KV 缓存关键字段都在
 *   3. 摘要请求是正常对话请求的**严格前缀**（命中缓存的结构条件）
 *   4. 压缩事务四段落地（start / summary / user-message / end），检查点带 OPEN/CLOSE 标签
 *
 * 用法：
 *   node scripts/verify-e2e.mjs <会话文件路径>
 *
 * 会话文件就是 DSH 的 session.v4.jsonl.zstd，位置随平台不同：
 *   Windows  %USERPROFILE%\.dsh\sessions\<工作区目录>\<会话ID>\session.v4.jsonl.zstd
 *   macOS    ~/.dsh/sessions/<工作区目录>/<会话ID>/session.v4.jsonl.zstd
 *   Linux    ~/.dsh/sessions/<工作区目录>/<会话ID>/session.v4.jsonl.zstd
 * 也可以设环境变量 DSH_SESSION_FILE 指定，避免每次带长参数。
 *
 * 为什么必须传真实会话：这个脚本验证的是「摘要请求是正常对话请求的严格前缀」，
 * 只有真实会话的 surface 才能证明结构等价；自造夹具盖不到真实形状的边界。
 *
 * 退出码：0 = 全部通过；1 = 有失败项；2 = 未提供会话文件。
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { foldSurface, deriveEventMessage } from "@deepseek-ai/dsh-session";
import { apply } from "../src/index.js";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 结果收集器：最后统一判退出码 */
const failures = [];
function check(name, ok, detail) {
    const mark = ok ? "✔" : "✖";
    console.log(`  ${mark} ${name}${detail === undefined ? "" : `（${detail}）`}`);
    if (!ok) failures.push(name);
}

/**
 * 逐帧解压真实会话。
 *
 * 会话文件是「一帧一条记录」的多帧 zstd 拼接，整包解只会得到第一条记录——
 * 实测踩过的坑，所以必须按魔数切帧逐帧解。
 *
 * @param {string} path 会话文件路径
 * @returns {object[]} 事件列表（按 seq 升序）
 */
function loadEvents(path) {
    const buf = readFileSync(path);

    const starts = [];
    let i = 0;
    while (true) {
        const at = buf.indexOf(MAGIC, i);
        if (at < 0) break;
        starts.push(at);
        i = at + 4;
    }

    const events = [];
    for (let n = 0; n < starts.length; n += 1) {
        const from = starts[n];
        const to = n + 1 < starts.length ? starts[n + 1] : buf.length;
        try {
            const text = zstdDecompressSync(buf.subarray(from, to)).toString("utf8");
            for (const line of text.split("\n")) {
                if (line.trim().length === 0) continue;
                try {
                    const rec = JSON.parse(line);
                    if (typeof rec.seq === "number") events.push(rec);
                } catch {
                    // 坏行跳过：单条坏数据不能让整个验证失败
                }
            }
        } catch {
            // 末帧可能正在写（会话还开着），跳过即可
        }
    }

    events.sort((a, b) => a.seq - b.seq);
    return events;
}

/**
 * 稳定序列化：键序固定。
 *
 * 为什么不用 JSON.stringify：它受键插入顺序影响，两个语义相同的对象
 * 可能序列化出不同字符串，造成假失败。
 */
function stable(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}

/* ────────────── 1. 加载真实会话 ────────────── */

// 会话路径来自命令行参数或 DSH_SESSION_FILE 环境变量。
// 不给默认值：写死任何人的本机路径都会让脚本在别人机器上直接失败。
const sessionArg = process.argv[2] ?? process.env.DSH_SESSION_FILE;
if (sessionArg === undefined || sessionArg.length === 0) {
    console.error("用法：node scripts/verify-e2e.mjs <session.v4.jsonl.zstd 路径>");
    console.error("或设置环境变量 DSH_SESSION_FILE 指向该文件。");
    console.error("会话文件位于 ~/.dsh/sessions/<工作区目录>/<会话ID>/session.v4.jsonl.zstd");
    process.exit(2);
}

const sessionPath = resolve(sessionArg);
const events = loadEvents(sessionPath);

console.log(`═══ 真实会话 ═══`);
console.log(`  文件：${sessionPath}`);
console.log(`  事件：${events.length} 条`);
check("会话事件足够多", events.length > 100, `${events.length} 条`);

const bySeq = new Map(events.map((e) => [e.seq, e]));

// 表面用宿主权威规则重建：手搓表面会被 toolPairingBalanced 校验正确拦下
// （实测踩过：tool/result 没配对 tool-call 时宿主直接拒绝，这是宿主在保护，不是缺陷）
const folded = foldSurface(events);
const baseSurface = [...folded.nodes];
console.log(`  宿主 foldSurface 表面：${baseSurface.length} 个节点`);
check("表面节点足够多", baseSurface.length > 10, `${baseSurface.length} 个`);

const headerEvent = [...events].reverse().find((e) => e.type === "request/header");
const header = headerEvent?.data?.header ?? headerEvent?.data;

/* ────────────── 2. 造可操作的会话桩 ────────────── */

// append 真写事件表、surfaceOp 真改表面——桩必须比真实宿主更安静是不行的，
// 那会放过只在真实派发下才暴露的 bug（D17 的 OOM 就是这样放走的）
const log = new Map(bySeq);
let nextSeq = events.at(-1).seq + 1;
const surface = [...baseSurface];
const appended = [];

const SURFACE_TYPES = new Set([
    "user/message", "system/message", "developer/message",
    "assistant/message", "tool/result",
]);

const session = {
    id: "session-e2e-verify",
    get seq() { return nextSeq; },
    surface: {
        get nodes() { return [...surface]; },
    },
    eventAt: (seq) => log.get(seq),
    requestHeader: () => header,
    deriveEventMessage,
    toolHistory: () => [{ name: "read", callCount: 12 }],
    append: (type, data, opts) => {
        const event = { seq: nextSeq, type, time: Date.now(), data };
        log.set(nextSeq, event);
        appended.push({ type, seq: nextSeq, opts });
        nextSeq += 1;

        // 模拟宿主表面操作：replace 把区间换成一个新节点，append 把新事件入表面
        if (opts?.surfaceOp?.op === "replace") {
            const a = surface.indexOf(opts.surfaceOp.startSeq);
            const b = surface.indexOf(opts.surfaceOp.endSeq);
            if (a >= 0 && b >= a) surface.splice(a, b - a + 1, event.seq);
            return event;
        }
        if (SURFACE_TYPES.has(type)) surface.push(event.seq);
        return event;
    },
};

/* ────────────── 3. 真实插件装配（只桩 LLM 输出） ────────────── */

let captured = null;
const SUMMARY_TEXT = "端到端验证：模型产出的摘要正文";

const ctx = new Context();
ctx.provide("llm", {
    stream: async function* (options) {
        captured = options;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: SUMMARY_TEXT };
        yield { type: "block-end", index: 0, block: { type: "text", text: SUMMARY_TEXT } };
        yield { type: "finish", reason: { kind: "stop" } };
    },
});
ctx.provide("tokenMeter", {
    measure: () => ({ totalTokens: 0, nodes: [] }),
    estimateMessage: () => 0,
});
ctx.provide("sessions", { flush: async () => {} });
ctx.logger = { info() {}, warn() {}, error() {}, debug() {} };

const dir = await mkdtemp(join(tmpdir(), "dsh-e2e-"));
await apply(ctx, {
    enabled: true,
    archiveDir: dir,
    auto: false,
    summaryTarget: { provider: "e2e-test", model: "e2e-model" },
});

const service = ctx.get("compaction");
check("插件已装配（compactRegion 可用）", typeof service.compactRegion === "function");

/* ────────────── 4. 触发真实压缩事务 ────────────── */

// 选区按真实压缩规则：跳过 system 头，尾部保留约 16%
const headIsSystem = bySeq.get(baseSurface[0])?.type === "system/message";
const firstIdx = headIsSystem ? 1 : 0;
const retain = Math.max(1, Math.floor(baseSurface.length * 0.16));
const endIdx = baseSurface.length - retain - 1;
const startSeq = baseSurface[firstIdx];
const endSeq = baseSurface[endIdx];

console.log(`\n═══ 压缩事务 ═══`);
console.log(`  区间：表面位置 ${firstIdx} → ${endIdx}（seq ${startSeq} → ${endSeq}）`);

const agent = {
    options: { provider: "e2e-test", model: "e2e-model" },
    session,
};

let result = null;
let failure = null;
try {
    result = await service.compactRegion(startSeq, endSeq, agent, undefined);
} catch (error) {
    failure = error;
}

if (failure !== null) {
    check("压缩事务不抛错", false, failure.cause?.message ?? failure.message);
} else {
    check("压缩事务不抛错", true, `shadowed ${result.shadowedSeqs.length} 个节点`);
}

/* ────────────── 5. 摘要请求检查 ────────────── */

console.log(`\n═══ 摘要请求 ═══`);
check("llm.stream 被调用（请求真发出了）", captured !== null);

if (captured !== null) {
    console.log(`  provider/model：${captured.provider} / ${captured.model}`);
    console.log(`  messages：${captured.messages.length} 条　maxTokens：${captured.maxTokens}　purpose：${captured.purpose}`);

    check("messages 是数组且非空", Array.isArray(captured.messages) && captured.messages.length > 0, `${captured.messages?.length} 条`);
    check("maxTokens 写死 20k", captured.maxTokens === 20000, String(captured.maxTokens));
    check("purpose = compaction", captured.purpose === "compaction");
    check("tools 随请求带出", "tools" in captured);
    check("toolHistory 随请求带出", "toolHistory" in captured);
    check("sessionId 随请求带出", "sessionId" in captured);

    const tail = captured.messages.at(-1);
    const tailText = tail?.content?.[0]?.text ?? "";
    check("末项是压缩指令", tailText.startsWith("You are now acting as a compaction engine"));

    // KV 缓存判据：去掉末尾指令后，必须等于 foldSurface 全量投影的严格前缀
    const normal = baseSurface.map((seq) => deriveEventMessage(bySeq.get(seq))).filter((m) => m !== null);
    const prefix = captured.messages.slice(0, -1);

    let prefixOk = prefix.length < normal.length;
    let firstDiff = -1;
    for (let i = 0; i < prefix.length && prefixOk; i += 1) {
        if (stable(prefix[i]) !== stable(normal[i])) {
            prefixOk = false;
            firstDiff = i;
        }
    }

    console.log(`\n═══ KV 缓存结构等价 ═══`);
    console.log(`  摘要前缀 ${prefix.length} 条 / 正常请求 ${normal.length} 条`);
    check("是正常请求的严格前缀", prefixOk, firstDiff >= 0 ? `首处差异 #${firstDiff}` : "");

    const roles = {};
    for (const m of prefix) roles[m.role ?? "?"] = (roles[m.role ?? "?"] ?? 0) + 1;
    console.log(`  角色分布：${JSON.stringify(roles)}`);
}

/* ────────────── 6. 事务落地检查 ────────────── */

console.log(`\n═══ 事务落地 ═══`);
for (const e of appended) console.log(`  ${e.type}（seq ${e.seq}）`);

const types = new Set(appended.map((e) => e.type));
check("compaction/start 已写", types.has("compaction/start"));
check("compaction/summary 已写", types.has("compaction/summary"));
check("compaction/end 已写（锁正确释放）", types.has("compaction/end"));

const checkpoint = appended.find((e) => e.type === "user/message");
check("检查点 user/message 已写", checkpoint !== undefined);

if (checkpoint !== undefined) {
    const msg = log.get(checkpoint.seq);
    const content = msg?.data?.content;
    check("检查点三段结构", content?.length === 3, `${content?.length} 段`);
    check("首段含 OPEN_TAG", content?.[0]?.text?.includes("<compacted-summary>"));
    check("末段是 CLOSE_TAG", content?.at(-1)?.text === "</compacted-summary>");
}

/* ────────────── 7. 收尾 ────────────── */

await rm(dir, { recursive: true, force: true });

console.log(`\n═══ 结论 ═══`);
if (failures.length === 0) {
    console.log(`  ✅ 全部通过：真实链路完好，摘要请求为正常请求前缀 + 压缩指令，KV 缓存可命中`);
    process.exit(0);
} else {
    console.log(`  ❌ ${failures.length} 项失败：`);
    for (const f of failures) console.log(`    - ${f}`);
    process.exit(1);
}
