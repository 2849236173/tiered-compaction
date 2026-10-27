/**
 * D18 KV 缓存结构等价测试：摘要请求必须是正常对话请求的**严格前缀**。
 *
 * ## 为什么这样测
 *
 * 「KV 缓存命中率」是 provider 侧状态，本地不可观测——拿它当验收目标，
 * 只会得到「无法验证」四个字。可观测的等价判据是：
 *
 *   如果摘要请求发出的 messages，恰好是正常对话请求 messages 的**严格前缀**，
 *   那么这段前缀的 KV 在正常对话时已被建立，摘要调用必然命中。
 *   反之，只要顺序、条数、内容有一处不同，就必然一次都命中不了。
 *
 * 「相同即命中」不需要 provider 配合，纯本地可判定。
 *
 * ## 为什么要带「判别力」用例
 *
 * 只断言「新的能通过」是不够的：万一夹具造得刚好恒真，测试就等于没写。
 * 所以本文件同时断言**旧实现必须通不过**——旧实现把整个选区拍平成一条纯文本
 * user 消息，前缀对不上，一次都命中不了。
 * 一条测试能同时证明「新的对」和「旧的错」，才算真的有判别力。
 *
 * ## 两层结构
 *
 *   第一层（默认跑）：结构夹具。用真实事件形状造会话，断言前缀等价。
 *   第二层（按需跑）：真实会话。设置环境变量 `D18_REAL_SESSION` 指向
 *     `session.v4.jsonl.zstd` 即可。**真实会话里有用户对话内容，
 *     所以不写进仓库，只做按需开关。**
 *
 * 运行：
 *   node --test test/d18-kv-prefix.test.js
 *   $env:D18_REAL_SESSION="C:\Users\...\session.v4.jsonl.zstd"; node --test test/d18-kv-prefix.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

import { buildSummaryInput } from "../src/summary-input.js";

/* ────────────────────────── 公共工具 ────────────────────────── */

/**
 * 稳定序列化：键序固定，用于逐字段比对。
 *
 * 为什么不用 JSON.stringify：它受对象键插入顺序影响，两个语义相同的对象
 * 可能序列化出不同字符串，造成假失败。
 *
 * @param {unknown} value 任意值
 * @returns {string} 稳定字符串
 */
function stable(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
}

/**
 * 宿主的事件投影规则（照抄 dsh-session lib/index.js:217-230）。
 *
 * 摘要输入与正常对话请求共用这一条投影规则，是「结构等价」成立的前提——
 * 本测试要验的是**顺序与选择**是否正确，投影规则本身由宿主保证。
 *
 * @param {object} event 会话事件
 * @returns {object|null} 投影出的消息，或 null
 */
function deriveEventMessage(event) {
    switch (event.type) {
        case "user/message":
            return event.data;
        case "system/message":
        case "developer/message":
        case "assistant/message":
            // 空内容的消息被宿主播主为 null，不占位
            if (event.data.message.content.length === 0) return null;
            return event.data.message;
        case "tool/result":
            return event.data.message;
        default:
            return null;
    }
}

/**
 * 造一个贴近真实宿主的会话桩。
 *
 * 关键形状（写错就测不到真问题）：
 *   - surface.nodes 是 **seq 数字数组**，不是节点对象数组
 *   - eventAt(seq) 按 seq 取事件
 *   - deriveEventMessage 返回 message 或 null
 *
 * @param {object[]} events 事件列表（seq 必须连续从 0 开始）
 * @param {object} [opts] 可选项
 * @returns {object} 会话桩
 */
function makeSession(events, opts = {}) {
    const bySeq = new Map(events.map((e) => [e.seq, e]));
    // 表面只收会产生消息的事件类型，与宿主 SURFACE_EVENT_TYPES 一致
    const SURFACE_TYPES = new Set([
        "user/message", "system/message", "developer/message",
        "assistant/message", "tool/result",
    ]);
    const nodes = events.filter((e) => SURFACE_TYPES.has(e.type)).map((e) => e.seq);

    const session = {
        id: opts.id ?? "session-d18-kv",
        surface: { nodes },
        eventAt: (seq) => bySeq.get(seq),
        requestHeader: () => opts.header ?? { config: { provider: "p", model: "m" } },
        deriveEventMessage,
    };
    if (opts.toolHistory !== undefined) session.toolHistory = () => opts.toolHistory;
    return session;
}

/**
 * 正常对话请求会发出的 messages：表面全量投影，丢掉 null。
 *
 * 这是宿主的 `deriveMessages()` 语义——它就是正常对话请求的输入。
 *
 * @param {object} session 会话桩
 * @returns {object[]} 消息数组
 */
function normalRequestMessages(session) {
    return session.surface.nodes
        .map((seq) => deriveEventMessage(session.eventAt(seq)))
        .filter((m) => m !== null);
}

/**
 * 判断 needle 是否为 haystack 的严格前缀。
 *
 * @param {object[]} needle 待验证的短序列
 * @param {object[]} haystack 长序列
 * @returns {boolean} 是否严格前缀（长度更短且逐项相等）
 */
function isStrictPrefix(needle, haystack) {
    if (needle.length >= haystack.length) return false;
    for (let i = 0; i < needle.length; i += 1) {
        if (stable(needle[i]) !== stable(haystack[i])) return false;
    }
    return true;
}

/**
 * 旧实现（D17）：把整个选区拍平成一条纯文本 user 消息。
 *
 * 保留在这里的唯一用途是**证明本判据有判别力**——
 * 它不是生产代码，生产代码已经不这样做了。
 *
 * @param {object} session 会话桩
 * @param {number[]} shadowedSeqs 选区
 * @returns {object[]} 旧实现会发出的 messages
 */
function legacyFlatMessages(session, shadowedSeqs) {
    const parts = [];
    for (const seq of shadowedSeqs) {
        const message = deriveEventMessage(session.eventAt(seq));
        if (message === null) continue;

        if (typeof message.content === "string") {
            parts.push(message.content);
            continue;
        }

        const texts = [];
        for (const block of message.content) {
            if (typeof block?.text !== "string") continue;
            texts.push(block.text);
        }
        if (texts.length > 0) parts.push(texts.join("\n"));
    }

    if (parts.length === 0) return [];
    return [{ role: "user", content: [{ type: "text", text: parts.join("\n") }] }];
}

/**
 * 造一份有代表性的会话事件：system 头 + 多轮问答 + 工具结果。
 *
 * 刻意混入几种边界情况（空内容 assistant、非消息事件），
 * 让「条数」不再等于「事件数」，能抓出顺序类错误。
 *
 * @returns {object[]} 事件列表
 */
function makeRepresentativeEvents() {
    return [
        { seq: 0, type: "request/header", data: { config: { provider: "p", model: "m" } } },
        { seq: 1, type: "system/message", data: { message: { role: "system", content: [{ type: "text", text: "你是编程助手" }] } } },
        { seq: 2, type: "user/message", data: { role: "user", content: [{ type: "text", text: "帮我修一下登录 bug" }] } },
        { seq: 3, type: "turn/start", data: { turn: 1 } },
        { seq: 4, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "我先看看 auth.js" }] } } },
        { seq: 5, type: "tool/call", data: { name: "read" } },
        { seq: 6, type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text: "auth.js 内容…" }] } } },
        { seq: 7, type: "user/message", data: { role: "user", content: [{ type: "text", text: "顺便把测试补上" }] } },
        { seq: 8, type: "assistant/message", data: { message: { role: "assistant", content: [] } } },
        { seq: 9, type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: "测试已补" }] } } },
        { seq: 10, type: "turn/end", data: { turn: 1 } },
    ];
}

/* ────────────────── 第一层：结构夹具（默认跑） ────────────────── */

test("KV1 摘要请求必须是正常请求的严格前缀（含 system 头）", () => {
    const session = makeSession(makeRepresentativeEvents());

    // 按真实压缩规则选区：跳过表面首节点（system 头），并**保留尾部**。
    // 尾部必须留——真实压缩永远保留最近一段原文，不留尾部的选区在生产中不存在；
    // 而且只有留下尾部，摘要 messages 才真正「严格短于」正常请求，
    // 前缀关系才有意义（长度相等说明选区吃掉了整个表面，那是另一种情形，见 KV3/KV5）。
    const firstIdx = 1;
    const tailRetained = 2;
    const shadowedSeqs = session.surface.nodes.slice(firstIdx, -tailRetained);

    const summaryInput = buildSummaryInput(session, shadowedSeqs);
    const normal = normalRequestMessages(session);

    assert.ok(shadowedSeqs.length > 0, "选区不能为空，否则这条用例什么也没测");
    assert.ok(
        isStrictPrefix(summaryInput.messages, normal),
        `摘要 messages 必须是正常请求的严格前缀，否则 KV 缓存一次都命中不了。\n` +
        `摘要 ${summaryInput.messages.length} 条 / 正常 ${normal.length} 条`,
    );
});

test("KV2 摘要 messages 的首条必须是 system 头（与正常请求一致）", () => {
    const session = makeSession(makeRepresentativeEvents());
    const shadowedSeqs = session.surface.nodes.slice(1);

    const summaryInput = buildSummaryInput(session, shadowedSeqs);
    const normal = normalRequestMessages(session);

    assert.equal(summaryInput.messages[0]?.role, "system");
    assert.equal(
        stable(summaryInput.messages[0]),
        stable(normal[0]),
        "首条 system 必须与正常请求的首条逐字节相同",
    );
});

test("KV3 表面首节点不是 system 时，摘要 messages 仍是严格前缀", () => {
    const events = makeRepresentativeEvents().filter((e) => e.type !== "system/message");
    const session = makeSession(events);

    const summaryInput = buildSummaryInput(session, session.surface.nodes);
    const normal = normalRequestMessages(session);

    // 没有 system 头时，选区从表面首节点开始，输出应等于 normal 的前 N 条。
    // 这种情况下 buildSummaryInput 会吃掉全部节点，长度相等，
    // 所以断言「逐项前缀」而不是「严格前缀」
    const n = Math.min(summaryInput.messages.length, normal.length);
    for (let i = 0; i < n; i += 1) {
        assert.equal(
            stable(summaryInput.messages[i]),
            stable(normal[i]),
            `第 ${i} 条必须一致`,
        );
    }
    assert.equal(summaryInput.messages.length, normal.length, "无 system 头时应覆盖全部表面节点");
});

test("KV4 判别力：旧实现（拍平纯文本）必须通不过前缀检查", () => {
    const session = makeSession(makeRepresentativeEvents());
    const shadowedSeqs = session.surface.nodes.slice(1);
    const normal = normalRequestMessages(session);

    const legacy = legacyFlatMessages(session, shadowedSeqs);

    // 旧实现把 N 条消息压成 1 条纯文本，前缀必然对不上。
    // 这条用例的存在意义：证明 KV1 不是恒真——
    // 如果换个实现就通不过，说明这条判据真的有区分力。
    assert.equal(legacy.length, 1, "旧实现只会产出一条纯文本消息");
    assert.ok(
        !isStrictPrefix(legacy, normal),
        "旧实现绝不能通过前缀检查——它正是 KV 缓存一次都命中不了的原因",
    );
});

test("KV5 选区含 0 号节点时，前缀关系仍成立（system 不重复）", () => {
    const session = makeSession(makeRepresentativeEvents());

    // 边界：选区把 system 头也包进来
    const summaryInput = buildSummaryInput(session, session.surface.nodes);
    const normal = normalRequestMessages(session);

    const systemCount = summaryInput.messages.filter((m) => m.role === "system").length;
    assert.equal(systemCount, 1, "system 头只能出现一次，重复会让前缀错位");

    const n = Math.min(summaryInput.messages.length, normal.length);
    for (let i = 0; i < n; i += 1) {
        assert.equal(stable(summaryInput.messages[i]), stable(normal[i]), `第 ${i} 条必须一致`);
    }
});

test("KV6 工具定义（header.tools）随摘要请求一并带出", () => {
    const tools = [{ name: "read", description: "读文件" }, { name: "grep", description: "搜索" }];
    const session = makeSession(makeRepresentativeEvents(), {
        header: { config: { provider: "p", model: "m" }, tools },
    });

    const summaryInput = buildSummaryInput(session, session.surface.nodes.slice(1));

    assert.ok("tools" in summaryInput, "tools 必须带出，否则请求头与正常对话不同");
    assert.deepEqual(summaryInput.tools, tools, "tools 必须原样透传");
});

/* ──────────────── 第二层：真实会话（按需跑） ──────────────── */

const REAL_SESSION = process.env.D18_REAL_SESSION;
const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 逐帧解压真实会话文件。
 *
 * 会话文件是「一帧一条记录」的多帧 zstd 拼接，
 * 整包解只会得到第一条记录——这是实测踩过的坑。
 *
 * @param {string} path 会话文件路径
 * @returns {object[]} 事件列表
 */
function loadRealSession(path) {
    const buf = readFileSync(path);
    const starts = [];
    let i = 0;
    while (true) {
        const at = buf.indexOf(zstdMagic, i);
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
                } catch { /* 坏行跳过 */ }
            }
        } catch {
            // 末帧可能正在写，跳过即可
        }
    }
    events.sort((a, b) => a.seq - b.seq);
    return events;
}

test(
    "KV7 真实会话：摘要请求是正常请求的逐字节前缀",
    { skip: REAL_SESSION === undefined ? "未设置 D18_REAL_SESSION，跳过真实会话校验" : false },
    () => {
        const events = loadRealSession(REAL_SESSION);
        assert.ok(events.length > 100, `真实会话事件太少（${events.length}），检查路径是否正确`);

        const session = makeSession(events);

        // 按真实压缩规则选区：跳过 system 头，尾部保留约 16%
        const headIsSystem = session.eventAt(session.surface.nodes[0])?.type === "system/message";
        const firstIdx = headIsSystem ? 1 : 0;
        const retain = Math.max(1, Math.floor(session.surface.nodes.length * 0.16));
        const endIdx = session.surface.nodes.length - retain - 1;
        const shadowedSeqs = session.surface.nodes.slice(firstIdx, endIdx + 1);

        const summaryInput = buildSummaryInput(session, shadowedSeqs);
        const normal = normalRequestMessages(session);

        assert.ok(summaryInput.messages.length > 0, "摘要输入不能为空");
        assert.ok(
            isStrictPrefix(summaryInput.messages, normal),
            `真实会话上前缀必须完全等价：摘要 ${summaryInput.messages.length} 条 / 正常 ${normal.length} 条`,
        );

        // 逐字段再核一遍，条数对不代表字段对
        for (let i = 0; i < summaryInput.messages.length; i += 1) {
            assert.equal(
                stable(summaryInput.messages[i]),
                stable(normal[i]),
                `第 ${i} 条 role/content 必须完全一致`,
            );
        }

        // 顺便证明旧实现在真实会话上也通不过
        const legacy = legacyFlatMessages(session, shadowedSeqs);
        assert.ok(!isStrictPrefix(legacy, normal), "旧实现在真实会话上同样不能通过");
    },
);
