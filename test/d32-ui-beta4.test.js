/**
 * D32 验收（client 半，beta4 UI）：界面数字必须真实对应压缩效果。
 *
 * 覆盖：
 *   1. 分层字节：折叠行用 l1BytesSaved、落盘行用 l2BytesSaved；新字段缺失才回落
 *      l12BytesSaved 并标「L1+L2 合计（字符）」；
 *   2. 缺字段显示「—」不显示 0；驱逐/摘要行「≈ N tokens」；
 *   3. 总节省 = 三项 token 之和 + 占窗口百分比；三项全缺不渲染；
 *   4. 自动压缩告警：0.98 且 autoCheckedAt=null → 告警；最近检查 → 「N 秒前检查」；
 *      旧载荷（无该字段）→ 什么都不显示；
 *   5. HUD 关闭 → 恢复胶囊 → 点击恢复；设置页开关同步；
 *   6. normalizeHudState 向后兼容：旧存档无 collapsed → 展开；collapsed:true → 胶囊；
 *   7. 同会话压力降 ≥10 个百分点 → 「已压缩：96% → 40%，节省 ≈ 141k tokens」+ 条脉冲；
 *      计数上涨的芯片带高亮类。
 *
 * mock react 沿用 d29（effect 按 deps 重跑 + cleanup），另注入 localStorage。
 *
 * 运行：node --test test/d32-ui-beta4.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
const FAKE_BASE_URI = "http://127.0.0.1:16271/chat";
const SETTINGS_SLOT = "settings.section";
const OVERLAY_SLOT = "shell.overlay";
const HUD_STATE_KEY = "tiered-compaction-hud-state";

/** beta4 完整载荷：分层字节 + 分层 token + 自动压缩健康 + 最近一次摘要。 */
function beta4Payload(overrides = {}) {
    const { layers: layerOverrides, ...rest } = overrides;
    return {
        status: "ok",
        pressure: 0.5,
        window: 262144,
        currentTokens: 131072,
        since: Date.UTC(2026, 9, 30, 2, 5, 0),
        sessionId: "sess-A",
        autoEnabled: true,
        autoCheckedAt: Date.now() - 5000,
        lastCompaction: null,
        layers: {
            l12Processed: 40, l12BytesSaved: 999999, spillCount: 6, l3Evicted: 4,
            l4Summaries: 1, l4ProcessSummaries: 3,
            l1Folded: 31, l1BytesSaved: 51200, l2BytesSaved: 3 * 1024 * 1024,
            l12TokensSaved: 20000, l3TokensSaved: 66100, l4TokensSaved: 120000,
            ...layerOverrides,
        },
        ...rest,
    };
}

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
    };
    return react;
}

function createStorageMock(initialEntries = {}) {
    const store = new Map(Object.entries(initialEntries));
    return {
        getItem(key) { return store.has(key) ? store.get(key) : null; },
        setItem(key, value) { store.set(key, String(value)); },
        removeItem(key) { store.delete(key); },
    };
}

/** 沙箱：可控 fetch / 定时器 / localStorage。 */
function loadClient({ storage = createStorageMock() } = {}) {
    const react = createMockReact();
    let loadedSpec = null;
    const timers = new Map();
    let timerSeq = 0;
    let respond = () => beta4Payload();
    const sandbox = {
        window: { __ModuleLoader__: { load(spec) { loadedSpec = spec; } }, localStorage: storage },
        document: { baseURI: FAKE_BASE_URI, visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
        URL,
        setInterval(fn, ms) {
            timerSeq += 1;
            timers.set(timerSeq, { fn, ms });
            return timerSeq;
        },
        clearInterval(id) { timers.delete(id); },
        fetch: async () => ({ ok: true, json: async () => respond() }),
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
    return {
        react,
        storage,
        setResponder(fn) { respond = fn; },
        componentOf: (name) => registrations.find((r) => r.options.name === name)?.component,
        tick() {
            for (const { fn } of [...timers.values()]) fn();
        },
    };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function collectTextOf(node) {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(collectTextOf).join("");
    if (node !== null && typeof node === "object" && Array.isArray(node.children)) return collectTextOf(node.children);
    return "";
}

function walkTree(node, visit) {
    if (Array.isArray(node)) {
        node.forEach((child) => walkTree(child, visit));
        return;
    }
    if (node !== null && typeof node === "object") {
        visit(node);
        if (Array.isArray(node.children)) node.children.forEach((child) => walkTree(child, visit));
    }
}

function nodeWith(tree, predicate) {
    let hit = null;
    walkTree(tree, (node) => {
        if (hit === null && predicate(node)) hit = node;
    });
    return hit;
}

const byTestId = (tree, id) => nodeWith(tree, (node) => node.props?.["data-testid"] === id);
const layerRow = (tree, key) => nodeWith(tree, (node) => node.props?.["data-layer"] === key);

/** 挂载一个入口并等首轮取数完成，返回最终树与重渲函数。 */
async function mount(slot, payload, options = {}) {
    const env = loadClient(options);
    if (payload !== undefined) env.setResponder(() => payload);
    const Component = env.componentOf(slot);
    env.react.render(Component, {});
    await flush();
    const rerender = () => env.react.render(Component, {});
    return { env, tree: rerender(), rerender };
}

test("D32-1 分层字节：折叠行=l1BytesSaved，落盘行=l2BytesSaved，不再用合计字符", async () => {
    const { tree } = await mount(SETTINGS_SLOT, beta4Payload());
    const fold = collectTextOf(layerRow(tree, "l12Processed"));
    const spill = collectTextOf(layerRow(tree, "spillCount"));
    assert.match(fold, /31/, "折叠数取 l1Folded");
    assert.match(fold, /省 ~50 KB/, "折叠行显示 l1BytesSaved（51200 字节）");
    assert.match(spill, /省 ~3\.0 MB/, "落盘行显示 l2BytesSaved（3 MB）");
    assert.doesNotMatch(collectTextOf(tree), /合计（字符）/, "新字段齐全时不回落合计口径");

    // 旧服务端：只有 l12BytesSaved → 回落并明确标注口径
    const legacy = beta4Payload();
    for (const key of ["l1Folded", "l1BytesSaved", "l2BytesSaved"]) delete legacy.layers[key];
    const legacyTree = (await mount(SETTINGS_SLOT, legacy)).tree;
    assert.match(collectTextOf(layerRow(legacyTree, "spillCount")), /折叠\+落盘合计（字符）/);
    assert.match(collectTextOf(layerRow(legacyTree, "l12Processed")), /40/, "缺 l1Folded 回落 l12Processed");
});

test("D32-2 驱逐/摘要行 ≈ N tokens；L4 标本会话 + 进程累计；缺字段显示 — 而不是 0", async () => {
    const { tree } = await mount(SETTINGS_SLOT, beta4Payload());
    assert.match(collectTextOf(layerRow(tree, "l3Evicted")), /≈ 66\.1k tokens/);
    const summary = collectTextOf(layerRow(tree, "l4Summaries"));
    assert.match(summary, /≈ 120k tokens/);
    assert.match(summary, /本会话/);
    assert.match(summary, /全进程 3/);

    const partial = beta4Payload();
    delete partial.layers.l3Evicted;
    delete partial.layers.l3TokensSaved;
    const partialTree = (await mount(SETTINGS_SLOT, partial)).tree;
    const evict = collectTextOf(layerRow(partialTree, "l3Evicted"));
    assert.match(evict, /—/, "缺计数显示 —");
    assert.doesNotMatch(evict, /0|tokens/, "缺字段不得显示 0 或编 token 数");
});

test("D32-3 总节省 = 三项 token 之和 + 占窗口百分比；三项全缺不渲染", async () => {
    const { tree } = await mount(SETTINGS_SLOT, beta4Payload());
    const total = collectTextOf(byTestId(tree, "total-saved"));
    // 20000 + 66100 + 120000 = 206100；206100 / 262144 = 78.6%
    assert.match(total, /总节省/);
    assert.match(total, /≈ 206k tokens/);
    assert.match(total, /78\.6%/);

    const legacy = beta4Payload();
    for (const key of ["l12TokensSaved", "l3TokensSaved", "l4TokensSaved"]) delete legacy.layers[key];
    assert.equal(byTestId((await mount(SETTINGS_SLOT, legacy)).tree, "total-saved"), null, "全缺时隐藏");
});

test("D32-4 自动压缩健康：0.98 且从未检查 → 告警；最近检查 → N 秒前；旧载荷 → 不显示", async () => {
    const stale = beta4Payload({ pressure: 0.98, autoCheckedAt: null });
    const staleTree = (await mount(SETTINGS_SLOT, stale)).tree;
    assert.match(collectTextOf(byTestId(staleTree, "auto-warning")), /自动压缩未运行，可手动执行 \/compact/);
    const hudTree = (await mount(OVERLAY_SLOT, stale)).tree;
    assert.ok(byTestId(hudTree, "overlay-auto-warning"), "HUD 里也有紧凑告警");

    const tooOld = beta4Payload({ pressure: 0.98, autoCheckedAt: Date.now() - 10 * 60 * 1000 });
    assert.ok(byTestId((await mount(SETTINGS_SLOT, tooOld)).tree, "auto-warning"), "超过 120 秒同样告警");

    const recent = beta4Payload({ pressure: 0.98, autoCheckedAt: Date.now() - 5000 });
    const recentTree = (await mount(SETTINGS_SLOT, recent)).tree;
    assert.equal(byTestId(recentTree, "auto-warning"), null, "最近检查过不告警");
    assert.match(collectTextOf(byTestId(recentTree, "auto-checked")), /自动压缩：\d+ 秒前检查/);

    const disabled = beta4Payload({ pressure: 0.98, autoCheckedAt: null, autoEnabled: false });
    assert.equal(byTestId((await mount(SETTINGS_SLOT, disabled)).tree, "auto-warning"), null, "用户关了自动压缩不告警");

    const old = beta4Payload({ pressure: 0.98 });
    delete old.autoCheckedAt;
    delete old.autoEnabled;
    const oldTree = (await mount(SETTINGS_SLOT, old)).tree;
    assert.equal(byTestId(oldTree, "auto-warning"), null, "旧载荷无字段不告警");
    assert.equal(byTestId(oldTree, "auto-checked"), null, "旧载荷无字段不出提示");
});

test("D32-5 since 标注、实际用量、最近一次摘要行", async () => {
    const at = Date.UTC(2026, 9, 30, 4, 30, 0);
    const payload = beta4Payload({
        lastCompaction: { compactionId: "c1", at, shadowedTokenCount: 141000, summaryTokenCount: 2100, shadowedNodes: 37, trigger: "auto" },
    });
    const { tree } = await mount(SETTINGS_SLOT, payload);
    const pad2 = (v) => String(v).padStart(2, "0");
    const hhmm = (ms) => `${pad2(new Date(ms).getHours())}:${pad2(new Date(ms).getMinutes())}`;
    const text = collectTextOf(tree);
    assert.match(text, new RegExp(`本会话自 ${hhmm(payload.since)} 起统计`));
    assert.match(text, /131k \/ 262k tokens/);
    assert.match(
        collectTextOf(byTestId(tree, "last-compaction")),
        new RegExp(`最近一次摘要：${hhmm(at)}，自动，遮蔽 37 个节点 ≈ 141k tokens → 2\\.1k tokens`),
    );

    const hud = (await mount(OVERLAY_SLOT, payload)).tree;
    assert.match(collectTextOf(byTestId(hud, "overlay-usage")), /131k \/ 262k tokens/);
    assert.match(collectTextOf(hud), /tiered-compaction 分层压缩/, "HUD 标题走本地化 PANEL_TITLE_KEY");
});

test("D32-6 HUD 关闭 → 恢复胶囊 → 点击恢复；设置页开关同步", async () => {
    const env = loadClient();
    const Overlay = env.componentOf(OVERLAY_SLOT);
    const Settings = env.componentOf(SETTINGS_SLOT);
    env.react.render(Overlay, {});
    env.react.render(Settings, {});
    await flush();

    let hud = env.react.render(Overlay, {});
    assert.ok(byTestId(hud, "overlay-hud"));
    byTestId(hud, "overlay-close").props.onClick();

    hud = env.react.render(Overlay, {});
    assert.equal(byTestId(hud, "overlay-hud"), null, "关闭后 HUD 本体不渲染");
    const pill = byTestId(hud, "overlay-restore");
    assert.ok(pill, "关闭后必须有恢复胶囊");
    assert.match(collectTextOf(pill), /🐋/);
    assert.match(collectTextOf(pill), /50\.0%/, "胶囊带压力百分比");
    assert.equal(JSON.parse(env.storage.getItem(HUD_STATE_KEY)).closed, true, "关闭落盘");

    const toggle = byTestId(env.react.render(Settings, {}), "settings-hud-toggle");
    assert.equal(toggle.props["aria-checked"], "false", "设置页开关同步为未显示");

    pill.props.onClick();
    hud = env.react.render(Overlay, {});
    assert.ok(byTestId(hud, "overlay-hud"), "点击胶囊恢复 HUD");
    assert.equal(byTestId(env.react.render(Settings, {}), "settings-hud-toggle").props["aria-checked"], "true");

    // 设置页开关反向控制 HUD
    byTestId(env.react.render(Settings, {}), "settings-hud-toggle").props.onClick();
    assert.ok(byTestId(env.react.render(Overlay, {}), "overlay-restore"), "设置页关掉后 HUD 同步变胶囊");
});

test("D32-7 normalizeHudState 向后兼容：旧存档无 collapsed → 展开；collapsed:true → 胶囊并可展开", async () => {
    const oldState = createStorageMock({ [HUD_STATE_KEY]: JSON.stringify({ closed: false, left: 40, top: 50 }) });
    const oldTree = (await mount(OVERLAY_SLOT, beta4Payload(), { storage: oldState })).tree;
    const hud = byTestId(oldTree, "overlay-hud");
    assert.ok(hud, "旧存档按展开渲染");
    assert.equal(hud.props.style.left, "40px", "旧存档位置照常恢复");

    const collapsed = createStorageMock({ [HUD_STATE_KEY]: JSON.stringify({ closed: false, collapsed: true, left: null, top: null }) });
    const { tree, rerender, env } = await mount(OVERLAY_SLOT, beta4Payload(), { storage: collapsed });
    assert.equal(byTestId(tree, "overlay-hud"), null, "收起态不渲染完整 HUD");
    const capsule = byTestId(tree, "overlay-capsule");
    assert.ok(capsule);
    assert.match(collectTextOf(capsule), /50\.0%/);
    byTestId(tree, "overlay-expand").props.onClick();
    assert.ok(byTestId(rerender(), "overlay-hud"), "点击胶囊展开");
    assert.equal(JSON.parse(env.storage.getItem(HUD_STATE_KEY)).collapsed, false, "展开落盘");
    byTestId(rerender(), "overlay-collapse").props.onClick();
    assert.equal(JSON.parse(env.storage.getItem(HUD_STATE_KEY)).collapsed, true, "收起落盘");
});

test("D32-8 同会话压力降 ≥10 点 → 已压缩提示 + 条脉冲；计数上涨芯片高亮；换会话不提示", async () => {
    const env = loadClient();
    const windowSize = 252000;
    let current = beta4Payload({ pressure: 0.96, window: windowSize });
    env.setResponder(() => current);
    const Overlay = env.componentOf(OVERLAY_SLOT);
    env.react.render(Overlay, {});
    await flush();
    let hud = env.react.render(Overlay, {});
    assert.equal(byTestId(hud, "overlay-toast"), null, "首个快照没有对比对象");
    const chipText = collectTextOf(byTestId(hud, "overlay-chips"));
    // beta8：芯片用动作名（不再是 L1-L4），折叠与落盘合并为一项
    assert.doesNotMatch(chipText, /L[1-4]\d/);
    assert.match(chipText, /折叠\/落盘/);
    assert.match(chipText, /驱逐4/);
    assert.match(chipText, /摘要1/);

    current = beta4Payload({ pressure: 0.4, window: windowSize, layers: { l4Summaries: 2 } });
    env.tick();
    await flush();
    hud = env.react.render(Overlay, {});
    // 降幅 0.56 × 252000 = 141120 → 141k
    assert.equal(collectTextOf(byTestId(hud, "overlay-toast")), "已压缩：96% → 40%，节省 ≈ 141k tokens");
    assert.match(byTestId(hud, "pressure-fill").props.className, /bar-fill--pulse/);
    const l4 = nodeWith(hud, (node) => node.props?.["data-chip"] === "l4");
    assert.match(l4.props.className, /chip--bump/, "L4 计数上涨高亮");
    const l12 = nodeWith(hud, (node) => node.props?.["data-chip"] === "l12");
    assert.doesNotMatch(l12.props.className, /chip--bump/, "没涨的不高亮");

    // 换会话的落差不是压缩
    const other = loadClient();
    let otherPayload = beta4Payload({ pressure: 0.96, sessionId: "sess-A" });
    other.setResponder(() => otherPayload);
    const OtherOverlay = other.componentOf(OVERLAY_SLOT);
    other.react.render(OtherOverlay, {});
    await flush();
    otherPayload = beta4Payload({ pressure: 0.2, sessionId: "sess-B" });
    other.tick();
    await flush();
    assert.equal(byTestId(other.react.render(OtherOverlay, {}), "overlay-toast"), null);

    // 降幅不足 10 点不提示
    const small = loadClient();
    let smallPayload = beta4Payload({ pressure: 0.9 });
    small.setResponder(() => smallPayload);
    const SmallOverlay = small.componentOf(OVERLAY_SLOT);
    small.react.render(SmallOverlay, {});
    await flush();
    smallPayload = beta4Payload({ pressure: 0.85 });
    small.tick();
    await flush();
    assert.equal(byTestId(small.react.render(SmallOverlay, {}), "overlay-toast"), null);
});

test("D32-9 beta8 HUD：芯片带节省量，用量行带距摘要线余量，底行显示总节省与上次摘要", async () => {
    const env = loadClient();
    const current = beta4Payload({
        window: 1000000, currentTokens: 500000,
        lastCompaction: { at: Date.now() - 12 * 60000, trigger: "auto", shadowedNodes: 3, shadowedTokenCount: 1000, summaryTokenCount: 100 },
    });
    env.setResponder(() => current);
    const Overlay = env.componentOf(OVERLAY_SLOT);
    env.react.render(Overlay, {});
    await flush();
    const hud = env.react.render(Overlay, {});
    const chips = collectTextOf(byTestId(hud, "overlay-chips"));
    assert.match(chips, /驱逐4省 66\.1k/);
    assert.match(chips, /摘要1省 120k/);
    // 82% × 1M − 500k = 320k
    assert.match(collectTextOf(byTestId(hud, "overlay-usage")), /tokens距摘要 ≈ 320k/);
    assert.equal(collectTextOf(byTestId(hud, "overlay-footer")), "共省 ≈ 206k · 上次摘要 12 分钟前");
});
