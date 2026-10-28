/**
 * 摘要输入必须能读到所有消息形态（P0 审计发现）。
 *
 * 缺陷（2026-10-27 系统审计）：
 *   真实宿主里消息内容的存放位置**不统一**：
 *     user/message      → data.content            （直接挂在 data 上）
 *     assistant/message → data.message.content    （包在 message 里）
 *     tool/result       → data.message.content    （包在 message 里）
 *
 *   旧实现只读 `data.content`，于是 assistant 与 tool 的消息**全部读成空**。
 *
 *   实测量化（真实会话，277328 字内容）：
 *     · 旧逻辑只抽出 45838 字 —— 丢 83.5%
 *     · tool/result 的 224556 字**一个字都没进摘要**
 *
 *   后果：摘要只看得到用户说了什么，看不到助手做了什么、工具返回了什么。
 *   而工具结果恰恰是压缩的主要对象。产出的是「知道要做什么、不知道做到哪」
 *   的半截检查点，续做的模型会重复已完成的工作——比不压缩更糟。
 *
 * 本文件用**真实事件结构**做夹具（照抄会话日志里的字段形状），
 * 不用理想化的简化结构——因为正是「桩比现实好用」放走了这个 bug。
 *
 * 运行：node --test test/d17-summary-input.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { __test } from "../src/contract.js";

const { textOfEventForSummary } = __test;

/** 真实 user/message 形状：内容直接挂 data.content。 */
function userMessage(text) {
    return {
        type: "user/message",
        data: {
            content: [{ type: "text", text }],
            source: { kind: "user" },
            role: "user",
            id: "m1",
        },
    };
}

/** 真实 assistant/message 形状：内容在 data.message.content 里。 */
function assistantMessage(blocks) {
    return {
        type: "assistant/message",
        data: {
            turn: 1,
            step: 1,
            message: { role: "assistant", content: blocks },
            usage: { totalTokens: 100 },
        },
    };
}

/** 真实 tool/result 形状：内容在 data.message.content 里，另有 meta。 */
function toolResult(text) {
    return {
        type: "tool/result",
        data: {
            turn: 1,
            step: 1,
            message: {
                role: "tool",
                source: { kind: "tool", callId: "c1" },
                toolCallId: "c1",
                content: [{ type: "text", text }],
                isError: false,
                id: "m2",
            },
            meta: { path: "a.js", offset: 1, lines: [], totalLines: 10, lang: "js" },
        },
    };
}

test("user/message 的内容必须能读到（data.content 形态）", () => {
    assert.equal(textOfEventForSummary(userMessage("用户说的话")), "用户说的话");
});

test("tool/result 的内容必须能读到（data.message.content 形态）——旧实现读成空", () => {
    const text = textOfEventForSummary(toolResult("工具返回的一大段内容"));
    assert.equal(
        text,
        "工具返回的一大段内容",
        "tool/result 是压缩的主要对象，读不到等于摘要丢掉了大头",
    );
});

test("assistant/message 的 text 块必须能读到（data.message.content 形态）", () => {
    const text = textOfEventForSummary(assistantMessage([
        { type: "text", text: "我的回答" },
    ]));
    assert.equal(text, "我的回答");
});

test("assistant 的 tool-call 必须保留（工具名+参数），这是「做过什么」的唯一线索", () => {
    const text = textOfEventForSummary(assistantMessage([
        { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"a.js"}' },
    ]));
    assert.match(text, /调用工具 read/, "工具名必须保留");
    assert.match(text, /a\.js/, "参数必须保留（否则不知道读的是哪个文件）");
});

test("assistant 的 reasoning 必须丢弃（对续做无用且极占篇幅）", () => {
    const text = textOfEventForSummary(assistantMessage([
        { type: "reasoning", text: "让我想想……这里应该先读文件" },
        { type: "text", text: "好的" },
    ]));
    assert.equal(text, "好的", "推理过程不该进摘要输入");
    assert.doesNotMatch(text, /让我想想/);
});

test("同一事件里 text 与 tool-call 混合时都要保留，且保持原顺序", () => {
    const text = textOfEventForSummary(assistantMessage([
        { type: "text", text: "我先看一下文件" },
        { type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"b.js"}' },
    ]));
    assert.match(text, /我先看一下文件/);
    assert.match(text, /调用工具 read/);
    assert.ok(
        text.indexOf("我先看一下文件") < text.indexOf("调用工具 read"),
        "顺序必须与原消息一致（先说话再调工具）",
    );
});

test("空内容、缺字段、非文本块都不得抛错，返回空串", () => {
    assert.equal(textOfEventForSummary(undefined), "");
    assert.equal(textOfEventForSummary({}), "");
    assert.equal(textOfEventForSummary({ data: {} }), "");
    assert.equal(textOfEventForSummary({ data: { content: [] } }), "");
    assert.equal(textOfEventForSummary({ data: { content: [{ type: "image" }] } }), "");
    assert.equal(textOfEventForSummary({ data: { message: { content: null } } }), "");
});
