/**
 * D29 验收（client 半）：两入口共享状态源 + 按当前会话取数 + 轮询刷新。
 *
 * 修复前：每个入口 `useEffect(..., [])` 挂载时 fetch 一次 `/status`（还用
 * `.pathname` 丢掉 query），之后永不刷新；两入口各取各的；快照不带 sessionId。
 *
 * 本文件覆盖：
 *   1. 同一次挂载内，轮询把数字从 0 刷到非 0；页面隐藏时轮询跳过；
 *   2. 切会话 A→B：请求带不同的 session 参数，并显示对应数据；
 *      快照属于别的会话时按「加载中」处理，不串数；
 *   3. 两个入口共享同一份快照（第二个入口挂载不重复请求）；
 *   4. 全部卸载后停表、摘 visibilitychange 监听；
 *   5. 拿不到 useSessions 时退回无参数请求。
 *
 * mock react 比 d26/d28 多两件事：effect 按 deps 比较重跑并执行 cleanup；
 * setState 后由测试显式 rerender（宿主真实 React 会自动重渲）。
 *
 * 运行：node --test test/d29-client-session-store.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
const FAKE_BASE_URI = "http://127.0.0.1:16271/chat?session=page-own-param";
const SETTINGS_SLOT = "settings.section";
const OVERLAY_SLOT = "shell.overlay";
const STATUS_PATH = "/api/tiered-compaction/status";

/** 造一份 ready 载荷：processed 决定「无损折叠」数字。 */
function payloadOf(sessionId, processed, pressure = 0.27) {
    return {
        status: "ok",
        pressure,
        window: 1000000,
        layers: {
            l12Processed: processed, l12Replaced: processed, l12Failed: 0, l12Skipped: 0,
            l12BytesSaved: 0, l3Evicted: 0, spillCount: 0, lineageEntries: 0, l4Summaries: 0,
        },
        since: Date.UTC(2026, 9, 30, 2, 5, 0),
        sessionId,
    };
}

/** 带 deps 语义的 mock react（hook 槽位按组件函数分开存）。 */
function createMockReact() {
    const hookStores = new Map();
    let activeStore = null;
    let hookIndex = 0;
    let pendingEffects = [];

    function renderNode(node) {
        if (Array.isArray(node)) return node.map(renderNode);
        if (node === null || node === undefined || typeof node !== "object") return node;
        if (typeof node.type === "function") {
            if (!hookStores.has(node.type)) hookStores.set(node.type, []);
            const outerStore = activeStore;
            const outerIndex = hookIndex;
            activeStore = hookStores.get(node.type);
            hookIndex = 0;
            const rendered = node.type(node.props);
            activeStore = outerStore;
            hookIndex = outerIndex;
            return renderNode(rendered);
        }
        return { type: node.type, props: node.props, children: (node.children ?? []).map(renderNode) };
    }

    const sameDeps = (a, b) =>
        Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

    const react = {
        createElement(type, props, ...children) {
            return { type, props: props ?? {}, children };
        },
        useState(initial) {
            const store = activeStore;
            const index = hookIndex++;
            if (!(index in store)) store[index] = { value: typeof initial === "function" ? initial() : initial };
            const slot = store[index];
            return [slot.value, (value) => {
                slot.value = typeof value === "function" ? value(slot.value) : value;
            }];
        },
        useEffect(effect, deps) {
            const store = activeStore;
            const index = hookIndex++;
            if (!(index in store)) store[index] = { deps: undefined, cleanup: undefined, ran: false };
            const slot = store[index];
            if (!slot.ran || deps === undefined || !sameDeps(slot.deps, deps)) {
                pendingEffects.push({ slot, effect, deps });
            }
        },
        useRef(initial) {
            const store = activeStore;
            const index = hookIndex++;
            if (!(index in store)) store[index] = { current: initial };
            return store[index];
        },
        useMemo(factory) {
            return factory();
        },
        useCallback(fn) {
            return fn;
        },
        /** 一轮渲染 + 提交 effect（先 cleanup 旧的，再跑新的）。 */
        render(component, props) {
            pendingEffects = [];
            const tree = renderNode(react.createElement(component, props));
            for (const { slot, effect, deps } of pendingEffects) {
                if (typeof slot.cleanup === "function") slot.cleanup();
                const cleanup = effect();
                slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
                slot.deps = deps;
                slot.ran = true;
            }
            pendingEffects = [];
            return tree;
        },
        /** 卸载某个组件：执行它所有 effect 的 cleanup。 */
        unmountAll() {
            for (const store of hookStores.values()) {
                for (const slot of store) {
                    if (slot && typeof slot.cleanup === "function") {
                        slot.cleanup();
                        slot.cleanup = undefined;
                    }
                }
            }
        },
    };
    return react;
}

/** 在 vm 沙箱里执行 client.js，提供可控的 fetch / 定时器 / document。 */
function loadClient() {
    const react = createMockReact();
    let loadedSpec = null;
    const listeners = new Map();
    const documentMock = {
        baseURI: FAKE_BASE_URI,
        visibilityState: "visible",
        addEventListener(name, handler) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(handler);
        },
        removeEventListener(name, handler) {
            listeners.get(name)?.delete(handler);
        },
        listenerCount(name) {
            return listeners.get(name)?.size ?? 0;
        },
        dispatch(name) {
            for (const handler of [...(listeners.get(name) ?? [])]) handler({});
        },
    };
    const timers = new Map();
    let timerSeq = 0;
    const requested = [];
    let respond = () => payloadOf(null, 0);
    const sandbox = {
        window: { __ModuleLoader__: { load(spec) { loadedSpec = spec; } } },
        document: documentMock,
        URL,
        setInterval(fn, ms) {
            timerSeq += 1;
            timers.set(timerSeq, { fn, ms });
            return timerSeq;
        },
        clearInterval(id) {
            timers.delete(id);
        },
        fetch: async (input) => {
            const url = String(input);
            requested.push(url);
            const session = new URL(url, "http://x").searchParams.get("session");
            return { ok: true, json: async () => respond(session, url) };
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(CLIENT_SOURCE, sandbox, { filename: "client/client.js" });
    assert.ok(loadedSpec, "client.js 必须调用 window.__ModuleLoader__.load");
    const plugin = loadedSpec.factory(() => react);
    const registrations = [];
    plugin.apply({
        slots: {
            inject(_name, callback) { callback(); },
            register(options, component) {
                registrations.push({ options, component });
                return () => {};
            },
        },
    });
    const componentOf = (name) => registrations.find((r) => r.options.name === name)?.component;
    return {
        react,
        documentMock,
        timers,
        requested,
        setResponder(fn) { respond = fn; },
        componentOf,
        /** 触发所有定时器一次（= 过了 5 秒）。 */
        tick() {
            for (const { fn } of [...timers.values()]) fn();
        },
    };
}

/** 宿主 useSessions 桩：selector 作用在可变的会话表上。 */
function sessionsHook() {
    const state = { byId: {} };
    const hook = (selector) => selector(state);
    hook.show = (id) => {
        state.byId = {
            [id]: { id, retainedBy: { mainView: 1 } },
            other: { id: "other", retainedBy: {} },
        };
    };
    return hook;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function collectTextOf(node) {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(collectTextOf).join("");
    if (node !== null && typeof node === "object" && Array.isArray(node.children)) {
        return collectTextOf(node.children);
    }
    return "";
}

test("D29-C1 同一次挂载内轮询刷新：0 → 非 0；页面隐藏时跳过", async () => {
    const env = loadClient();
    const useSessions = sessionsHook();
    useSessions.show("sess-A");
    let processed = 0;
    env.setResponder((session) => payloadOf(session, processed));
    const Settings = env.componentOf(SETTINGS_SLOT);

    env.react.render(Settings, { useSessions });
    await flush();
    assert.match(collectTextOf(env.react.render(Settings, { useSessions })), /无损折叠\s*0/);
    assert.equal(env.timers.size, 1, "有订阅者时必须挂上轮询");
    assert.equal([...env.timers.values()][0].ms, 5000, "轮询间隔 5 秒");

    processed = 7;
    env.documentMock.visibilityState = "hidden";
    const before = env.requested.length;
    env.tick();
    await flush();
    assert.equal(env.requested.length, before, "页面隐藏时不请求");

    env.documentMock.visibilityState = "visible";
    env.tick();
    await flush();
    assert.match(
        collectTextOf(env.react.render(Settings, { useSessions })),
        /无损折叠\s*7/,
        "不重新挂载也能看到新数字",
    );
});

test("D29-C2 切会话 A→B：请求带不同 session 参数，显示对应数据，不串数", async () => {
    const env = loadClient();
    const useSessions = sessionsHook();
    useSessions.show("sess-A");
    const pending = [];
    env.setResponder((session) => payloadOf(session, session === "sess-A" ? 11 : 22));
    const Settings = env.componentOf(SETTINGS_SLOT);

    env.react.render(Settings, { useSessions });
    await flush();
    assert.equal(env.requested.at(-1), `${STATUS_PATH}?session=sess-A`, "带当前会话参数，不带页面自己的 query");
    assert.match(collectTextOf(env.react.render(Settings, { useSessions })), /无损折叠\s*11/);

    // 切到 B：B 的响应还没回来之前，A 的数字不得显示在 B 下
    let releaseB;
    env.setResponder((session) => {
        if (session === "sess-B") {
            return new Promise((resolve) => { releaseB = () => resolve(payloadOf("sess-B", 22)); pending.push(1); });
        }
        return payloadOf(session, 11);
    });
    useSessions.show("sess-B");
    const duringSwitch = collectTextOf(env.react.render(Settings, { useSessions }));
    assert.equal(env.requested.at(-1), `${STATUS_PATH}?session=sess-B`, "切会话立即用新参数请求");
    assert.doesNotMatch(duringSwitch, /无损折叠\s*11/, "旧会话的快照按加载中处理");

    await flush();
    releaseB();
    await flush();
    assert.match(collectTextOf(env.react.render(Settings, { useSessions })), /无损折叠\s*22/);
});

test("D29-C3 两个入口共享同一份快照，第二个入口不重复请求", async () => {
    const env = loadClient();
    const useSessions = sessionsHook();
    useSessions.show("sess-A");
    let processed = 3;
    env.setResponder((session) => payloadOf(session, processed, 0.42));
    const Settings = env.componentOf(SETTINGS_SLOT);
    const Overlay = env.componentOf(OVERLAY_SLOT);

    env.react.render(Settings, { useSessions });
    await flush();
    const afterFirst = env.requested.length;
    env.react.render(Overlay, { useSessions });
    await flush();
    assert.equal(env.requested.length, afterFirst, "同一会话的第二个入口复用快照");
    assert.equal(env.timers.size, 1, "两个入口只有一个轮询");

    processed = 9;
    env.setResponder((session) => payloadOf(session, processed, 0.55));
    env.tick();
    await flush();
    const settingsText = collectTextOf(env.react.render(Settings, { useSessions }));
    const overlayText = collectTextOf(env.react.render(Overlay, { useSessions }));
    assert.match(settingsText, /55/, "设置分区拿到新压力");
    assert.match(overlayText, /55/, "HUD 拿到同一份新压力");
    assert.doesNotMatch(overlayText, /42/, "HUD 不停留在旧值");
});

test("D29-C4 全部卸载后停表并摘掉 visibilitychange 监听", async () => {
    const env = loadClient();
    const useSessions = sessionsHook();
    useSessions.show("sess-A");
    env.setResponder((session) => payloadOf(session, 1));
    const Settings = env.componentOf(SETTINGS_SLOT);
    env.react.render(Settings, { useSessions });
    await flush();
    assert.equal(env.documentMock.listenerCount("visibilitychange"), 1);

    // 重新可见时立刻补一次
    const before = env.requested.length;
    env.documentMock.dispatch("visibilitychange");
    await flush();
    assert.equal(env.requested.length, before + 1, "重新可见立即刷新");

    env.react.unmountAll();
    assert.equal(env.timers.size, 0, "卸载后停表");
    assert.equal(env.documentMock.listenerCount("visibilitychange"), 0, "卸载后摘监听");
});

test("D29-C5 拿不到 useSessions 时退回无参数请求", async () => {
    const env = loadClient();
    env.setResponder(() => payloadOf("latest", 5));
    const Settings = env.componentOf(SETTINGS_SLOT);
    env.react.render(Settings, {});
    await flush();
    assert.equal(env.requested.at(-1), STATUS_PATH);
    assert.match(collectTextOf(env.react.render(Settings, {})), /无损折叠\s*5/, "不区分会话时直接显示");
});
