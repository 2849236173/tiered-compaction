/**
 * A 组验收测试：摘要输入结构构造器（对齐 basic:695-704 与契约规范）。
 *
 * 覆盖清单：
 * - A2：用 session.deriveEventMessage 还原每条消息（结构与 role 保留）
 * - A3：system 头置于 messages 首位（真实 seq 数字形状）
 * - A4：表面首节点不是 system 时不插入空位
 * - A5：deriveEventMessage 返回 null 的事件被过滤
 * - A6：requestHeader 含 tools 时带出 tools，缺失时不出现该键
 * - A7：宿主无 deriveEventMessage 时降级并记录 warn 恰好一次
 * - A8：兜底文本模式包含所有事件内容
 * - A9：空选区与非数组入参返回空 messages 且不抛错
 *
 * 运行：node --test test/d18-structure.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSummaryInput, __test } from "../src/summary-input.js";

const quietLogger = {
    info() {},
    warn() {},
    error() {},
};

/**
 * 构造模拟真实宿主行为的会话桩。
 * 真实宿主表面 surface.nodes 为数字 seq 数组。
 *
 * @param {object} options 配置选项
 * @returns {object} 会话桩对象
 */
function makeStubSession(options = {}) {
    const rawEvents = options.events ?? [];
    const eventMap = new Map();
    for (const event of rawEvents) {
        eventMap.set(event.seq, event);
    }

    let surfaceNodes = [];
    if (options.surfaceNodes !== undefined) {
        surfaceNodes = [...options.surfaceNodes];
    } else {
        surfaceNodes = rawEvents.map((event) => event.seq);
    }

    const session = {
        surface: {
            nodes: surfaceNodes,
        },
        eventAt(seq) {
            return eventMap.get(seq);
        },
        requestHeader() {
            if (options.header !== undefined) {
                return options.header;
            }
            return { config: {} };
        },
        deriveEventMessage(event) {
            // 当用例显式指定 derive 返回值映射时优先使用
            if (options.deriveMap !== undefined && event.seq in options.deriveMap) {
                return options.deriveMap[event.seq];
            }

            // 模拟真实宿主过滤非消息事件
            if (event.type === "turn/start" || event.type === "turn/end") {
                return null;
            }

            const role = event.type.split("/")[0];
            const rawContent = event.data?.content ?? event.data?.message?.content ?? [];
            let contentList = [];
            if (Array.isArray(rawContent)) {
                contentList = rawContent;
            } else {
                contentList = [{ type: "text", text: String(rawContent) }];
            }

            return {
                role,
                content: contentList,
            };
        },
    };

    if (options.withoutDerive === true) {
        delete session.deriveEventMessage;
    }

    return session;
}

test("A2 用 session.deriveEventMessage 还原每条消息（结构与 role 保留）", () => {
    // 构造包含三种角色事件的真实序列
    const events = [
        {
            seq: 0,
            type: "user/message",
            data: { content: [{ type: "text", text: "用户输入指令" }] },
        },
        {
            seq: 1,
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "助手分析响应" }] } },
        },
        {
            seq: 2,
            type: "tool/result",
            data: { message: { content: [{ type: "text", text: "工具执行结果" }] } },
        },
    ];

    const session = makeStubSession({
        events,
        surfaceNodes: [0, 1, 2],
    });

    const result = buildSummaryInput(session, [0, 1, 2]);

    // 卫语句校验：输出对象必须存在且包含 messages
    if (result === undefined || !Array.isArray(result.messages)) {
        throw new Error("A2 失败：buildSummaryInput 未返回合法的 messages 数组");
    }

    // 断言 messages 长度与角色结构严格还原
    assert.equal(result.messages.length, 3, "messages 长度必须等于选区有效消息数 3");
    assert.equal(result.messages[0].role, "user", "第 0 条消息 role 必须为 user");
    assert.equal(result.messages[1].role, "assistant", "第 1 条消息 role 必须为 assistant");
    assert.equal(result.messages[2].role, "tool", "第 2 条消息 role 必须为 tool");

    // 断言每条消息的 content 均为数组
    for (const message of result.messages) {
        assert.ok(Array.isArray(message.content), "每条消息的 content 必须是数组");
    }
});

test("A3 system 头置于 messages 首位（真实 seq 数字形状）", () => {
    // 表面首节点为 system/message，且 surface.nodes 是真实 seq 数字数组
    const events = [
        {
            seq: 0,
            type: "system/message",
            data: { message: { content: [{ type: "text", text: "系统前言提示词" }] } },
        },
        {
            seq: 1,
            type: "user/message",
            data: { content: [{ type: "text", text: "用户任务输入" }] },
        },
        {
            seq: 2,
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "助手正在处理" }] } },
        },
    ];

    // surface.nodes 为纯数字 seq 数组 [0, 1, 2]，选区只选取 1 与 2
    const session = makeStubSession({
        events,
        surfaceNodes: [0, 1, 2],
    });

    const result = buildSummaryInput(session, [1, 2]);

    // 卫语句校验：输出结果必须非空
    if (result === undefined || !Array.isArray(result.messages)) {
        throw new Error("A3 失败：未返回合法的 messages 列表");
    }

    // 断言 system 头被自动提取并置于首位
    assert.equal(result.messages.length, 3, "messages 长度应包含 1 条 system 消息加 2 条选区消息");
    assert.equal(result.messages[0].role, "system", "首位消息 role 必须是 system");
    assert.equal(result.messages[0].content[0].text, "系统前言提示词", "首位 system 消息正文匹配");
    assert.equal(result.messages[1].role, "user", "选区第 1 条消息紧跟在 system 之后");
    assert.equal(result.messages[2].role, "assistant", "选区第 2 条消息排在最后");
});

test("A4 表面首节点不是 system 时不插入空位", () => {
    // 表面首节点为 user/message，不是 system/message
    const events = [
        {
            seq: 0,
            type: "user/message",
            data: { content: [{ type: "text", text: "首条用户消息" }] },
        },
        {
            seq: 1,
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "首条助手响应" }] } },
        },
    ];

    const session = makeStubSession({
        events,
        surfaceNodes: [0, 1],
    });

    const result = buildSummaryInput(session, [0, 1]);

    // 卫语句校验
    if (result === undefined || !Array.isArray(result.messages)) {
        throw new Error("A4 失败：未返回合法的 messages 列表");
    }

    // 断言 messages 长度严格等于选区长度，没有占位空值
    assert.equal(result.messages.length, 2, "无 system 头时消息长度必须严格等于选区长度 2");
    assert.equal(result.messages[0].role, "user", "首条消息应直接为 user");
    assert.notEqual(result.messages[0], null, "首项不得为 null");
    assert.notEqual(result.messages[0], undefined, "首项不得为 undefined");
});

test("A5 deriveEventMessage 返回 null 的事件被过滤", () => {
    // 中间插入一条非消息事件 turn/start，derive 返回 null
    const events = [
        {
            seq: 0,
            type: "user/message",
            data: { content: [{ type: "text", text: "轮次开始前用户提问" }] },
        },
        {
            seq: 1,
            type: "turn/start",
            data: { turn: 1 },
        },
        {
            seq: 2,
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "助手回答" }] } },
        },
    ];

    const session = makeStubSession({
        events,
        surfaceNodes: [0, 1, 2],
        deriveMap: {
            0: { role: "user", content: [{ type: "text", text: "轮次开始前用户提问" }] },
            1: null,
            2: { role: "assistant", content: [{ type: "text", text: "助手回答" }] },
        },
    });

    const result = buildSummaryInput(session, [0, 1, 2]);

    // 卫语句校验
    if (result === undefined || !Array.isArray(result.messages)) {
        throw new Error("A5 失败：未返回合法的 messages 列表");
    }

    // 断言返回 null 的事件被安全跳过，messages 中不出现 null
    assert.equal(result.messages.length, 2, "返回 null 的 turn/start 必须被过滤掉");
    assert.equal(result.messages[0].role, "user", "第 0 条消息为 user");
    assert.equal(result.messages[1].role, "assistant", "第 1 条消息为 assistant");
});

test("A6 requestHeader 含 tools 时带出 tools，缺失时不出现该键", () => {
    const events = [
        {
            seq: 0,
            type: "user/message",
            data: { content: [{ type: "text", text: "测试工具带出" }] },
        },
    ];

    // 情况一：header 提供合法 tools 定义
    const toolsData = [{ name: "read_file", description: "读取指定文件内容" }];
    const sessionWithTools = makeStubSession({
        events,
        surfaceNodes: [0],
        header: {
            config: {},
            tools: toolsData,
        },
    });

    const resultWithTools = buildSummaryInput(sessionWithTools, [0]);

    // 卫语句断言 tools 属性存在且等值
    if (!("tools" in resultWithTools)) {
        throw new Error("A6 失败：header 提供 tools 时，返回值必须包含 tools 字段");
    }
    assert.deepEqual(resultWithTools.tools, toolsData, "tools 属性必须与 header 中的 tools 内容完全等值");

    // 情况二：header 无 tools 属性
    const sessionWithoutTools = makeStubSession({
        events,
        surfaceNodes: [0],
        header: {
            config: {},
        },
    });

    const resultWithoutTools = buildSummaryInput(sessionWithoutTools, [0]);

    // 必须用 in 操作符判断键完全不存在，而不是值为 undefined
    assert.equal("tools" in resultWithoutTools, false, "header 无 tools 时，返回值对象中不得存在 tools 键");
});

test("A7 宿主无 deriveEventMessage 时降级并记录 warn 恰好一次", () => {
    // 重置模块内 warn 状态，确保单测隔离
    __test.resetWarnedState();

    const warnRecords = [];
    const stubLogger = {
        warn(message) {
            warnRecords.push(message);
        },
    };

    const events = [
        {
            seq: 0,
            type: "user/message",
            data: { content: "旧宿主纯文本消息" },
        },
    ];

    // 模拟无 deriveEventMessage 的旧宿主
    const session = makeStubSession({
        events,
        surfaceNodes: [0],
        withoutDerive: true,
    });

    // 首次调用：必须降级成功且触发一次 warn
    const firstResult = buildSummaryInput(session, [0], stubLogger);

    if (firstResult === undefined || !Array.isArray(firstResult.messages) || firstResult.messages.length === 0) {
        throw new Error("A7 失败：旧宿主降级后未产生非空 messages");
    }

    assert.equal(warnRecords.length, 1, "宿主缺少 deriveEventMessage 时必须恰好发出 1 次 warn");
    assert.match(warnRecords[0], /deriveEventMessage/, "警告信息必须指明缺少 deriveEventMessage");

    // 第二次调用：去重后不应再次触发 warn
    const secondResult = buildSummaryInput(session, [0], stubLogger);

    if (secondResult === undefined || !Array.isArray(secondResult.messages)) {
        throw new Error("A7 失败：第二次调用降级返回异常");
    }

    assert.equal(warnRecords.length, 1, "多次降级调用期间 warn 必须去重，仍然保持恰好 1 次");
});

test("A8 兜底文本模式包含所有事件内容", () => {
    __test.resetWarnedState();

    const events = [
        {
            seq: 0,
            type: "user/message",
            data: { content: "用户核心问题-ALPHA-999" },
        },
        {
            seq: 1,
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "模型核心解答-BETA-888" }] } },
        },
        {
            seq: 2,
            type: "tool/result",
            data: { message: { content: [{ type: "text", text: "工具输出摘要-GAMMA-777" }] } },
        },
    ];

    const session = makeStubSession({
        events,
        surfaceNodes: [0, 1, 2],
        withoutDerive: true,
    });

    const result = buildSummaryInput(session, [0, 1, 2], quietLogger);

    // 卫语句校验降级格式
    if (result === undefined || !Array.isArray(result.messages) || result.messages.length === 0) {
        throw new Error("A8 失败：降级模式未产出消息");
    }

    const aggregatedText = result.messages[0].content[0].text;
    if (typeof aggregatedText !== "string") {
        throw new Error("A8 失败：降级拼接文本不是字符串");
    }

    // 断言三条事件的正文字符串均被保留
    assert.ok(aggregatedText.includes("用户核心问题-ALPHA-999"), "文本兜底必须保留第 1 条事件的内容");
    assert.ok(aggregatedText.includes("模型核心解答-BETA-888"), "文本兜底必须保留第 2 条事件的内容");
    assert.ok(aggregatedText.includes("工具输出摘要-GAMMA-777"), "文本兜底必须保留第 3 条事件的内容");
});

test("A9 空选区与非数组入参返回空 messages 且不抛错", () => {
    const session = makeStubSession({
        events: [{ seq: 0, type: "user/message", data: { content: "无关消息" } }],
        surfaceNodes: [0],
    });

    // 选区为空数组时
    const emptyArrayResult = buildSummaryInput(session, []);
    assert.deepEqual(emptyArrayResult, { messages: [] }, "空选区数组必须返回 { messages: [] }");

    // 选区为非数组字符串时
    const stringParamResult = buildSummaryInput(session, "不是数组");
    assert.deepEqual(stringParamResult, { messages: [] }, "非数组字符串入参必须返回 { messages: [] }");

    // 选区为数字时
    const numberParamResult = buildSummaryInput(session, 12345);
    assert.deepEqual(numberParamResult, { messages: [] }, "非数组数字入参必须返回 { messages: [] }");

    // 选区为 null / undefined 时
    assert.deepEqual(buildSummaryInput(session, null), { messages: [] }, "null 选区必须返回 { messages: [] }");
    assert.deepEqual(buildSummaryInput(session, undefined), { messages: [] }, "undefined 选区必须返回 { messages: [] }");

    // 会话对象为 null / undefined 时
    assert.deepEqual(buildSummaryInput(null, [0]), { messages: [] }, "null session 必须返回 { messages: [] }");
    assert.deepEqual(buildSummaryInput(undefined, [0]), { messages: [] }, "undefined session 必须返回 { messages: [] }");
});
