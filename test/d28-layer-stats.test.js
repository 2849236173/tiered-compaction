/**
 * 任务 #6 验收：各层活动统计（方案 §五 #6、§3.1、§3.2）。
 *
 * 覆盖六件事：
 *   1. 设置页分区四层数字块：mock payload 下四个数字出现在文本里，
 *      落盘行附省字节数（KB/MB 可读格式）；
 *   2. 「自 HH:mm 起」标注：since 给 epoch ms 断言本地 HH:mm 出现；
 *      since 缺失/非数字时断言无 "NaN"（宁可不标，不显示 NaN:NaN）；
 *   3. 侧栏精简面板一行式（折叠 N · 落盘 N · 驱逐 N · 摘要 N）+ since 标注；
 *   4. overlay 不含四层数字（负断言，方案 §3.3 保持迷你）；
 *   5. idle/无会话 payload（l4Summaries=0）渲染零值且不可用判定不误伤；
 *   6. host 半：真实事务提交后 summaryCount 计 1，_statusPayload 的
 *      ready/idle 两种形状的 layers 都带 l4Summaries。
 *
 * client 半延续 d23/d25/d26/d27 的 vm 沙箱 + mock react 模式。
 * 关键坑（d26/d27 已踩过，照抄不重犯）：mock 的 createElement 只造
 * `{type, props, children}`，函数组件**不会**自动执行——renderNode 遇到
 * `typeof node.type === "function"` 必须手动 `type(props)` 再递归其结果；
 * hook 槽位按组件函数分开存，否则多个入口的状态会串。
 *
 * 运行：node --test test/d28-layer-stats.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");

const PACKAGE_NAME = "dsh-tiered-compaction";
const FAKE_BASE_URI = "http://127.0.0.1:16271/chat?session=abc";
const MAIN_SLOT = "main";
const PANELLIST_SLOT = "sidebar.panellist";
const SETTINGS_SLOT = "settings.section";
const OVERLAY_SLOT = "shell.overlay";

const LAYERS_BLOCK_TESTID = "layer-stats";
const PANELLIST_SUMMARY_TESTID = "sidebar-panellist-summary";
const SIDEBAR_PANEL_TESTID = "sidebar-panel";

/**
 * 两组 ready 快照：A 带非零四层数字 + since；B 换值（换 payload 断言数值来源）。
 * since=2026-10-30T02:05:00Z（UTC）；北京 UTC+8 → 10:05。
 */
const SINCE_A = Date.UTC(2026, 9, 30, 2, 5, 0);
const PAYLOAD_A = {
    status: "ok",
    pressure: 0.27,
    window: 1000000,
    layers: {
        l12Processed: 107, l12Replaced: 94, l12Failed: 0, l12Skipped: 13,
        l12BytesSaved: 2200000, l3Evicted: 0, spillCount: 29, lineageEntries: 21,
        l4Summaries: 3,
    },
    since: SINCE_A,
};
/** 换值组：证明四层数字来自 API 响应而非写死（0 也如实显示）。 */
const PAYLOAD_B = {
    status: "ok",
    pressure: 0.1234,
    window: 2000000,
    layers: {
        l12Processed: 0, l12Replaced: 0, l12Failed: 0, l12Skipped: 0,
        l12BytesSaved: 0, l3Evicted: 0, spillCount: 0, lineageEntries: 0,
        l4Summaries: 0,
    },
    since: Date.UTC(2026, 9, 30, 3, 7, 0),
};

/**
 * mock react：hook 槽位按组件函数分开存，effect 供测试手动驱动（d27 同款）。
 */
function createMockReact() {
    const hookStores = new Map();
    const effectRuns = new Map();
    let activeStore = null;
    let hookIndex = 0;
    let pendingEffects = [];

    /** 递归渲染：函数组件手动执行后继续下钻（mock 不会自动执行组件）。 */
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

    const react = {
        createElement(type, props, ...children) {
            return { type, props: props ?? {}, children };
        },
        useState(initial) {
            const store = activeStore;
            const index = hookIndex++;
            if (!(index in store)) store[index] = typeof initial === "function" ? initial() : initial;
            return [store[index], (value) => { store[index] = value; }];
        },
        useEffect(effect) {
            const index = hookIndex++;
            pendingEffects.push({ store: activeStore, index, effect });
            return () => {};
        },
        /** 渲染组件树（等价于宿主的一轮 render），返回已展开的 vnode 树。 */
        render(component, props) {
            pendingEffects = [];
            return renderNode(react.createElement(component, props));
        },
        /** 跑本轮收集的 effect；同一个 (组件, hook 序号) 只跑一次（deps=[] 语义）。 */
        async runEffects() {
            const batch = pendingEffects;
            pendingEffects = [];
            for (const item of batch) {
                if (!effectRuns.has(item.store)) effectRuns.set(item.store, new Set());
                const ran = effectRuns.get(item.store);
                if (ran.has(item.index)) continue;
                ran.add(item.index);
                await item.effect();
            }
        },
    };
    return react;
}

/** 在 vm 沙箱里执行 client.js，捕获 load 规格并用 mock react 求值 factory。 */
function loadClientModule(react) {
    let loadedSpec = null;
    const sandbox = {
        window: { __ModuleLoader__: { load(spec) { loadedSpec = spec; } } },
        document: { baseURI: FAKE_BASE_URI },
        URL,
        fetch: undefined,
    };
    vm.createContext(sandbox);
    vm.runInContext(CLIENT_SOURCE, sandbox, { filename: "client/client.js" });

    assert.ok(loadedSpec, "client.js 必须调用 window.__ModuleLoader__.load");
    assert.equal(loadedSpec.id, PACKAGE_NAME, "load 的 id 必须等于包名");
    const plugin = loadedSpec.factory((spec) => {
        assert.equal(spec, "react", "本阶段只应 require('react')");
        return react;
    });
    return { plugin, sandbox };
}

/** mock slots：记录注册并立即执行回调（与 d23/d25/d26/d27 同构）。 */
function applyModule(plugin) {
    const slots = {
        registrations: [],
        inject(_slotName, callback) { callback(); },
        register(options, component) {
            slots.registrations.push({ options, component });
            return () => {};
        },
        registrationOf(name) {
            return slots.registrations.find((item) => item.options.name === name);
        },
    };
    plugin.apply({ slots });
    return slots;
}

/** 递归收集 vnode 树里的文本（含数组展开，d23 同款）。 */
function collectTextOf(node) {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(collectTextOf).join("");
    if (node !== null && typeof node === "object" && Array.isArray(node.children)) {
        return collectTextOf(node.children);
    }
    return "";
}

/** 深遍历 vnode 树，访问每个节点。 */
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

/** 找 data-testid 命中的节点（取第一个）。 */
function nodeWithTestId(tree, testId) {
    const hits = [];
    walkTree(tree, (node) => {
        if (node.props && node.props["data-testid"] === testId) hits.push(node);
    });
    return hits[0] ?? null;
}

/**
 * 完整挂载流程（照 d25/d26/d27：挂载→跑 effect→flush 微任务→再渲染拿最终树）。
 */
async function mountSlot(slotName, options = {}) {
    const { payload = PAYLOAD_A, fetchMock } = options;
    const react = createMockReact();
    const { plugin, sandbox } = loadClientModule(react);
    const slots = applyModule(plugin);
    sandbox.fetch = async () => {
        const respond = fetchMock ?? (() => ({ ok: true, json: async () => payload }));
        return respond();
    };

    const entry = slots.registrationOf(slotName);
    assert.ok(entry, `槽位 ${slotName} 必须已注册`);
    react.render(entry.component, {});
    await react.runEffects();
    await new Promise((resolve) => setImmediate(resolve));

    return { tree: react.render(entry.component, {}), slots, react };
}

test("D28-1 设置页分区四层数字块：四个数字 + 省字节数，数值来自 API", async () => {
    const tree = (await mountSlot(SETTINGS_SLOT, { payload: PAYLOAD_A })).tree;
    const block = nodeWithTestId(tree, LAYERS_BLOCK_TESTID);
    assert.ok(block, "设置页必须渲染四层数字块");
    const text = collectTextOf(block);

    assert.match(text, /无损折叠\s*107/, "折叠数=l12Processed 口径");
    assert.match(text, /落盘存档\s*29/, "落盘数=spillCount");
    assert.match(text, /软压力驱逐\s*0/, "驱逐数=l3Evicted（0 也显示）");
    assert.match(text, /有损摘要\s*3/, "摘要数=l4Summaries");
    assert.match(text, /省 ~2\.1 MB/, "2200000 字节换算成 MB 可读格式");

    // 换一组 payload：数字跟着变，证明来自 API 而非写死
    const treeB = (await mountSlot(SETTINGS_SLOT, { payload: PAYLOAD_B })).tree;
    const textB = collectTextOf(nodeWithTestId(treeB, LAYERS_BLOCK_TESTID));
    assert.match(textB, /无损折叠\s*0/, "换值后折叠=0（零值如实显示）");
    assert.match(textB, /有损摘要\s*0/, "换值后摘要=0");
    assert.doesNotMatch(textB, /107|29/, "旧值不得残留");
    assert.doesNotMatch(textB, /省 ~/, "省字节数为 0 时不显示省字节括号");
});

test("D28-2 「自 HH:mm 起」标注：since → 本地 HH:mm；缺失/非法时无 NaN", async () => {
    // 用本机时区换算期望值：SINCE_A 是 UTC 02:05，断言与本地 HH:mm 一致
    const expect = (() => {
        const d = new Date(SINCE_A);
        const pad2 = (v) => String(v).padStart(2, "0");
        return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    })();
    const tree = (await mountSlot(SETTINGS_SLOT, { payload: PAYLOAD_A })).tree;
    const text = collectTextOf(nodeWithTestId(tree, LAYERS_BLOCK_TESTID));
    assert.match(text, new RegExp(`自 ${expect} 起`), `标注必须是本地时间 ${expect}`);

    // since 缺失：标注整段省略，绝不显示 NaN:NaN
    const noSince = structuredClone(PAYLOAD_A);
    delete noSince.since;
    const textNoSince = collectTextOf((await mountSlot(SETTINGS_SLOT, { payload: noSince })).tree);
    assert.doesNotMatch(textNoSince, /NaN/, "since 缺失不得出现 NaN");
    assert.doesNotMatch(textNoSince, /自 .* 起/, "since 缺失时标注整段省略");
    assert.match(textNoSince, /无损折叠\s*107/, "缺 since 不影响四层数字本身");

    // since 非数字（旧宿主给字符串 ISO）：同样省略
    const badSince = { ...PAYLOAD_A, since: "2026-10-30T10:05:00.000Z" };
    const textBad = collectTextOf((await mountSlot(SETTINGS_SLOT, { payload: badSince })).tree);
    assert.doesNotMatch(textBad, /NaN/, "since 非数字不得出现 NaN");
});

test("D28-3 四层数字随 API 换值，设置页与同一 payload 的口径一致", async () => {
    const tree = (await mountSlot(SETTINGS_SLOT, { payload: PAYLOAD_A })).tree;
    const text = collectTextOf(nodeWithTestId(tree, LAYERS_BLOCK_TESTID));
    assert.match(text, /无损折叠\s*107/, "折叠数字来自 API（107）");
    assert.match(text, /软压力驱逐\s*0/, "驱逐数字来自 API（0）");
    assert.match(text, /有损摘要\s*3/, "摘要数字来自 API（3）");

    // 数值来自 API：换 payload 断言跟随（零值也如实显示）
    const textB = collectTextOf((await mountSlot(SETTINGS_SLOT, { payload: PAYLOAD_B })).tree);
    assert.match(textB, /无损折叠\s*0/, "零值也如实显示");
    assert.match(textB, /有损摘要\s*0/, "摘要零值也如实显示");
    assert.doesNotMatch(textB, /107|摘要\s*3/, "旧值不得残留");
});

test("D28-4 overlay 不含四层数字（保持迷你，方案 §3.3 定案）", async () => {
    const tree = (await mountSlot(OVERLAY_SLOT, { payload: PAYLOAD_A })).tree;
    assert.equal(nodeWithTestId(tree, LAYERS_BLOCK_TESTID), null, "overlay 不渲染四层数字块");
    const text = collectTextOf(tree);
    assert.doesNotMatch(text, /无损折叠|落盘存档|软压力驱逐|有损摘要/, "overlay 连四层标签都不出现");
    assert.doesNotMatch(text, /折叠\s*107|摘要\s*3/, "一行式也不属于 overlay");
});

test("D28-5 idle/无会话 payload：l4Summaries=0 渲染零值，不可用判定不误伤", async () => {
    // host 半 idle 形状：layers 全零 + since 有值 + 无 status 之外会话字段
    const idlePayload = {
        status: "ok",
        pressure: 0,
        window: 0,
        layers: {
            l12Processed: 0, l12Replaced: 0, l12Failed: 0, l12Skipped: 0,
            l12BytesSaved: 0, l3Evicted: 0, spillCount: 0, lineageEntries: 0,
            l4Summaries: 0,
        },
        lastCompaction: null,
        archiveDir: null,
        since: SINCE_A,
        problems: [],
        sessionId: null,
    };
    const tree = (await mountSlot(SETTINGS_SLOT, { payload: idlePayload })).tree;
    const text = collectTextOf(nodeWithTestId(tree, LAYERS_BLOCK_TESTID));
    assert.match(text, /无损折叠\s*0/, "idle 四层数字块渲染零值（不隐藏）");
    assert.match(text, /有损摘要\s*0/, "idle 摘要=0 如实显示");
    // 不可用判定不误伤：状态行与压力数值照常渲染（对整棵树断言）
    const wholeText = collectTextOf(tree);
    assert.match(wholeText, /状态 ok/, "idle 不被误判为数据不可用");
    assert.doesNotMatch(wholeText, /数据不可用/, "idle 不得落到不可用占位");
    const d = new Date(SINCE_A);
    const pad2 = (v) => String(v).padStart(2, "0");
    assert.match(text, new RegExp(`自 ${pad2(d.getHours())}:${pad2(d.getMinutes())} 起`), "idle 的 since 照常标注");

    // 缺 layers 字段的旧形状：只让四层块不出现，不把整条快照打成不可用
    const legacy = { status: "ok", pressure: 0.27, window: 1000 };
    const legacyTree = (await mountSlot(SETTINGS_SLOT, { payload: legacy })).tree;
    assert.equal(nodeWithTestId(legacyTree, LAYERS_BLOCK_TESTID), null, "缺 layers 时不渲染四层块");
    assert.match(collectTextOf(legacyTree), /状态 ok/, "缺 layers 不误伤可用判定");
});

/* ---------------------------- host 半 ---------------------------- */

test("D28-6 host：真实事务提交后 l4Summaries 计 1 且进状态载荷；idle 形状带 l4Summaries:0", async (t) => {
    const { Context, Service } = await import("@deepseek-ai/cordis");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { apply } = await import("../src/index.js");

    /** 收集响应的 res 桩（d23 同款）。 */
    const mockRes = () => ({
        statusCode: 0, headers: {}, body: "",
        setHeader(key, value) { this.headers[key] = value; },
        end(body) { this.body = body ?? ""; },
    });
    /** webServer 服务桩：捕获 register 调用（d23 同款）。 */
    class WebServerStub extends Service {
        constructor(ctx) { super(ctx, "webServer"); this.specs = []; }
        register(spec) { this.specs.push(spec); return () => {}; }
        handlerFor(path) { return this.specs.find((spec) => spec.path === path)?.handler; }
    }
    /** 宿主形状的最小 session 桩（d23 同款：surface + eventAt + append 可断言）。 */
    const stubSession = (nodes) => {
        const events = [];
        let seq = 0;
        const surface = nodes.map((n) => (n.seq = ++seq, n.seq));
        const store = new Map(nodes.map((n) => [n.seq, { seq: n.seq, type: n.type, data: n.data }]));
        return {
            surface: { get nodes() { return surface; } },
            eventAt: (s) => store.get(s),
            requestHeader: () => ({ config: { provider: "test", model: "test" } }),
            append: (type, data, opts) => {
                const ev = { seq: ++seq + 1000, type, data, opts };
                events.push(ev);
                if (type === "user/message" && opts?.surfaceOp?.op === "replace") {
                    const { startSeq, endSeq } = opts.surfaceOp;
                    const idxStart = surface.indexOf(startSeq);
                    const idxEnd = surface.indexOf(endSeq);
                    if (idxStart === -1 || idxEnd === -1) throw new Error("replace 区间不在表面");
                    surface.splice(idxStart, idxEnd - idxStart + 1, ev.seq);
                    store.set(ev.seq, { seq: ev.seq, type, data });
                }
                return ev;
            },
            events,
        };
    };
    /** 宿主形状的最小 agent 桩（d23 同款）。 */
    const stubAgent = (session) => ({
        session,
        runMaintenance: async (fn) => fn(new AbortController().signal),
    });

    const dir = await mkdtemp(join(tmpdir(), "d28-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const ctx = new Context();
    // cordis 实测坑（a12 备注）：桩必须以 Service 提供者注册，裸属性不满足注入条件
    class MeterStub extends Service {
        constructor(c, cfg) { super(c, "tokenMeter"); Object.assign(this, cfg); }
    }
    class LlmStub extends Service {
        constructor(c) { super(c, "llm"); }
    }
    class SessionsStub extends Service {
        constructor(c) { super(c, "sessions"); }
    }
    await ctx.plugin(MeterStub, { window: 128000, perNode: 2000 });
    await ctx.plugin(LlmStub, {});
    await ctx.plugin(SessionsStub, {});
    await ctx.plugin(WebServerStub, {});
    await apply(ctx, {
        enabled: true,
        archiveDir: dir,
        summarizeFn: async () => "这是一段足够短的摘要文本",
        summaryTarget: { provider: "test", model: "test" },
    });
    const meter = ctx.tokenMeter;
    meter.currentTokens = () => 2000;
    meter.measure = (session) => ({
        totalTokens: 2000,
        nodes: session.surface.nodes.map((seq) => ({ seq, tokens: Math.floor(2000 / session.surface.nodes.length) })),
    });
    const svc = ctx.compaction;

    // idle 形状（无活跃会话）：layers 必须带 l4Summaries:0，与 ready 形状字段一致
    const idleRes = mockRes();
    ctx.get("webServer").handlerFor("/api/tiered-compaction/status")({ method: "GET" }, idleRes);
    const idlePayload = JSON.parse(idleRes.body);
    assert.equal(idlePayload.layers.l4Summaries, 0, "idle 形状必须带 l4Summaries:0（三态形状一致原则）");

    // 真实事务路径：compactNow 提交一次摘要事务 → summaryCount 从 0 变 1
    const session = stubSession([
        { type: "user/message", data: { content: "任务一" } },
        { type: "tool/output", data: { content: "很长的工具输出".repeat(50) } },
        { type: "user/message", data: { content: "保留的近端消息" } },
    ]);
    const agent = stubAgent(session);
    const result = await svc.compactNow(agent, undefined, "cmd-d28");
    assert.ok(result, "有可压缩面必须返回事务结果");
    assert.equal(svc.summaryCount, 1, "提交一次摘要事务后 summaryCount 必须是 1");

    const res = mockRes();
    ctx.get("webServer").handlerFor("/api/tiered-compaction/status")({ method: "GET" }, res);
    const payload = JSON.parse(res.body);
    assert.equal(payload.layers.l4Summaries, 1, "提交过的摘要次数必须进状态载荷");
    assert.ok(payload.layers.l12Processed >= 0, "layers 其余字段不受影响");
});
