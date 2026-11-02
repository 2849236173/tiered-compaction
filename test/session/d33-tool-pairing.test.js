// beta6 回归：配对检查必须只靠 eventAt。
// 实测（2026-11-01）：插件运行时解析到 CLI 版 dsh-compaction 0.1.0-rc.7，
// 它读 session.events[seq]；桌面宿主 0.2.1-rc.2 的 Session 没有 events，
// 于是第 4 层每次都报 "Cannot read properties of undefined (reading '<seq>')"。
import test from "node:test";
import assert from "node:assert/strict";
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from "../../src/session/tool-pairing.js";

function rc2Session(events) {
    // 只暴露桌面宿主 rc.2 具备的读口：eventAt + surface；故意没有 events
    const log = events.map((e, seq) => ({ ...e, seq }));
    const nodes = log.filter((e) => e.surface).map((e) => e.seq);
    return {
        eventAt: (seq) => log[seq],
        surface: { nodes, replaceGeneration: 0 },
    };
}

const call = (n) => ({ type: "assistant/message", surface: true, data: { message: { content: Array.from({ length: n }, () => ({ type: "tool-call" })) } } });
const result = () => ({ type: "tool/result", surface: true, data: { message: { content: [] } } });
const sys = () => ({ type: "system/message", surface: true, data: { message: { content: [{ type: "text", text: "s" }] } } });
const user = () => ({ type: "user/message", surface: true, data: { content: [] } });

test("D33-1 只有 eventAt 的会话（桌面宿主形状）能算配对，不读 session.events", () => {
    const s = rc2Session([sys(), user(), call(2), result(), result(), user()]);
    assert.equal("events" in s, false);
    assert.equal(toolPairingBalancedBefore(s, 0), true);
    assert.equal(toolPairingBalancedBefore(s, 3), false, "调用后、结果前不配平");
    assert.equal(toolPairingBalancedAfter(s, 3), false, "两个调用只回了一个");
    assert.equal(toolPairingBalancedAfter(s, 4), true);
    assert.equal(toolPairingBalancedBefore(s, 5), true);
});

test("D33-2 结果多于调用时报 corrupt，而不是 TypeError", () => {
    const s = rc2Session([sys(), result()]);
    assert.throws(() => toolPairingBalancedBefore(s, 1), /no matching tool-call/);
});

test("D33-3 contract.js 不再从 dsh-compaction 取配对函数", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../src/host/contract.js", import.meta.url), "utf8");
    const fromPkg = /\{[^}]*toolPairingBalanced[^}]*\}\s*from\s*"@deepseek-ai\/dsh-compaction"/s.test(src);
    assert.equal(fromPkg, false);
});
