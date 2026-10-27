/**
 * B 组 + C 组验收测试：摘要请求组装与检查点包装。
 *
 * 覆盖清单：
 * - B1：options.messages 是数组，末项为压缩指令
 * - B2：输入含 tools → options.tools 等值透传
 * - B3：session 有 toolHistory → options.toolHistory 为其返回值
 * - B4：options.sessionId === session.id
 * - B5：options.maxTokens === 20000（写死 20k 预算）
 * - B6：options.purpose === "compaction"
 * - B7：session 无 toolHistory 时 "toolHistory" in options === false
 * - B8：finish.kind = "error" 时抛真实错误
 * - C1：SUMMARY_OPEN_TAG 与 SUMMARY_CLOSE_TAG 常量值与原版一致
 * - C2：提交后 user/message 的 content 长度 === 3，首段含 PREAMBLE 且含 OPEN_TAG，末段 === CLOSE_TAG
 * - C3：中间段 text 等于摘要正文
 * - C4：走真实事务路径（_runTransaction / compactRegion），断言提交事件 content 三段结构
 *
 * 运行：node --test test/d18-request.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

const quietLogger = {
    info() {},
    warn() {},
    error() {},
};

/**
 * 构造用于测试请求拦截的 Cordis Context。
 *
 * @param {Function} streamImpl llm.stream 桩实现
 * @returns {Context} 配置完成的 Context
 */
function makeCordisCtx(streamImpl) {
    const ctx = new Context();
    ctx.provide("llm", { stream: streamImpl });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: 0 }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = quietLogger;
    return ctx;
}

/**
 * 构造支持捕获 options 的 summarizeWith 辅助函数。
 *
 * @param {object} params 参数
 * @param {Function} [params.streamImpl] 伪造的流实现
 * @param {object} [params.input] 摘要输入
 * @param {object} [params.sessionExtra] 扩展 session 属性
 * @returns {Promise<{result: object, capturedOptions: object}>} 摘要结果与捕获的 options
 */
async function runSummarizeWithCapture({ streamImpl, input, sessionExtra = {} } = {}) {
    let capturedOptions = null;

    const defaultStream = async function* (options) {
        capturedOptions = options;
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "标准摘要文本" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "标准摘要文本" } };
        yield { type: "finish", reason: { kind: "stop" } };
    };

    let actualStream = defaultStream;
    if (streamImpl !== undefined) {
        actualStream = streamImpl;
    }

    const dir = await mkdtemp(join(tmpdir(), "d18-req-"));
    try {
        const ctx = makeCordisCtx(actualStream);
        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");

        const session = {
            id: "session-d18-xyz",
            requestHeader: () => ({ config: { provider: "test-p", model: "test-m" } }),
            ...sessionExtra,
        };

        const agent = {
            options: { provider: "test-p", model: "test-m" },
            session,
        };

        let summaryInput = input;
        if (summaryInput === undefined) {
            summaryInput = {
                messages: [
                    { role: "user", content: [{ type: "text", text: "待摘要的用户输入" }] },
                ],
            };
        }

        const result = await service.summarize(summaryInput, agent, undefined);
        return { result, capturedOptions };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("B1 options.messages 是数组，末项为压缩指令", async () => {
    let captured = null;
    await runSummarizeWithCapture({
        streamImpl: async function* (options) {
            captured = options;
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: "摘要完成" };
            yield { type: "block-end", index: 0, block: { type: "text", text: "摘要完成" } };
            yield { type: "finish", reason: { kind: "stop" } };
        },
        input: {
            messages: [
                { role: "user", content: [{ type: "text", text: "第一条消息" }] },
            ],
        },
    });

    // 卫语句：captured 必须被成功记录
    if (captured === null) {
        throw new Error("B1 失败：未能截获 llm.stream 的 options");
    }

    assert.ok(Array.isArray(captured.messages), "options.messages 必须是数组");
    assert.equal(captured.messages.length, 2, "options.messages 长度应为原始 1 条加末尾指令 1 条");

    const lastMessage = captured.messages[captured.messages.length - 1];
    assert.equal(lastMessage.role, "user", "压缩指令 role 必须为 user");
    assert.match(
        lastMessage.content[0].text,
        /You are now acting as a compaction engine/i,
        "末项内容必须包含 COMPACTION_INSTRUCTION",
    );
});

test("B2 输入含 tools → options.tools 等值透传", async () => {
    const customTools = [
        { name: "grep_search", description: "代码搜索工具" },
    ];

    const { capturedOptions } = await runSummarizeWithCapture({
        input: {
            messages: [{ role: "user", content: [{ type: "text", text: "测试工具透传" }] }],
            tools: customTools,
        },
    });

    if (capturedOptions === null) {
        throw new Error("B2 失败：options 未能被捕获");
    }

    assert.ok("tools" in capturedOptions, "options 必须包含 tools 字段");
    assert.deepEqual(capturedOptions.tools, customTools, "options.tools 必须与输入 tools 等值");
});

test("B2b 摘要路由的 provider / model 必须真的转交给 llm.stream", async () => {
    const { capturedOptions } = await runSummarizeWithCapture({
        input: {
            messages: [{ role: "user", content: [{ type: "text", text: "测试路由转交" }] }],
        },
    });

    if (capturedOptions === null) {
        throw new Error("B2b 失败：options 未能被捕获");
    }

    // 只断言 tools 透传是不够的：provider / model 若没转交到 llm.stream，
    // 请求会落到默认路由，摘要用错模型也不会报错——属于静默降级
    assert.equal(capturedOptions.provider, "test-p", "provider 必须原样转交");
    assert.equal(capturedOptions.model, "test-m", "model 必须原样转交");
});

test("B3 session 有 toolHistory → options.toolHistory 为其返回值", async () => {
    const mockToolHistory = [
        { tool: "bash", callCount: 3 },
    ];

    const { capturedOptions } = await runSummarizeWithCapture({
        sessionExtra: {
            toolHistory() {
                return mockToolHistory;
            },
        },
    });

    if (capturedOptions === null) {
        throw new Error("B3 失败：options 未能被捕获");
    }

    assert.ok("toolHistory" in capturedOptions, "options 必须包含 toolHistory 字段");
    assert.deepEqual(capturedOptions.toolHistory, mockToolHistory, "options.toolHistory 必须等于 session.toolHistory() 返回值");
});

test("B4 options.sessionId === session.id", async () => {
    const targetSessionId = "session-unique-alpha-42";
    const { capturedOptions } = await runSummarizeWithCapture({
        sessionExtra: {
            id: targetSessionId,
        },
    });

    if (capturedOptions === null) {
        throw new Error("B4 失败：options 未能被捕获");
    }

    assert.equal(capturedOptions.sessionId, targetSessionId, "options.sessionId 必须等于 session.id");
});

test("B5 options.maxTokens === 20000（写死 20k 预算）", async () => {
    const { capturedOptions } = await runSummarizeWithCapture();

    if (capturedOptions === null) {
        throw new Error("B5 失败：options 未能被捕获");
    }

    assert.equal(capturedOptions.maxTokens, 20000, "options.maxTokens 必须写死为 20000 (RESERVE_TOKENS)");
});

test("B6 options.purpose === 'compaction'", async () => {
    const { capturedOptions } = await runSummarizeWithCapture();

    if (capturedOptions === null) {
        throw new Error("B6 失败：options 未能被捕获");
    }

    assert.equal(capturedOptions.purpose, "compaction", "options.purpose 必须为 'compaction'");
});

test("B7 session 无 toolHistory 时 'toolHistory' in options === false", async () => {
    // 默认 sessionExtra 不定义 toolHistory
    const { capturedOptions } = await runSummarizeWithCapture();

    if (capturedOptions === null) {
        throw new Error("B7 失败：options 未能被捕获");
    }

    assert.equal("toolHistory" in capturedOptions, false, "session 无 toolHistory 时，options 中不得存在该键");
});

test("B8 finish.kind = 'error' 时抛真实错误", async () => {
    // 使用流注入制造真实 LLM 报错
    await assert.rejects(
        () => runSummarizeWithCapture({
            streamImpl: async function* () {
                yield { type: "block-start", index: 0, blockType: "text" };
                yield { type: "text-delta", index: 0, text: "" };
                yield {
                    type: "finish",
                    reason: {
                        kind: "error",
                        failure: { message: "503 service unavailable upstream", code: "SERVICE_UNAVAILABLE" },
                    },
                };
            },
        }),
        (error) => {
            assert.match(String(error.message), /service unavailable/i, "错误信息必须暴露真实的 LLM 错误原因");
            assert.doesNotMatch(String(error.message), /摘要结果为空/, "不得降级为摘要结果为空");
            return true;
        },
    );
});

test("C1 SUMMARY_OPEN_TAG 与 SUMMARY_CLOSE_TAG 常量值与原版一致", async () => {
    // 读取 contract.js 源码核验常量定义
    const contractPath = join(process.cwd(), "src", "contract.js");
    const sourceCode = await readFile(contractPath, "utf-8");

    // 校验 OPEN 标签定义
    const openTagMatch = sourceCode.match(/const\s+SUMMARY_OPEN_TAG\s*=\s*["']([^"']+)["']/);
    if (openTagMatch === null) {
        throw new Error("C1 失败：src/contract.js 中未找到 SUMMARY_OPEN_TAG 定义");
    }
    assert.equal(openTagMatch[1], "<compacted-summary>", "SUMMARY_OPEN_TAG 必须为 <compacted-summary>");

    // 校验 CLOSE 标签定义
    const closeTagMatch = sourceCode.match(/const\s+SUMMARY_CLOSE_TAG\s*=\s*["']([^"']+)["']/);
    if (closeTagMatch === null) {
        throw new Error("C1 失败：src/contract.js 中未找到 SUMMARY_CLOSE_TAG 定义");
    }
    assert.equal(closeTagMatch[1], "</compacted-summary>", "SUMMARY_CLOSE_TAG 必须为 </compacted-summary>");
});

test("C2/C3/C4 走真实事务路径，断言替换消息 content 具备三段结构与正文", async () => {
    const dir = await mkdtemp(join(tmpdir(), "d18-txn-"));
    try {
        const streamText = "这是本次事务压缩产出的核心摘要正文内容。";
        const ctx = makeCordisCtx(async function* () {
            yield { type: "block-start", index: 0, blockType: "text" };
            yield { type: "text-delta", index: 0, text: streamText };
            yield { type: "block-end", index: 0, block: { type: "text", text: streamText } };
            yield { type: "finish", reason: { kind: "stop" } };
        });

        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");

        // 构造一个会话桩支持真实 append 与替换操作
        const eventsLog = [];
        const surfaceNodes = [0, 1, 2];

        // 制造三条初始事件，确保原文估算足够大（远大于摘要）
        eventsLog.push({
            seq: 0,
            type: "user/message",
            data: { content: [{ type: "text", text: "用户提出的长篇任务需求描述：".repeat(20) }] },
        });
        eventsLog.push({
            seq: 1,
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "助手给出的详细长篇分析与解答方案：".repeat(20) }] } },
        });
        eventsLog.push({
            seq: 2,
            type: "user/message",
            data: { content: [{ type: "text", text: "用户后续的补充修正指令：".repeat(10) }] },
        });

        const stubSession = {
            surface: {
                nodes: surfaceNodes,
            },
            eventAt(seq) {
                return eventsLog.find((item) => item.seq === seq);
            },
            requestHeader() {
                return {
                    config: { provider: "test-provider", model: "test-model" },
                };
            },
            deriveEventMessage(event) {
                const role = event.type.split("/")[0];
                const rawContent = event.data?.content ?? event.data?.message?.content ?? [];
                let contentList = [];
                if (Array.isArray(rawContent)) {
                    contentList = rawContent;
                } else {
                    contentList = [{ type: "text", text: String(rawContent) }];
                }
                return { role, content: contentList };
            },
            append(type, data, options = {}) {
                const newSeq = eventsLog.length;
                const newEvent = { seq: newSeq, type, data, options };
                eventsLog.push(newEvent);

                // 响应 replace 替换操作
                if (options.surfaceOp !== undefined && options.surfaceOp.op === "replace") {
                    const startPos = surfaceNodes.indexOf(options.surfaceOp.startSeq);
                    const endPos = surfaceNodes.indexOf(options.surfaceOp.endSeq);
                    if (startPos !== -1 && endPos !== -1) {
                        surfaceNodes.splice(startPos, endPos - startPos + 1, newSeq);
                    }
                } else {
                    surfaceNodes.push(newSeq);
                }

                return newEvent;
            },
        };

        const agent = {
            options: { provider: "test-provider", model: "test-model" },
            session: stubSession,
        };

        // 走 compactRegion 真实事务路径，压缩选区 [0, 2]
        const txnResult = await service.compactRegion(0, 2, agent, undefined);

        // 卫语句校验事务产出
        if (txnResult === undefined || txnResult === null) {
            throw new Error("C4 失败：compactRegion 返回空");
        }

        // 寻找替换到表面的 user/message 检查点事件
        const replaceEvent = eventsLog.find(
            (event) => event.type === "user/message" && event.options?.surfaceOp?.op === "replace",
        );

        if (replaceEvent === undefined) {
            throw new Error("C4 失败：未找到带有 surfaceOp.op=replace 的 user/message 检查点事件");
        }

        const content = replaceEvent.data.content;
        assert.ok(Array.isArray(content), "检查点消息 content 必须是数组");

        // C2 断言：content 长度必须为 3，首段含 PREAMBLE 与 OPEN_TAG，末段为 CLOSE_TAG
        assert.equal(content.length, 3, "C2 必须产出 3 段结构");
        assert.equal(content[0].type, "text", "首段类型必须是 text");
        assert.match(content[0].text, /automatically generated checkpoint/i, "首段必须包含 CHECKPOINT_PREAMBLE");
        assert.ok(content[0].text.includes("<compacted-summary>"), "首段必须包含 <compacted-summary>");

        // C3 断言：中间段为正文且等于摘要内容
        assert.equal(content[1].type, "text", "中段类型必须是 text");
        assert.equal(content[1].text, streamText, "C3 中间段 text 必须完全等于模型产出的摘要正文");

        // C2 末段断言：末段完全等于 </compacted-summary>
        assert.equal(content[2].type, "text", "末段类型必须是 text");
        assert.equal(content[2].text, "</compacted-summary>", "末段 text 必须完全等于 </compacted-summary>");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
