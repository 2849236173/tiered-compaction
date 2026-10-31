/**
 * 任务 #2 验收：client 半骨架与三入口注册（方案 §五 #2）。
 *
 * 仓库没有浏览器环境，按官方技能文档的建议用 mock 验证：
 *   1. `window.__ModuleLoader__.load({id, factory})` 被调用且 id=包名；
 *   2. factory(require('react')) 返回 { name, inject, apply } 插件形状；
 *   3. apply 经 slots.inject 惯例外包装挂四个注册，props 契约满足
 *      SlotCore 校验语义：settings.section（list，id+order）、main（keyed，
 *      key）、sidebar.panellist（list，id=main 的 key 同字符串）、
 *      shell.overlay（list，自带 id+label thunk）；
 *   4. 组件按 surface 分支：overlay 固定角落占位，settings/sidebar 标题卡；
 *   5. fetch 走 new URL(path, document.baseURI).pathname（非整 URL）；
 *   6. fetch 失败/非 200/形状不对时组件渲染「数据不可用」，不空白——
 *      这是 #9 反向验证的地基。
 *
 * 运行：node --test test/d23-client-skeleton.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");

/** 与 host 半 src/status-route.js 的 STATUS_ROUTE_PATH 保持同字符串。 */
const STATUS_ROUTE_PATH = "/api/tiered-compaction/status";
const PACKAGE_NAME = "dsh-tiered-compaction";
const FAKE_BASE_URI = "http://127.0.0.1:16271/chat?session=abc";

/** 带全部 7+3 字段的假快照（形状与 d23-status-route 的契约一致）。 */
const FAKE_SNAPSHOT = {
    status: "ok",
    pressure: 0.27,
    window: 1000000,
    layers: {
        l12Processed: 107, l12Replaced: 94, l12Failed: 0, l12Skipped: 13,
        l12BytesSaved: 2200000, l3Evicted: 0, spillCount: 29, lineageEntries: 21,
    },
    lastCompaction: { compactionId: "c-1", at: "2026-10-29T10:00:00.000Z", shadowedTokenCount: 940000, startSeq: 2476, endSeq: 2500 },
    archiveDir: "C:\\tmp\\tiered-archive",
    since: "2026-10-29T08:00:00.000Z",
    currentTokens: 270000,
    problems: [],
    sessionId: "s-1",
};

/**
 * mock react：createElement 收集 vnode 树；useState 的当前值挂在
 * react.pendingSnapshot 上（null=初始态），测试可直接改它模拟取数完成；
 * useEffect 暂存 effect 供测试手动驱动。
 */
function createMockReact() {
    const react = {
        pendingSnapshot: null,
        createElement(type, props, ...children) {
            return { type, props: props ?? {}, children };
        },
        useState(initial) {
            return [react.pendingSnapshot ?? initial, (value) => { react.pendingSnapshot = value; }];
        },
        useEffect(effect) {
            react.pendingEffect = effect;
            return () => {};
        },
    };
    return react;
}

/** 在 vm 沙箱里执行 client.js，捕获 load 规格，用 mock react 求值 factory。 */
function loadClientModule(react) {
    let loadedSpec = null;
    const sandbox = {
        window: { __ModuleLoader__: { load(spec) { loadedSpec = spec; } } },
        document: { baseURI: FAKE_BASE_URI },
        // 浏览器全局按需补：骨架代码只用 URL 与 fetch
        URL,
        fetch: undefined,
    };
    vm.createContext(sandbox);
    vm.runInContext(CLIENT_SOURCE, sandbox, { filename: "client/client.js" });

    assert.ok(loadedSpec, "client.js 必须调用 window.__ModuleLoader__.load");
    assert.equal(loadedSpec.id, PACKAGE_NAME, "load 的 id 必须等于包名");
    const plugin = loadedSpec.factory((spec) => {
        assert.equal(spec, "react", "骨架阶段只应 require('react')");
        return react;
    });
    return { plugin, sandbox };
}

/** mock slots：记录 inject 声明并立即执行回调（宿主在 slot 声明后跑回调，mock 直跑等价）。 */
function applyModule(plugin) {
    const slots = {
        injections: [],
        registrations: [],
        inject(slotName, callback) {
            slots.injections.push(slotName);
            callback();
        },
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

/** 递归收集 vnode 树里的文本。 */
function collectTextOf(node) {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(collectTextOf).join("");
    if (node !== null && typeof node === "object" && Array.isArray(node.children)) {
        return collectTextOf(node.children);
    }
    return "";
}

/** 取入口的内层元素（type=StatusPanel，props={surface}），不渲染。 */
function surfaceElementOf(slots, slotName) {
    const entry = slots.registrationOf(slotName);
    assert.ok(entry, `槽位 ${slotName} 必须已注册`);
    const element = entry.component({});
    assert.equal(typeof element.type, "function", "注册的必须是组件");
    return element;
}

/** 完整渲染一遍入口：包装组件忽略 ownerProps、内部显式传 surface，直接驱动内层组件。 */
function surfaceTreeOf(slots, slotName) {
    const element = surfaceElementOf(slots, slotName);
    return element.type(element.props);
}

/** 完整流程：注册→渲染（捕获 effect）→跑 effect→flush 微任务→再渲染，返回最终文本与请求记录。 */
async function renderedTextWithFetch({ fetchMock, slotName }) {
    const react = createMockReact();
    const { plugin, sandbox } = loadClientModule(react);
    const slots = applyModule(plugin);
    const requested = [];
    sandbox.fetch = async (input) => {
        requested.push(String(input));
        return fetchMock();
    };

    const element = surfaceElementOf(slots, slotName);
    element.type(element.props);
    await react.pendingEffect();
    await new Promise((resolve) => setImmediate(resolve));
    return { text: collectTextOf(element.type(element.props)), requested };
}

test("D23C-1 load 以包名注册，factory 返回插件形状（inject/apply）", () => {
    const react = createMockReact();
    const { plugin } = loadClientModule(react);
    // vm 跨 realm 数组原型不同，展开到本域再比较
    assert.deepEqual([...plugin.inject], ["slots"]);
    assert.equal(typeof plugin.apply, "function");
});

test("D23C-2 apply 只挂设置页和低干扰悬浮入口", () => {
    const react = createMockReact();
    const { plugin } = loadClientModule(react);
    const slots = applyModule(plugin);

    assert.deepEqual(
        [...slots.injections].sort(),
        ["settings.section", "shell.overlay"].sort(),
    );
    assert.equal(slots.registrations.length, 2);
});

test("D23C-3 注册 props 契约：list 带 id、label 是 thunk，不再注册侧栏", () => {
    const react = createMockReact();
    const { plugin } = loadClientModule(react);
    const slots = applyModule(plugin);

    const settings = slots.registrationOf("settings.section");
    assert.equal(settings.options.id, "tiered-compaction");
    assert.equal(typeof settings.options.order, "number");
    assert.equal(typeof settings.options.label, "function");
    assert.equal(typeof settings.options.label(), "string", "label thunk 必须可求值");

    assert.equal(slots.registrationOf("main"), undefined, "两入口收敛：不再注册 main");
    assert.equal(slots.registrationOf("sidebar.panellist"), undefined, "两入口收敛：不再注册 panellist");

    const overlay = slots.registrationOf("shell.overlay");
    assert.equal(overlay.options.id, "tiered-compaction-hud");
    assert.equal(typeof overlay.options.label, "function");
    assert.equal(typeof overlay.options.label(), "string");
});

test("D23C-4 组件按 surface 分支：overlay 固定角落定位，设置页不预设定位", () => {
    const react = createMockReact();
    const { plugin } = loadClientModule(react);
    const slots = applyModule(plugin);

    const settingsTree = surfaceTreeOf(slots, "settings.section");
    assert.equal(settingsTree.props["data-surface"], "settings");
    assert.equal(settingsTree.props.style.position, undefined, "设置页不能使用 fixed 定位");
    assert.equal(typeof settingsTree.props.style["--dsh-tiered-tone"], "string", "设置页应提供主题色变量");

    const overlayTree = surfaceTreeOf(slots, "shell.overlay");
    assert.equal(overlayTree.props["data-surface"], "overlay");
    assert.equal(overlayTree.props.style.position, "fixed", "overlay 使用固定定位");
});

test("D23C-5 初始态渲染标题 + 状态文本，不是空白", () => {
    const react = createMockReact();
    const { plugin } = loadClientModule(react);
    const slots = applyModule(plugin);

    const settingsTree = surfaceTreeOf(slots, "settings.section");
    assert.match(collectTextOf(settingsTree), /tiered-compaction 分层压缩/);
    assert.match(collectTextOf(settingsTree), /读取中/);
});

test("D23C-6 fetch 只请求 pathname（不带 origin/query），成功后显示 status/pressure", async () => {
    const { text, requested } = await renderedTextWithFetch({
        slotName: "settings.section",
        fetchMock: () => ({ ok: true, json: async () => FAKE_SNAPSHOT }),
    });
    assert.deepEqual(requested, [STATUS_ROUTE_PATH], "必须只取 pathname，不带 baseURI 的 origin/query");
    assert.match(text, /ok/);
    assert.match(text, /27\.0%/);
});

test("D23C-7 fetch 非 200 → 「数据不可用」占位", async () => {
    const { text } = await renderedTextWithFetch({
        slotName: "settings.section",
        fetchMock: () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) }),
    });
    assert.match(text, /数据不可用/);
});

test("D23C-8 fetch 网络失败 → 「数据不可用」占位", async () => {
    const { text } = await renderedTextWithFetch({
        slotName: "settings.section",
        fetchMock: () => {
            throw new Error("network down");
        },
    });
    assert.match(text, /数据不可用/);
});

test("D23C-9 响应形状不对（缺 status/pressure）→ 「数据不可用」占位", async () => {
    const { text } = await renderedTextWithFetch({
        slotName: "settings.section",
        fetchMock: () => ({ ok: true, json: async () => ({ status: "ok" }) }),
    });
    assert.match(text, /数据不可用/);
});
