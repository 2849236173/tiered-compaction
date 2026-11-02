/**
 * 为摘要调用构造结构化输入，并在宿主投影不可用时回退到文本输入。
 *
 * 对齐原版 basic:695-704。
 * @param {object} session 会话对象
 * @param {number[]} shadowedSeqs 要纳入摘要的事件序号
 * @param {object} logger 可选日志器
 * @returns {{messages: object[], tools?: unknown}} 摘要输入；任何异常都降级为空或文本消息
 */
export function buildSummaryInput(session, shadowedSeqs, logger) {
    // 无会话或无有效选区时不尝试访问宿主 API，保证失败输入也有稳定形状
    if (session === undefined || session === null) {
        return { messages: [] };
    }

    if (!Array.isArray(shadowedSeqs)) {
        return { messages: [] };
    }

    if (shadowedSeqs.length === 0) {
        return { messages: [] };
    }

    // 老宿主没有结构化投影时明确降级，避免摘要静默丢失角色结构
    if (typeof session.deriveEventMessage !== "function") {
        warnOnce("宿主不支持 session.deriveEventMessage，摘要输入退回文本模式。", "missing", logger);
        return buildTextInput(session, shadowedSeqs);
    }

    // 投影过程失败时回退文本，让单条异常事件不阻断整次摘要
    try {
        return buildStructuredInput(session, shadowedSeqs);
    } catch (error) {
        warnOnce("session.deriveEventMessage 调用失败，摘要输入退回文本模式。", "failed", logger);
        return buildTextInput(session, shadowedSeqs);
    }
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
    // 独立类别状态让缺 API 和投影失败各自最多报告一次
    if (kind === "missing") {
        if (missingWarned) {
            return;
        }
        missingWarned = true;
    } else if (kind === "failed") {
        if (failedWarned) {
            return;
        }
        failedWarned = true;
    } else {
        return;
    }

    // logger 可能由旧宿主省略或本身异常，记录失败不能破坏绝不抛错契约
    try {
        if (logger !== undefined && logger !== null && typeof logger.warn === "function") {
            logger.warn(message);
            return;
        }
        console.warn(message);
    } catch {
        // 日志后端不可用时保留摘要路径
    }
}

/**
 * 清空模块级警告状态，供测试隔离用。
 * @returns {void}
 */
function resetWarnedState() {
    missingWarned = false;
    failedWarned = false;
}

/**
 * 只在表面首节点解析出 system/message 时返回 system 头事件。
 * @param {object} session 会话对象
 * @returns {object|undefined} system 头事件；不存在或读取失败时为 undefined
 */
function systemHeadEventOf(session) {
    // system 头只由表面位置决定，避免隐藏或替换事件被误当前言
    try {
        const nodes = session?.surface?.nodes;
        if (!Array.isArray(nodes) || nodes.length === 0) {
            return undefined;
        }

        const first = nodes[0];
        if (first === undefined || first === null) {
            return undefined;
        }

        // 数字序号和带 seq 的节点都必须通过宿主回读，才能得到真实事件
        let event;
        if (typeof first === "number") {
            if (typeof session.eventAt !== "function") {
                return undefined;
            }
            event = session.eventAt(first);
        } else if (typeof first === "object") {
            if (first.seq !== undefined && first.seq !== null) {
                if (typeof session.eventAt !== "function") {
                    return undefined;
                }
                event = session.eventAt(first.seq);
            } else if (first.type !== undefined) {
                event = first;
            } else {
                return undefined;
            }
        } else {
            return undefined;
        }

        // 只允许真正的 system/message 事件作为摘要前言
        if (event === undefined || event === null || event.type !== "system/message") {
            return undefined;
        }

        return event;
    } catch {
        return undefined;
    }
}

/**
 * 将消息内容以兼容文本形式提取，兼容 user 与 assistant/tool 的两种 data 形状。
 * @param {object} event 会话事件
 * @returns {string} 文本和工具调用描述；不可提取时为空字符串
 */
function eventText(event) {
    // 两种宿主形状都尝试读取，防止 user 或 assistant/tool 一侧内容全丢
    try {
        const data = event?.data ?? {};
        const content = data.content ?? data.message?.content;
        if (typeof content === "string") {
            return content;
        }
        if (!Array.isArray(content)) {
            return "";
        }

        const pieces = [];
        for (const block of content) {
            if (block === null || typeof block !== "object") {
                continue;
            }
            // text 块：非字符串即无效块，卫语句跳过，不靠三元兜底
            if (block.type === "text") {
                if (typeof block.text !== "string") {
                    continue;
                }
                if (block.text.length > 0) {
                    pieces.push(block.text);
                }
                continue;
            }
            if (block.type !== "tool-call") {
                continue;
            }

            // tool-call 块：工具名与参数是「做过什么」的唯一线索，必须保留。
            // 字段缺失时用卫语句收敛默认值，不写成三元
            let name = block.name;
            if (typeof name !== "string" || name.length === 0) {
                name = "unknown";
            }

            let args = block.arguments;
            if (typeof args !== "string") {
                args = "";
            }

            pieces.push(`[调用工具 ${name}] ${args}`);
        }

        return pieces.join("\n");
    } catch {
        return "";
    }
}

/**
 * 从事件优先读取 data.role，再依据事件类型推断消息角色。
 * @param {object} event 会话事件
 * @returns {string} 角色名称
 */
function roleOf(event) {
    // data.message.role 与事件类型共同覆盖不同宿主消息布局
    try {
        const data = event?.data ?? {};
        if (typeof data.role === "string") {
            return data.role;
        }
        if (typeof data.message?.role === "string") {
            return data.message.role;
        }
        if (typeof event?.type === "string") {
            const role = event.type.split("/")[0];
            if (role.length > 0) {
                return role;
            }
        }
    } catch {
        return "user";
    }

    return "user";
}

/**
 * 按原版消息排列构造结构化输入，并仅在 header 确实提供时附加 tools。
 * @param {object} session 会话对象
 * @param {number[]} shadowedSeqs 要投影的事件序号
 * @returns {{messages: object[], tools?: unknown}} 结构化摘要输入
 */
function buildStructuredInput(session, shadowedSeqs) {
    // 工具定义不是消息投影的前提，header 异常时只省略 tools
    let tools;
    try {
        if (typeof session.requestHeader === "function") {
            const header = session.requestHeader();
            if (header !== undefined && header !== null) {
                tools = header.tools;
            }
        }
    } catch {
        tools = undefined;
    }

    const messages = [];

    // system 头按表面首节点识别，并固定排在选区消息之前
    const headEvent = systemHeadEventOf(session);
    if (headEvent !== undefined && headEvent !== null) {
        const system = session.deriveEventMessage(headEvent);
        if (system !== null) {
            messages.push(system);
        }
    }

    // 按选区顺序逐条投影；宿主以 null 明确表示该事件不产生消息
    for (const seq of shadowedSeqs) {
        let event;
        try {
            if (typeof session.eventAt !== "function") {
                continue;
            }
            event = session.eventAt(seq);
        } catch {
            continue;
        }
        if (event === undefined || event === null) {
            continue;
        }

        // system 头已在上面单独投影过一次；选区若恰好包含 0 号节点，
        // 这里再投影一次就会让 system 消息出现两次，破坏前缀顺序（KV 缓存就此失效）。
        // 用 seq 比对而不是对象比对，因为 eventAt 每次返回的可能是不同包装对象。
        if (headEvent !== undefined && headEvent !== null && event.seq === headEvent.seq) {
            continue;
        }

        const message = session.deriveEventMessage(event);
        if (message === null) {
            continue;
        }
        messages.push(message);
    }

    // tools 缺失时不创建该键，以保持宿主请求对象的键语义
    const input = { messages };
    if (tools !== undefined) {
        input.tools = tools;
    }
    return input;
}

/**
 * 将事件内容拼成单条 user 文本消息，作为结构化投影不可用时的兜底。
 * @param {object} session 会话对象
 * @param {number[]} shadowedSeqs 要纳入摘要的事件序号
 * @returns {{messages: object[]}} 文本摘要输入
 */
function buildTextInput(session, shadowedSeqs) {
    const parts = [];

    // system 头单独置前，避免与选区内容混淆
    const headEvent = systemHeadEventOf(session);
    if (headEvent !== undefined && headEvent !== null) {
        const text = eventText(headEvent);
        if (text.length > 0) {
            parts.push(`${roleOf(headEvent)}: ${text}`);
        }
    }

    // 逐条提取选区文本；eventAt 单条异常只跳过该项
    for (const seq of shadowedSeqs) {
        let event;
        try {
            if (typeof session.eventAt !== "function") {
                continue;
            }
            event = session.eventAt(seq);
        } catch {
            continue;
        }
        if (event === undefined || event === null) {
            continue;
        }
        if (headEvent !== undefined && event.seq === headEvent.seq) {
            continue;
        }

        const text = eventText(event);
        if (text.length === 0) {
            continue;
        }
        parts.push(`${roleOf(event)}: ${text}`);
    }

    // 没有任何可提取内容时不制造空消息
    if (parts.length === 0) {
        return { messages: [] };
    }

    return {
        messages: [{ role: "user", content: [{ type: "text", text: parts.join("\n\n") }] }],
    };
}

/** 测试专用工具；不属于运行时公开入口。 */
export const __test = { warnOnce, resetWarnedState, roleOf, eventText };
