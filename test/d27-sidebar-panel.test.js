/**
 * 任务 #5 验收：侧栏面板成型——图标 + 点击后的精简状态
 * （方案 §五 #5、§六 6.1「侧栏面板：图标可见，点击显示精简状态」）。
 *
 * 延续 d23/d25/d26 的 vm 沙箱 + mock react 模式，本文件聚焦：
 *   1. 注册结构没被 #5 改坏：三入口四注册仍在，panellist 的 id 仍等于 main 的
 *      key（DesktopLayoutState 按 key 匹配面板，改错就点了图标找不到面板）；
 *   2. 图标行（sidebar.panellist）与主面板（main）是**两个组件**：前者只有
 *      「图标 + 一行摘要」，后者才是侧栏面板；
 *   3. ready 态摘要三要素：状态字 + 压力百分比 + 窗口，且数值随 API 变——
 *      与设置页入口同一组数字（同源，不另算一套）；
 *   4. loading 态不出假数字、unavailable 态说「数据不可用」，都不是空白；
 *   5. 精简性可证：图标行不渲染压力条、不渲染刻度线图例、没有多段结构；
 *      main 也不渲染设置页专有的图例（方案 §3.2 侧栏版没有图例行）。
 *
 * 关键坑（d26 已踩过，照抄不重犯）：mock 的 createElement 只造
 * `{type, props, children}`，函数组件**不会**自动执行——renderNode 遇到
 * `typeof node.type === "function"` 必须手动 `type(props)` 再递归其结果；
 * hook 槽位按组件函数分开存，否则 main 与 panellist 的状态会串。
 *
 * 运行：node --test test/d27-sidebar-panel.test.js
 */
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
/** 方案 §2.2：main 的 key 与 panellist 的 id 必须同字符串（对外契约，测试钉住）。 */
const PANEL_KEY = "tiered-compaction";

const PANELLIST_TESTID = "sidebar-panellist";
const PANELLIST_ICON_TESTID = "sidebar-panellist-icon";
const PANELLIST_SUMMARY_TESTID = "sidebar-panellist-summary";
const SIDEBAR_PANEL_TESTID = "sidebar-panel";
const PRESSURE_BAR_TESTID = "pressure-bar";

/** 两组 ready 快照：换值断言用，证明摘要里的数字来自 API 响应而非写死。 */
const PAYLOAD_A = { status: "ok", pressure: 0.27, window: 1000000 };
const PAYLOAD_B = { status: "ok", pressure: 0.1234, window: 2000000 };
/** 压缩进行中：host 半当前只产出 ok/warn，这里锁住状态字表的映射。 */
const PAYLOAD_COMPACTING = { status: "compacting", pressure: 0.81, window: 500000 };
/** 表里没有的状态：必须原样透出，不做二次发明。 */
const PAYLOAD_FROZEN = { status: "frozen", pressure: 0.5, window: 4000 };

/**
 * mock react：hook 槽位按组件函数分开存，effect 供测试手动驱动（d26 同款）。
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

/** mock slots：记录注册并立即执行回调（与 d23/d25/d26 同构）。 */
function applyModule(plugin) {
    const slots = {
        registrations: [],
        injections: [],
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

/** 按 data-testid 计数（证明「不该出现的东西一个都没有」）。 */
function countTestId(tree, testId) {
    let count = 0;
    walkTree(tree, (node) => {
        if (node.props && node.props["data-testid"] === testId) count += 1;
    });
    return count;
}

/** 收集带刻度线语义 title 的节点（提醒线/驱逐线/摘要线）。 */
function markNodesOf(tree) {
    const hits = [];
    walkTree(tree, (node) => {
        if (typeof node.props?.title === "string" && /提醒线|驱逐线|摘要线/.test(node.props.title)) hits.push(node);
    });
    return hits;
}

/**
 * 完整挂载流程（照 d25/d26：挂载→跑 effect→flush 微任务→再渲染拿最终树）。
 * 返回最终树，以及再渲一次的函数。
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

test("D27-1 注册结构未被破坏：三入口四注册，panellist 的 id 仍是 main 的 key", () => {
    const react = createMockReact();
    const { plugin } = loadClientModule(react);
    const slots = applyModule(plugin);

    assert.deepEqual(
        [...slots.injections].sort(),
        ["main", "settings.section", "shell.overlay", "sidebar.panellist"].sort(),
        "侧栏是双注册，三入口共四注册",
    );
    assert.equal(slots.registrations.length, 4);

    const main = slots.registrationOf(MAIN_SLOT);
    const panellist = slots.registrationOf(PANELLIST_SLOT);
    assert.equal(main.options.key, PANEL_KEY, "main 仍是 keyed 注册，key 未变");
    assert.equal(panellist.options.id, PANEL_KEY, "panellist id 必须与 main key 同字符串");
    assert.equal(panellist.options.id, main.options.key);
    assert.equal(typeof panellist.options.order, "number", "图标行按 order 排序");
    assert.equal(typeof panellist.options.label, "function", "label 必须是 thunk");
    assert.equal(typeof panellist.options.label(), "string", "label thunk 必须可求值");
    assert.equal(main.options.id, undefined, "main 是 keyed 槽位，不该带 id");
});

test("D27-2 图标行与主面板是两个不同组件：同一份数据下渲染面也不同", async () => {
    const react = createMockReact();
    const { plugin } = loadClientModule(react);
    const slots = applyModule(plugin);

    const mainComponent = slots.registrationOf(MAIN_SLOT).component;
    const panellistComponent = slots.registrationOf(PANELLIST_SLOT).component;
    assert.notEqual(panellistComponent, mainComponent, "#5 的核心：图标行不再等同主面板");
    assert.equal(typeof panellistComponent, "function");
    assert.equal(typeof mainComponent, "function");

    const panellistTree = (await mountSlot(PANELLIST_SLOT)).tree;
    const mainTree = (await mountSlot(MAIN_SLOT)).tree;

    const panellistRow = nodeWithTestId(panellistTree, PANELLIST_TESTID);
    assert.ok(panellistRow, "sidebar.panellist 必须渲染图标行");
    assert.equal(panellistRow.props["data-surface"], "sidebar-panellist", "图标行有自己的渲染面");
    assert.equal(countTestId(panellistTree, PRESSURE_BAR_TESTID), 0, "图标行不渲染压力条");
    assert.equal(countTestId(panellistTree, SIDEBAR_PANEL_TESTID), 0, "图标行不是主面板");

    const mainPanel = nodeWithTestId(mainTree, SIDEBAR_PANEL_TESTID);
    assert.ok(mainPanel, "main 仍是侧栏面板");
    assert.equal(mainPanel.props["data-surface"], "sidebar", "main 的 surface 契约不变（d23 已钉）");
    assert.equal(mainPanel.props.style, undefined, "侧栏面板不预设定位样式");
    assert.equal(countTestId(mainTree, PRESSURE_BAR_TESTID), 1, "侧栏面板仍保留压力条");
    assert.equal(countTestId(mainTree, PANELLIST_TESTID), 0, "主面板里不该套图标行");
});

test("D27-3 ready 态：图标 + 状态字 + 压力百分比 + 窗口，数值来自 API", async () => {
    const { tree } = await mountSlot(PANELLIST_SLOT, { payload: PAYLOAD_A });

    const icon = nodeWithTestId(tree, PANELLIST_ICON_TESTID);
    assert.ok(icon, "验收「图标可见」：图标节点必须存在");
    assert.equal(typeof collectTextOf(icon), "string");
    assert.ok(collectTextOf(icon).trim().length > 0, "图标不能是空文本");

    const summary = collectTextOf(nodeWithTestId(tree, PANELLIST_SUMMARY_TESTID));
    assert.match(summary, /状态 ok/, "状态字来自 API 的 status 字段");
    assert.match(summary, /27\.0%/, "压力百分比来自 API（0.27 → 27.0%）");
    assert.match(summary, /1000000/, "窗口大小来自 API 的 window 字段");

    // 三个可读字段在同一行：没有换行符，就是「一行摘要」
    assert.doesNotMatch(summary, /\n/, "精简态是一行摘要，不该是多段结构");
});

test("D27-4 换一组 API 数值：摘要跟着变，且与设置页数字一致（同源）", async () => {
    const treeA = await mountSlot(PANELLIST_SLOT, { payload: PAYLOAD_A }).then((h) => h.tree);
    const summaryA = collectTextOf(nodeWithTestId(treeA, PANELLIST_SUMMARY_TESTID));
    assert.match(summaryA, /27\.0%/);
    assert.match(summaryA, /1000000/);

    const treeB = await mountSlot(PANELLIST_SLOT, { payload: PAYLOAD_B }).then((h) => h.tree);
    const summaryB = collectTextOf(nodeWithTestId(treeB, PANELLIST_SUMMARY_TESTID));
    assert.match(summaryB, /12\.3%/, "payload 换成 0.1234 后摘要必须是 12.3%");
    assert.match(summaryB, /2000000/, "窗口跟着 API 变");
    assert.doesNotMatch(summaryB, /27\.0%/, "旧值不得残留");

    // 同源核对：设置页入口对同一个 payload 得出同一个数值文本
    const settingsText = collectTextOf((await mountSlot(SETTINGS_SLOT, { payload: PAYLOAD_B })).tree);
    assert.match(settingsText, /12\.3%/, "设置页与侧栏必须用同一换算函数，数字一致");
});

test("D27-5 loading 态：不出假数字，也不假装有窗口", async () => {
    const tree = (await mountSlot(PANELLIST_SLOT, {
        // fetch 永挂起＝「挂载后、取数返回前」的真实 loading 相位
        fetchMock: () => new Promise(() => {}),
    })).tree;
    const summary = collectTextOf(nodeWithTestId(tree, PANELLIST_SUMMARY_TESTID));
    assert.match(summary, /读取中/, "loading 必须显式占位");
    assert.doesNotMatch(summary, /\d+\.\d+%/, "loading 不得出现数值百分比");
    assert.doesNotMatch(summary, /窗口/, "loading 不得出现窗口数字");
    // 图标在 loading 也在：图标是静态标识，不依赖取数
    assert.ok(nodeWithTestId(tree, PANELLIST_ICON_TESTID), "loading 期间图标仍可见");
});

test("D27-6 unavailable 态：显「数据不可用」而不是空白", async () => {
    const networkDown = (await mountSlot(PANELLIST_SLOT, {
        fetchMock: () => {
            throw new Error("network down");
        },
    })).tree;
    const downText = collectTextOf(nodeWithTestId(networkDown, PANELLIST_SUMMARY_TESTID));
    assert.match(downText, /数据不可用/, "网络失败必须落到「数据不可用」");
    assert.doesNotMatch(downText, /\d+\.\d+%/, "不可用时不得留假数字");

    const badShape = (await mountSlot(PANELLIST_SLOT, {
        payload: { status: "ok" }, // 缺 pressure
    })).tree;
    const badText = collectTextOf(nodeWithTestId(badShape, PANELLIST_SUMMARY_TESTID));
    assert.match(badText, /数据不可用/, "形状不对（缺 pressure）同样判不可用");

    // 空白判定：摘要文本非空，且行节点仍在
    assert.ok(nodeWithTestId(badShape, PANELLIST_TESTID), "不可用时不整块消失");
});

test("D27-7 精简性：图标行不含压力条/刻度线图例/标题，设置页才有全量", async () => {
    const panellistTree = (await mountSlot(PANELLIST_SLOT, { payload: PAYLOAD_A })).tree;
    const row = nodeWithTestId(panellistTree, PANELLIST_TESTID);

    assert.equal(countTestId(panellistTree, PRESSURE_BAR_TESTID), 0, "图标行没有压力条");
    assert.equal(markNodesOf(panellistTree).length, 0, "图标行没有 70/80/82 刻度线，更没有图例");
    assert.doesNotMatch(collectTextOf(panellistTree), /提醒线|驱逐线|摘要线/, "图标行不重复刻度线图例");
    assert.doesNotMatch(collectTextOf(panellistTree), /分层压缩/, "标题属全尺寸面板，图标行不重复");
    // 结构上就是一行：直接子节点全是 span（没有嵌套的区块 div）
    const blockChildren = (row.children ?? []).filter(
        (child) => child && typeof child === "object" && child.type === "div",
    );
    assert.equal(blockChildren.length, 0, "图标行内不该再嵌区块（条/表格都属设置页）");

    // 对照：设置页入口才有图例与压力条
    const settingsTree = (await mountSlot(SETTINGS_SLOT, { payload: PAYLOAD_A })).tree;
    assert.match(collectTextOf(settingsTree), /提醒线/, "设置页（全量）保留刻度线图例");
    assert.ok(countTestId(settingsTree, PRESSURE_BAR_TESTID) === 1);

    // 侧栏面板（点图标后那一屏）也不复制设置页的图例：这是 #5「精简」的口径
    const mainTree = (await mountSlot(MAIN_SLOT, { payload: PAYLOAD_A })).tree;
    assert.equal(markNodesOf(mainTree).length, 3, "侧栏面板保留三条刻度线");
    assert.doesNotMatch(collectTextOf(mainTree), /提醒线|驱逐线|摘要线/, "侧栏面板不渲染设置页专有的图例行");
    assert.match(collectTextOf(mainTree), /窗口 1000000/, "侧栏面板补的是窗口行");
});

test("D27-8 状态字覆盖：压缩中映射为中文，未知状态原样透出", async () => {
    const compactingTree = (await mountSlot(PANELLIST_SLOT, { payload: PAYLOAD_COMPACTING })).tree;
    const compactingText = collectTextOf(nodeWithTestId(compactingTree, PANELLIST_SUMMARY_TESTID));
    assert.match(compactingText, /压缩中/, "「压缩中」是任务 #5 要求覆盖的状态");
    assert.match(compactingText, /81\.0%/, "压缩中同样报压力");

    const frozenTree = (await mountSlot(PANELLIST_SLOT, { payload: PAYLOAD_FROZEN })).tree;
    const frozenText = collectTextOf(nodeWithTestId(frozenTree, PANELLIST_SUMMARY_TESTID));
    assert.match(frozenText, /状态 frozen/, "状态字表未覆盖的值原样显示，不发明新状态");

    // 状态点跟随压力档位（颜色与数值同源，不是第二套判断）
    const dot = nodeWithTestId(compactingTree, "sidebar-panellist-dot");
    assert.ok(dot, "精简态带状态点");
    assert.equal(dot.props["data-tone"], "evict", "81% 属危险档（≥80%）");
});
