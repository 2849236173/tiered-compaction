/**
 * d30 测试共用夹具：真实宿主 Session + 宿主 session/event 派发语义（自检规矩 R5/R6）。
 *
 * 宿主 API 已对照源码（G:\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-session\lib\index.js）：
 *   · `Session.create(id)` 建会话；
 *   · `append(type, data, { surfaceOp, sourceEventSeqs })` 把 surfaceOp 展开在事件**顶层**（lib:1517-1534）；
 *   · `surface.nodes` 是当前表面的 seq 数组；`eventAt(seq)` 返回日志里的同一事件对象。
 * 宿主 commit 后同步派发 session/event 且不 await 监听者 Promise——`wire()` 照此模拟。
 *
 * 宿主不在时（CI 机器没装 DSH Desktop）`Session` 为 null，调用方据此 skip。
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolResultObserver } from "../src/tool-result-observer.js";
import { TieredCompactionEngine } from "../src/engine.js";

const HOST_SESSION = "G:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-session/lib/index.js";

/** 真实宿主 Session 类；宿主不在时为 null。 */
export const Session = existsSync(HOST_SESSION)
    ? (await import(pathToFileURL(HOST_SESSION).href)).Session
    : null;

/** 宿主缺失时的 skip 原因（node:test 的 `skip` 选项）。 */
export const skipWithoutHost = Session === null ? "需要本机 DSH Desktop 的 dsh-session" : false;

export const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * 模拟宿主 commit 后的 session/event 派发：同步调用、不 await。
 * @param {object} session 真实 Session
 * @param {Array<Function>} listeners
 */
export function wire(session, listeners) {
    const original = session.append.bind(session);
    session.append = (type, data, opts) => {
        const event = original(type, data, opts);
        for (const listener of listeners) Promise.resolve(listener(session, event)).catch(() => {});
        return event;
    };
}

/**
 * 真实 engine + observer + Session 的组装（observer.register 走 ctx.on）。
 * @param {string} label 会话 id 中段（8 位）
 * @returns {Promise<{session: object, observer: ToolResultObserver, engine: TieredCompactionEngine, archiveDir: string, listeners: Function[]}>}
 */
export async function setup(label) {
    const archiveDir = await mkdtemp(join(tmpdir(), "d30-"));
    const engine = new TieredCompactionEngine({ archiveDir, logger: quietLogger });
    const listeners = [];
    const ctx = { logger: quietLogger, on: (name, fn) => { if (name === "session/event") listeners.push(fn); } };
    const observer = new ToolResultObserver({ engine, ctx });
    observer.register();
    const session = Session.create(`session-${label}-0000-1111`);
    wire(session, listeners);
    return { session, observer, engine, archiveDir, listeners };
}

/**
 * 追加一组 user → assistant(tool-call) → tool/call → tool/result，返回 tool/result 事件。
 * @param {object} session
 * @param {string} text 工具结果文本
 * @param {string} [name] 工具名
 * @param {string} [id] callId
 */
export function seedTool(session, text, name = "read", id = "c1") {
    session.append("user/message", { role: "user", content: [{ type: "text", text: "go" }], id: `u-${id}` }, { surfaceOp: "append" });
    session.append("assistant/message", {
        role: "assistant",
        id: `a-${id}`,
        content: [{ type: "tool-call", toolCallId: id, toolName: name, input: {} }],
    }, { surfaceOp: "append" });
    session.append("tool/call", { callId: id, name, arguments: "{}" });
    return session.append("tool/result", {
        message: { role: "tool", toolCallId: id, content: [{ type: "text", text }], id: `t-${id}` },
    }, { surfaceOp: "append" });
}

/** 读出会话日志全部事件。 */
export function eventsOf(session) {
    const events = [];
    for (let seq = 0; ; seq += 1) {
        const event = session.eventAt(seq);
        if (!event) break;
        events.push(event);
    }
    return events;
}

/**
 * 冷加载 span 校验（照 dsh-session-format-v3-to-v4 lib:700-738 的语义）：
 * 每枚 prune 的 shadowedSeqs 必须精确命名当前表面上的一段连续区间。
 * @returns {string} "OK" 或首个违例描述
 */
export function coldReplay(events) {
    const surface = [];
    for (const event of events) {
        if (event.type === "compaction/prune" || event.type === "compaction/summary") {
            const { start, end } = event.data.shadowedRange;
            const i = surface.indexOf(start);
            const j = surface.indexOf(end);
            const current = i >= 0 && j >= i ? surface.slice(i, j + 1) : null;
            if (!current || JSON.stringify(current) !== JSON.stringify(event.data.shadowedSeqs)) {
                return `seq ${event.seq} ${event.type} stale span (surface=${JSON.stringify(surface)})`;
            }
            continue;
        }
        if (event.surfaceOp === "append") surface.push(event.seq);
        else if (event.surfaceOp?.op === "replace") {
            const i = surface.indexOf(event.surfaceOp.startSeq);
            const j = surface.indexOf(event.surfaceOp.endSeq);
            if (i < 0 || j < i) return `seq ${event.seq} replacement range not on surface`;
            surface.splice(i, j - i + 1, event.seq);
        }
    }
    return "OK";
}

/**
 * 宿主 pruner 同形的同步替换（dsh-compaction-tool-result-pruner pruneSession 逐字段同形）。
 * @param {object} session
 * @param {number} seq 要替换的 tool/result seq
 */
export function hostReplace(session, seq) {
    const event = session.eventAt(seq);
    const text = event.data.message.content[0].text;
    session.append("compaction/prune", {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: 100,
    });
    return session.append("tool/result", {
        ...event.data,
        message: { ...event.data.message, content: [{ type: "text", text: `${text.slice(0, 64)}\n[... tool result middle pruned ...]` }] },
    }, { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
}

/** 等宿主不 await 的监听者跑完（落盘是真实 I/O）。 */
export function settle(ms = 400) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
