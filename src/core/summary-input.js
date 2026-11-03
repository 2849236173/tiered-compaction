/**
 * 为摘要调用构造宿主契约形状的结构化消息输入。
 * @param {object} session 会话对象
 * @param {number[]} shadowedSeqs 要纳入摘要的事件序号
 * @param {object} logger 可选日志器
 * @returns {{messages: object[], tools?: unknown}} 摘要输入
 * @throws {Error} 选区消息无法按宿主契约保真投影或重建时
 */
export function buildSummaryInput(session, shadowedSeqs, logger) {
    if (session === undefined || session === null || !Array.isArray(shadowedSeqs)) {
        return { messages: [] };
    }

    if (shadowedSeqs.length === 0) {
        return { messages: [] };
    }

    // 旧宿主缺少投影 API 时只允许按已知事件 schema 无损重建。
    if (typeof session.deriveEventMessage !== "function") {
        warnOnce("宿主不支持 session.deriveEventMessage，摘要输入按事件 schema 重建。", "missing", logger);
        return buildEventInput(session, shadowedSeqs, logger);
    }

    return buildStructuredInput(session, shadowedSeqs);
}

let missingWarned = false;
let failedWarned = false;

/**
 * 按故障类别只警告一次，并兼容宿主 logger 缺失的场景。
 * @param {string} message 警告内容
 * @param {"missing"|"failed"} kind 故障类别
 * @param {object} logger 可选日志器
 * @returns {void}
 */
function warnOnce(message, kind, logger) {
    if (kind === "missing") {
        if (missingWarned) return;
        missingWarned = true;
    } else if (kind === "failed") {
        if (failedWarned) return;
        failedWarned = true;
    } else {
        return;
    }

    try {
        if (logger !== undefined && logger !== null && typeof logger.warn === "function") {
            logger.warn(message);
            return;
        }
        console.warn(message);
    } catch {
        // 日志后端不可用时不掩盖原始输入错误。
    }
}

/** 清空模块级警告状态，供测试隔离用。 */
function resetWarnedState() {
    missingWarned = false;
    failedWarned = false;
}

const MESSAGE_EVENT_TYPES = new Set([
    "system/message",
    "developer/message",
    "user/message",
    "assistant/message",
    "tool/result",
]);

/**
 * 从表面首节点读取 system 头；节点存在但宿主无法回读时失败关闭。
 * @param {object} session 会话对象
 * @returns {object|undefined} system 头事件
 */
function systemHeadEventOf(session) {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return undefined;

    const first = nodes[0];
    const event = typeof first === "number"
        ? eventAt(session, first)
        : first !== null && typeof first === "object" && first.seq !== undefined && first.seq !== null
            ? eventAt(session, first.seq)
            : first !== null && typeof first === "object" && typeof first.type === "string"
                ? first
                : undefined;
    return event?.type === "system/message" ? event : undefined;
}

/** 从宿主事件日志读取一个应参与摘要的 seq。 */
function eventAt(session, seq) {
    if (typeof session.eventAt !== "function") {
        throw new Error(`tiered-compaction: 摘要输入无法读取 seq=${seq}：session.eventAt 不可用`);
    }
    let event;
    try {
        event = session.eventAt(seq);
    } catch (error) {
        throw inputError(seq, undefined, "session.eventAt 抛错", error);
    }
    if (event === undefined || event === null) {
        throw inputError(seq, undefined, "事件不存在");
    }
    return event;
}

/** 当前宿主投影会把空 system/developer/assistant 消息映射为 null。 */
function isKnownEmptyMessage(event) {
    if (!["system/message", "developer/message", "assistant/message"].includes(event?.type)) return false;
    return Array.isArray(event?.data?.message?.content) && event.data.message.content.length === 0;
}

/** basic 仅投影已知消息事件；类型以 /message 结尾的未知事件不得静默丢失。 */
function isNonMessageEvent(event) {
    if (MESSAGE_EVENT_TYPES.has(event?.type)) return false;
    if (typeof event?.type === "string" && event.type.endsWith("/message")) return false;
    return event?.surfaceOp === undefined;
}

/** 在错误文本中保留原始事件定位，供失败事务与日志诊断。 */
function inputError(seq, type, reason, cause) {
    const eventType = typeof type === "string" ? type : "unknown";
    const error = new Error(`tiered-compaction: 摘要输入无法保真重建 seq=${seq} type=${eventType}：${reason}`, cause === undefined ? undefined : { cause });
    error.code = "SUMMARY_INPUT_INVALID";
    return error;
}

/** 规范化宿主投影，但不改写消息字段或 content block 的顺序和值。 */
function normalizeMessage(message, event) {
    const seq = event?.seq ?? "unknown";
    const type = event?.type;
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
        throw inputError(seq, type, "投影结果不是消息对象");
    }

    const inferredRole = type === "tool/result" ? "tool" : type?.split("/")[0];
    const role = message.role ?? inferredRole;
    if (typeof role !== "string" || role.length === 0) {
        throw inputError(seq, type, "role 缺失或无效");
    }

    let content = message.content;
    if (typeof content === "string") {
        content = [{ type: "text", text: content }];
    } else if (Array.isArray(content)) {
        for (const [index, block] of content.entries()) {
            if (block === null || typeof block !== "object" || Array.isArray(block) || typeof block.type !== "string") {
                throw inputError(seq, type, `content[${index}] 不是有效内容块`);
            }
        }
    } else {
        throw inputError(seq, type, "content 缺失或不是字符串/内容块数组");
    }

    return { ...message, role, content };
}

/**
 * 按原版消息排列构造结构化输入，并仅在 header 确实提供时附加 tools。
 * @param {object} session 会话对象
 * @param {number[]} shadowedSeqs 要投影的事件序号
 * @returns {{messages: object[], tools?: unknown}} 结构化摘要输入
 */
function buildStructuredInput(session, shadowedSeqs) {
    const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
    const messages = [];

    // system 头按宿主/basic 顺序置前，且选区包含它时只出现一次。
    const headEvent = systemHeadEventOf(session);
    if (headEvent !== undefined && headEvent.type === "system/message") {
        const system = projectMessage(session, headEvent);
        if (system !== null) messages.push(system);
    }

    for (const seq of shadowedSeqs) {
        const event = eventAt(session, seq);
        if (headEvent !== undefined && event.seq === headEvent.seq) continue;
        const message = projectMessage(session, event);
        if (message !== null) messages.push(message);
    }

    const input = { messages };
    if (header?.tools !== undefined) input.tools = header.tools;
    return input;
}

/** 按真实宿主 deriveEventMessage 语义投影一条消息，并 fail-closed 校验。 */
function projectMessage(session, event) {
    if (isNonMessageEvent(event)) return null;
    if (!MESSAGE_EVENT_TYPES.has(event?.type)) {
        throw inputError(event?.seq ?? "unknown", event?.type, "未知事件带有 surfaceOp，不能安全排除");
    }

    let projected;
    try {
        projected = session.deriveEventMessage(event);
    } catch (error) {
        throw inputError(event?.seq ?? "unknown", event?.type, "session.deriveEventMessage 抛错", error);
    }
    if (projected === null && isKnownEmptyMessage(event)) return null;
    if (projected === null || projected === undefined) {
        throw inputError(event?.seq ?? "unknown", event?.type, "宿主投影未产生应有消息");
    }
    return normalizeMessage(projected, event);
}


/**
 * 老宿主缺投影 API 时按当前 Session 事件 schema 重建结构化消息。
 * 不支持的应纳入事件必须抛错，不得跳过后继续摘要。
 */
function buildEventInput(session, shadowedSeqs, logger) {
    const header = typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
    const messages = [];
    const headEvent = systemHeadEventOf(session);

    if (headEvent !== undefined && headEvent.type === "system/message") {
        const system = fallbackMessageOf(headEvent, logger);
        if (system !== null) messages.push(system);
    }

    for (const seq of shadowedSeqs) {
        const event = eventAt(session, seq);
        if (headEvent !== undefined && event.seq === headEvent.seq) continue;
        const message = fallbackMessageOf(event, logger);
        if (message !== null) messages.push(message);
    }

    const input = { messages };
    if (header?.tools !== undefined) input.tools = header.tools;
    return input;
}

/** 从已知事件布局无损构造消息，其他内容留在原始块中。 */
function fallbackMessageOf(event, logger) {
    if (isNonMessageEvent(event)) return null;
    if (!MESSAGE_EVENT_TYPES.has(event?.type)) {
        throw inputError(event?.seq ?? "unknown", event?.type, "未知事件类型，无法判定其是否应进入消息历史");
    }

    const data = event.data;
    const source = event.type === "user/message" ? data : data?.message;
    if (source === null || typeof source !== "object" || Array.isArray(source)) {
        throw inputError(event.seq, event.type, "消息对象缺失或布局未知");
    }

    const message = normalizeMessage(source, event);
    if (message.content.length === 0 && isKnownEmptyMessage(event)) return null;
    return message;
}

/** 测试专用工具；不属于运行时公开入口。 */
export const __test = { resetWarnedState, inputError };
