/**
 * 旧宿主降级验收测试（A7/A8/D1）。
 *
 * 覆盖清单：
 * - D1：旧宿主（无 deriveEventMessage）走 compactRegion 与 compactIfNeeded 全程不抛错，且能产出有效摘要
 * - A7/A8：断言降级文本兜底包含所有事件内容，且 warn 恰好只报一次（多次调用也只报一次）
 *
 * 运行：node --test test/d18-fallback.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";
import { __test } from "../src/summary-input.js";

/**
 * 构造支持记录日志与提供正确测量的 Context。
 *
 * @param {object} params 参数
 * @param {Function} params.streamImpl llm.stream 实现
 * @param {string[]} params.warnCollector 收集 warn 日志的数组
 * @param {number} [params.totalTokens] 总 token 数
 * @returns {Context} Cordis 上下文
 */
function makeFallbackCtx({ streamImpl, warnCollector, totalTokens = 50000 }) {
    const ctx = new Context();
    ctx.provide("llm", { stream: streamImpl });

    let currentMeasurementTokens = totalTokens;

    ctx.provide("tokenMeter", {
        measure(session) {
            const surfaceNodes = session?.surface?.nodes ?? [];
            const nodes = surfaceNodes.map((seq) => ({ seq, tokens: 500 }));
            return {
                totalTokens: currentMeasurementTokens,
                nodes,
            };
        },
        estimateMessage() {
            return 100;
        },
        currentTokens() {
            return currentMeasurementTokens;
        },
    });

    // 允许在测试中动态更新读数
    ctx.setMeasurementTokens = (val) => {
        currentMeasurementTokens = val;
    };
    ctx.provide("sessions", {
        async flush() {},
    });

    ctx.logger = {
        info() {},
        warn(msg) {
            if (Array.isArray(warnCollector)) {
                warnCollector.push(String(msg));
            }
        },
        error() {},
    };

    return ctx;
}

/**
 * 构造完全不包含 deriveEventMessage 的旧宿主会话桩。
 * 严格按照真实宿主行为维护 seq、surface.nodes 与路由接口。
 *
 * @param {object} [options] 配置选项
 * @returns {object} 会话桩对象封装
 */
function makeLegacySession(options = {}) {
    const eventsLog = [];
    const surfaceNodes = [];
    let windowTokens = 100000;
    if (options.window !== undefined) {
        windowTokens = options.window;
    }

    let replaceGeneration = 0;

    const session = {
        id: "legacy-session-001",
        get seq() {
            return eventsLog.length;
        },
        surface: {
            nodes: surfaceNodes,
            get replaceGeneration() {
                return replaceGeneration;
            },
        },
        eventAt(seq) {
            return eventsLog.find((event) => event.seq === seq);
        },
        requestHeader() {
            return {
                config: { provider: "legacy-provider", model: "legacy-model" },
            };
        },
        requestContext() {
            return {
                provider: "legacy-provider",
                model: "legacy-model",
                contextWindow: windowTokens,
            };
        },
        append(type, data, opts = {}) {
            const newSeq = eventsLog.length;
            const event = { seq: newSeq, type, data, options: opts };
            eventsLog.push(event);

            // 处理表面节点的替换与追加，非消息类事件不进表面
            if (opts.surfaceOp !== undefined && opts.surfaceOp.op === "replace") {
                const startIdx = surfaceNodes.indexOf(opts.surfaceOp.startSeq);
                const endIdx = surfaceNodes.indexOf(opts.surfaceOp.endSeq);
                if (startIdx !== -1 && endIdx !== -1) {
                    surfaceNodes.splice(startIdx, endIdx - startIdx + 1, newSeq);
                    replaceGeneration += 1;
                }
            } else if (type === "user/message" || type === "assistant/message" || type === "tool/result") {
                surfaceNodes.push(newSeq);
            }

            return event;
        },
    };

    // 填充测试初始消息
    let initialEvents = [];
    if (options.initialEvents !== undefined) {
        initialEvents = options.initialEvents;
    } else {
        initialEvents = [
            {
                type: "user/message",
                data: { content: [{ type: "text", text: "旧宿主用户提问：请说明系统的整体架构设计原理。".repeat(10) }] },
            },
            {
                type: "assistant/message",
                data: { message: { content: [{ type: "text", text: "旧宿主助手回答：系统采用分层分级归约架构。".repeat(15) }] } },
            },
            {
                type: "user/message",
                data: { content: [{ type: "text", text: "旧宿主补充要求：请务必保证旧宿主兼容性绝不报错。".repeat(10) }] },
            },
        ];
    }

    for (const item of initialEvents) {
        session.append(item.type, item.data);
    }

    return { session, eventsLog, surfaceNodes };
}

test("D1 + A7/A8 旧宿主无 deriveEventMessage 走 compactRegion 全程不崩，产出有效摘要且 warn 只报一次", async () => {
    // 重置警告状态，隔离用例
    __test.resetWarnedState();

    const warnRecords = [];
    const summaryText = "旧宿主压缩成功产出的浓缩检查点文本";

    const dir = await mkdtemp(join(tmpdir(), "d18-fb1-"));
    try {
        let streamCalledCount = 0;
        let capturedStreamOptions = null;

        const ctx = makeFallbackCtx({
            warnCollector: warnRecords,
            streamImpl: async function* (options) {
                streamCalledCount += 1;
                capturedStreamOptions = options;
                yield { type: "block-start", index: 0, blockType: "text" };
                yield { type: "text-delta", index: 0, text: summaryText };
                yield { type: "block-end", index: 0, block: { type: "text", text: summaryText } };
                yield { type: "finish", reason: { kind: "stop" } };
            },
        });

        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");

        const { session, eventsLog } = makeLegacySession();
        const agent = {
            options: { provider: "legacy-provider", model: "legacy-model" },
            session,
        };

        // 第一次调用 compactRegion：选区 0 到 2
        const result1 = await service.compactRegion(0, 2, agent, undefined);

        // 卫语句校验：不抛错且产出结果
        if (result1 === undefined || result1 === null) {
            throw new Error("D1 失败：compactRegion 在旧宿主下返回了空结果");
        }

        assert.equal(result1.summary, summaryText, "compactRegion 产出的 summary 必须等于模型返回的内容");
        assert.equal(streamCalledCount, 1, "LLM stream 必须被成功调用 1 次");

        // 校验 A7：降级警告必须被记录，且由于去重机制恰好为 1 次
        const deriveWarnsAfterFirst = warnRecords.filter((msg) => msg.includes("deriveEventMessage"));
        assert.equal(deriveWarnsAfterFirst.length, 1, "A7 首次降级时必须恰好记录 1 次警告");

        // 校验 A8：兜底时所有事件内容都能在发送给模型的文本中找到
        if (capturedStreamOptions === null || !Array.isArray(capturedStreamOptions.messages)) {
            throw new Error("A8 失败：未截获合法的 messages 列表");
        }

        const promptText = capturedStreamOptions.messages[0].content[0].text;
        assert.ok(promptText.includes("架构设计原理"), "A8 降级文本中必须包含第 1 条事件的关键内容");
        assert.ok(promptText.includes("分层分级归约架构"), "A8 降级文本中必须包含第 2 条事件的关键内容");
        assert.ok(promptText.includes("旧宿主兼容性绝不报错"), "A8 降级文本中必须包含第 3 条事件的关键内容");

        // 追加更多事件，进行第二次 compactRegion 调用，验证多次调用下 warn 依然去重
        session.append("user/message", { content: "新追加的长篇用户消息内容".repeat(15) });
        session.append("assistant/message", { message: { content: [{ type: "text", text: "新追加的长篇助手回复内容".repeat(15) }] } });

        // 当前表面末两位对应的 seq 为最新加入的事件
        const surface = session.surface.nodes;
        const startSeq = surface[surface.length - 2];
        const endSeq = surface[surface.length - 1];

        const result2 = await service.compactRegion(startSeq, endSeq, agent, undefined);

        if (result2 === undefined || result2 === null) {
            throw new Error("D1 失败：第二次 compactRegion 调用失败");
        }

        const deriveWarnsAfterSecond = warnRecords.filter((msg) => msg.includes("deriveEventMessage"));
        assert.equal(deriveWarnsAfterSecond.length, 1, "多次降级调用期间 warn 必须保持恰好 1 次（防日志刷屏）");

        // 验证替换消息写入了表面且具备检查点标记
        const checkpointEvent = eventsLog.find(
            (event) => event.type === "user/message" && event.options?.surfaceOp?.op === "replace",
        );
        assert.ok(checkpointEvent !== undefined, "必须在表面替换生成检查点 user 消息");
        assert.equal(checkpointEvent.data.content.length, 3, "检查点消息必须是三段结构");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("D1 旧宿主无 deriveEventMessage 走 compactIfNeeded 全程不崩且能完成压缩", async () => {
    // 重置警告状态，隔离用例
    __test.resetWarnedState();

    const warnRecords = [];
    const summaryText = "旧宿主压力压缩成功产出的摘要文本";

    const dir = await mkdtemp(join(tmpdir(), "d18-fb2-"));
    try {
        let streamCalled = false;
        const ctx = makeFallbackCtx({
            warnCollector: warnRecords,
            totalTokens: 90000,
            streamImpl: async function* () {
                streamCalled = true;
                // 模型生成摘要后，模拟压缩使上下文 token 读数回落到安全线以下
                ctx.setMeasurementTokens(30000);
                yield { type: "block-start", index: 0, blockType: "text" };
                yield { type: "text-delta", index: 0, text: summaryText };
                yield { type: "block-end", index: 0, block: { type: "text", text: summaryText } };
                yield { type: "finish", reason: { kind: "stop" } };
            },
        });

        await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
        const service = ctx.get("compaction");

        // 构造多个表面节点的长历史会话，符合宿主角色消息结构
        const initialEvents = [];
        for (let i = 0; i < 10; i += 1) {
            const rawText = `旧宿主长历史对话第 ${i} 轮详细记录信息数据：`.repeat(20);
            if (i % 2 === 0) {
                initialEvents.push({
                    type: "user/message",
                    data: {
                        content: [{ type: "text", text: rawText }],
                    },
                });
            } else {
                initialEvents.push({
                    type: "assistant/message",
                    data: {
                        message: {
                            content: [{ type: "text", text: rawText }],
                        },
                    },
                });
            }
        }

        const { session } = makeLegacySession({
            initialEvents,
            window: 100000,
        });

        const agent = {
            options: { provider: "legacy-provider", model: "legacy-model" },
            session,
        };

        // 触发 context-overflow 类型的 compactIfNeeded 流程
        const result = await service.compactIfNeeded(agent, "context-overflow", undefined);

        // 卫语句校验：不报错且返回合法事务结果
        if (result === undefined || result === null) {
            throw new Error("D1 失败：compactIfNeeded context-overflow 路径返回空");
        }

        assert.equal(streamCalled, true, "compactIfNeeded 必须成功调起摘要流");
        assert.equal(result.summary, summaryText, "返回结果中的 summary 必须匹配");
        assert.ok(result.shadowedSeqs.length > 0, "被压缩的序列长度必须大于 0");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
