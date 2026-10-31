/**
 * 任务 #4 验收：悬浮 overlay（HUD）——角落常驻 + 可拖动 + 颜色随压力 + 可关闭
 * （方案 §3.3、§五 #4、§六「关闭后重启宿主不再出现」）。
 *
 * 延续 d23/d25 的 vm 沙箱 + mock 模式，本文件聚焦 HUD 行为：
 *   1. 没有 localStorage 也能渲染（隐私模式/宿主不给存储时必须照常显示）；
 *   2. 点关闭按钮后不渲染，且 closed:true 落盘；
 *   3. 预置 closed:true → 启动即不渲染（= 重启宿主后不再出现，验收硬指标）；
 *   4. 拖动：按下→document 移动→松开，位置写 localStorage，下次按存档恢复；
 *   5. 三档压力三色（<70% / 70~80% / ≥80%），颜色与档位同源；
 *   6. localStorage 读/写抛异常时降级不崩（渲染照旧，只是不记住）；
 *   7. 关闭只关 overlay：settings/main 两个入口不受影响。
 *
 * 关键：mock 的 createElement 只造 `{type, props, children}`，函数组件**不会**
 * 自动执行。本文件用 renderNode 递归下钻——遇到 function 类型的 type 就手动
 * `type(props)` 再递归其结果；hook 槽位按组件函数分开存（真实 React 也按组件
 * 区分，共用一份会把 overlay 的 closed 状态串进压力快照）。
 *
 * 运行：node --test test/d26-overlay-hud.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");

const PACKAGE_NAME = "dsh-tiered-compaction";
const FAKE_BASE_URI = "http://127.0.0.1:16271/chat?session=abc";
const OVERLAY_SLOT = "shell.overlay";
const OVERLAY_HUD_TESTID = "overlay-hud";
const OVERLAY_CLOSE_TESTID = "overlay-close";
const PRESSURE_BAR_TESTID = "pressure-bar";
/** 与 client.js 的 HUD_STATE_KEY 同字符串（记忆键是对外契约，测试显式钉住）。 */
const HUD_STATE_KEY = "tiered-compaction-hud-state";

const PAYLOAD_OK = { status: "ok", pressure: 0.27 };

/** 三档压力样本：<70% 绿、70~80% 黄、≥80% 橙。 */
const PAYLOAD_CALM = { status: "ok", pressure: 0.27 };
const PAYLOAD_REMIND = { status: "ok", pressure: 0.75 };
const PAYLOAD_EVICT = { status: "ok", pressure: 0.85 };

/**
 * mock react：hook 槽位按组件函数分开存，effect 供测试手动驱动。
 * 比 d25 的版本多两件事：① 支持惰性初值（useState(readHudState) 必须能懒读存档）；
 * ② 支持一次渲染里多个 hook / 多个组件（HUD 有自己的 closed/位置状态）。
 */
function createMockReact() {
    const hookStores = new Map();
    const effectRuns = new Map();
    let activeStore = null;
    let hookIndex = 0;
    let pendingEffects = [];

    /** 递归渲染：函数组件手动执行后继续下钻（本文件最容易踩空的一步）。 */
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
        /** 跑本轮收集到的 effect；同一个 (组件, hook 序号) 只跑一次（deps=[] 语义）。 */
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

/** 最小 localStorage：Map 支撑，可注入抛异常的版本。 */
function createStorageMock(initialEntries = {}) {
    const store = new Map(Object.entries(initialEntries));
    return {
        store,
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        },
        removeItem(key) {
            store.delete(key);
        },
    };
}

/** 最小 document：记录 addEventListener 挂上的监听，测试手动 dispatch。 */
function createDocumentMock() {
    const listeners = new Map();
    return {
        baseURI: FAKE_BASE_URI,
        listeners,
        addEventListener(name, handler) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(handler);
        },
        removeEventListener(name, handler) {
            listeners.get(name)?.delete(handler);
        },
        /** 派发一个事件给所有挂在该事件名下的监听（= 真实 document 的行为）。 */
        dispatch(name, event) {
            for (const handler of [...(listeners.get(name) ?? [])]) handler(event);
        },
        listenerCount(name) {
            return listeners.get(name)?.size ?? 0;
        },
    };
}

/**
 * 在 vm 沙箱里执行 client.js，捕获 load 规格并用 mock react 求值 factory。
 * options.storage：注入 localStorage；缺省=宿主不给存储（隐私模式）。
 * options.pointer：注入 window.PointerEvent，走 pointer 事件族。
 */
function loadClientModule(react, options = {}) {
    const { storage = undefined, pointer = false } = options;
    let loadedSpec = null;
    const documentMock = createDocumentMock();
    const windowMock = {
        __ModuleLoader__: { load(spec) { loadedSpec = spec; } },
    };
    if (storage !== undefined) windowMock.localStorage = storage;
    if (pointer) windowMock.PointerEvent = function PointerEvent() {};
    const sandbox = {
        window: windowMock,
        document: documentMock,
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
    return { plugin, sandbox, documentMock };
}

/** mock slots：记录注册并立即执行回调（与 d23/d25 同构）。 */
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

/** 按 data-testid 计数（关闭后应为 0）。 */
function countTestId(tree, testId) {
    let count = 0;
    walkTree(tree, (node) => {
        if (node.props && node.props["data-testid"] === testId) count += 1;
    });
    return count;
}

/** 取某种事件的监听（拖动走 document，测试要拿到实现挂上去的那个函数才叫真测）。 */
function dragEventNames(pointer) {
    return pointer
        ? { down: "onPointerDown", move: "pointermove", up: "pointerup" }
        : { down: "onMouseDown", move: "mousemove", up: "mouseup" };
}

/**
 * 完整挂载流程（照 d25：挂载→跑 effect→flush 微任务→再渲染拿最终树）。
 * 返回 rerender()，用于模拟宿主因状态变化重渲（点关闭/拖动之后）。
 */
async function mountOverlay(options = {}) {
    const { storage, pointer = false, payload = PAYLOAD_OK, fetchMock } = options;
    const react = createMockReact();
    const { plugin, sandbox, documentMock } = loadClientModule(react, { storage, pointer });
    const slots = applyModule(plugin);
    sandbox.fetch = async () => {
        const respond = fetchMock ?? (() => ({ ok: true, json: async () => payload }));
        return respond();
    };

    const entry = slots.registrationOf(OVERLAY_SLOT);
    assert.ok(entry, "shell.overlay 槽位必须已注册");
    react.render(entry.component, {});
    await react.runEffects();
    await new Promise((resolve) => setImmediate(resolve));

    return {
        react,
        sandbox,
        documentMock,
        slots,
        tree: react.render(entry.component, {}),
        rerender() {
            return react.render(entry.component, {});
        },
    };
}

/** 读 HUD 存档（没有则 null）。 */
function storedHudStateOf(storage) {
    const raw = storage.getItem(HUD_STATE_KEY);
    return raw === null ? null : JSON.parse(raw);
}

/** 模拟一次完整拖动：按在 (x,y)、拖到 (tx,ty)、松开。 */
function dragTo(harness, { from, to, pointer = false, rect = { left: 400, top: 300 } }) {
    const names = dragEventNames(pointer);
    const root = harness.tree;
    const down = root.props[names.down];
    assert.equal(typeof down, "function", `HUD 根节点必须挂 ${names.down}（拖动入口）`);
    down({
        clientX: from.x,
        clientY: from.y,
        currentTarget: { getBoundingClientRect: () => rect },
        preventDefault() {},
    });
    harness.documentMock.dispatch(names.move, { clientX: to.x, clientY: to.y });
    harness.documentMock.dispatch(names.up, { clientX: to.x, clientY: to.y });
}

test("D26-1 没有 localStorage 时 overlay 照常渲染（角落常驻）", async () => {
    const harness = await mountOverlay();
    const hud = nodeWithTestId(harness.tree, OVERLAY_HUD_TESTID);
    assert.ok(hud, "无 localStorage 时 HUD 必须渲染——不能因为存储不可用就不显示");
    assert.equal(hud.props["data-surface"], "overlay", "overlay 入口仍要标 surface");
    assert.equal(hud.props.style.position, "fixed", "角落常驻=fixed 定位");
    assert.equal(hud.props.style.right, "16px", "未拖动过用角落偏移");
    assert.equal(hud.props.style.bottom, "16px");
    assert.equal(hud.props.style.left, undefined, "未拖动过不该有 left");
    // 关闭按钮与压力条都在（条是 #3 的能力，HUD 不能把它弄丢）
    assert.ok(nodeWithTestId(harness.tree, OVERLAY_CLOSE_TESTID), "必须有关闭按钮");
    assert.ok(nodeWithTestId(harness.tree, PRESSURE_BAR_TESTID), "HUD 内仍要有压力条");
    assert.match(collectTextOf(harness.tree), /27\.0%/, "数值文本仍来自 API");
});

test("D26-2 点关闭后不渲染，且 closed:true 落 localStorage", async () => {
    const storage = createStorageMock();
    const harness = await mountOverlay({ storage });
    const close = nodeWithTestId(harness.tree, OVERLAY_CLOSE_TESTID);
    assert.equal(typeof close.props.onClick, "function", "关闭按钮必须挂 onClick");
    close.props.onClick();

    const tree = harness.rerender();
    assert.equal(countTestId(tree, OVERLAY_HUD_TESTID), 0, "关闭后 HUD 不得再渲染");
    assert.equal(countTestId(tree, PRESSURE_BAR_TESTID), 0, "关闭后连压力条也不该留");

    assert.deepEqual(storedHudStateOf(storage), { closed: true, left: null, top: null }, "关闭状态必须落盘");
});

test("D26-3 预置 closed:true → 启动即不渲染（重启宿主后不再出现）", async () => {
    const storage = createStorageMock({ [HUD_STATE_KEY]: JSON.stringify({ closed: true, left: null, top: null }) });
    const harness = await mountOverlay({ storage });
    assert.equal(countTestId(harness.tree, OVERLAY_HUD_TESTID), 0, "存档说关了就一个节点都不出");
    assert.equal(harness.tree, null, "关闭状态下组件返回 null");
});

test("D26-4 拖动：位置写 localStorage，下次启动按存档恢复", async () => {
    const storage = createStorageMock();
    const harness = await mountOverlay({ storage });

    // 元素初始落在 (400,300)（角落），指针从 (500,400) 拖到 (460,340)：位移 (-40,-60)
    dragTo(harness, { from: { x: 500, y: 400 }, to: { x: 460, y: 340 } });

    assert.deepEqual(
        storedHudStateOf(storage),
        { closed: false, left: 360, top: 240 },
        "松开时把位置（像素）写进 localStorage",
    );

    // 「重启宿主」= 新沙箱 + 同一个 localStorage，位置必须从存档恢复
    const restarted = await mountOverlay({ storage });
    const hud = nodeWithTestId(restarted.tree, OVERLAY_HUD_TESTID);
    assert.ok(hud, "重启后（未关闭）HUD 必须还在");
    assert.equal(hud.props.style.left, "360px", "恢复存档的 left");
    assert.equal(hud.props.style.top, "240px", "恢复存档的 top");
    assert.equal(hud.props.style.right, "auto", "改用 left/top 后必须放开 right，否则 fixed 下会互相拉扯");
    assert.equal(hud.props.style.bottom, "auto");
});

test("D26-5 拖动过程不落盘（每帧写存储会卡），松开后监听收干净", async () => {
    const storage = createStorageMock();
    const harness = await mountOverlay({ storage });
    const names = dragEventNames(false);

    const root = harness.tree;
    root.props[names.down]({
        clientX: 10,
        clientY: 10,
        currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
        preventDefault() {},
    });
    harness.documentMock.dispatch(names.move, { clientX: 60, clientY: 30 });
    assert.equal(storage.getItem(HUD_STATE_KEY), null, "拖动中只更新渲染，不写存储");

    harness.documentMock.dispatch(names.up, {});
    assert.deepEqual(storedHudStateOf(storage), { closed: false, left: 50, top: 20 }, "松开才落盘");
    assert.equal(harness.documentMock.listenerCount(names.move), 0, "拖完必须摘掉 document 监听");
    assert.equal(harness.documentMock.listenerCount(names.up), 0);
});

test("D26-6 三档压力三色：<70% 绿、70~80% 黄、≥80% 橙", async () => {
    const calm = await mountOverlay({ payload: PAYLOAD_CALM });
    const remind = await mountOverlay({ payload: PAYLOAD_REMIND });
    const evict = await mountOverlay({ payload: PAYLOAD_EVICT });

    const toneOf = (harness) => nodeWithTestId(harness.tree, OVERLAY_HUD_TESTID).props["data-tone"];
    assert.equal(toneOf(calm), "calm", "27% 应为正常档");
    assert.equal(toneOf(remind), "remind", "75% 应为偏高档");
    assert.equal(toneOf(evict), "evict", "85% 应为危险档");

    const dotColorOf = (harness) =>
        nodeWithTestId(harness.tree, "overlay-status-dot").props.style.backgroundColor;
    const valueColorOf = (harness) => {
        let color = null;
        walkTree(nodeWithTestId(harness.tree, PRESSURE_BAR_TESTID), (node) => {
            if (node.props?.key === "pressure-value") color = node.props.style.color;
        });
        return color;
    };

    const colors = [calm, remind, evict].map(dotColorOf);
    assert.equal(new Set(colors).size, 3, "三档必须是三种可区分的颜色");
    // 状态点与数值文本同源同色：颜色只是数值的表达，不引入第二个数据源
    for (const harness of [calm, remind, evict]) {
        assert.equal(valueColorOf(harness), dotColorOf(harness), "数值文本颜色必须与状态点一致");
    }

    // 数值本身仍以 API 为准（配色不参与计算）
    assert.match(collectTextOf(calm.tree), /27\.0%/);
    assert.match(collectTextOf(remind.tree), /75\.0%/);
    assert.match(collectTextOf(evict.tree), /85\.0%/);
});

test("D26-7 localStorage 读/写都抛异常时降级不崩（只是不记住）", async () => {
    const throwingStorage = {
        getItem() {
            throw new Error("SecurityError: storage disabled");
        },
        setItem() {
            throw new Error("QuotaExceededError");
        },
        removeItem() {
            throw new Error("SecurityError");
        },
    };
    const harness = await mountOverlay({ storage: throwingStorage });
    const hud = nodeWithTestId(harness.tree, OVERLAY_HUD_TESTID);
    assert.ok(hud, "存储抛异常也必须正常渲染");

    // 关闭：写盘失败但渲染必须切换到「不渲染」
    nodeWithTestId(harness.tree, OVERLAY_CLOSE_TESTID).props.onClick();
    assert.equal(countTestId(harness.rerender(), OVERLAY_HUD_TESTID), 0, "写盘失败不影响关闭生效");

    // 拖动：同样不能抛
    const fresh = await mountOverlay({ storage: throwingStorage });
    assert.doesNotThrow(() => dragTo(fresh, { from: { x: 5, y: 5 }, to: { x: 25, y: 35 } }), "拖动全程不得抛异常");
    assert.equal(collectTextOf(fresh.rerender()).includes("undefined"), false, "降级后文本不能出现 undefined");
});

test("D26-8 有 PointerEvent 时走 pointer 事件族（鼠标/触控/笔一套）", async () => {
    const storage = createStorageMock();
    const harness = await mountOverlay({ storage, pointer: true });
    const hud = nodeWithTestId(harness.tree, OVERLAY_HUD_TESTID);
    assert.equal(typeof hud.props.onPointerDown, "function", "pointer 环境下必须挂 onPointerDown");
    assert.equal(hud.props.onMouseDown, undefined, "pointer 环境下不重复挂 mouse 按下（避免双触发）");

    dragTo(harness, { from: { x: 100, y: 100 }, to: { x: 130, y: 150 }, pointer: true });
    assert.deepEqual(storedHudStateOf(storage), { closed: false, left: 430, top: 350 }, "pointer 拖动同样落盘");
});

test("D26-9 关闭只关 overlay：settings 入口照常渲染", async () => {
    const storage = createStorageMock({ [HUD_STATE_KEY]: JSON.stringify({ closed: true, left: null, top: null }) });
    const react = createMockReact();
    const { plugin, sandbox } = loadClientModule(react, { storage });
    const slots = applyModule(plugin);
    sandbox.fetch = async () => ({ ok: true, json: async () => PAYLOAD_OK });

    const entry = slots.registrationOf("settings.section");
    react.render(entry.component, {});
    await react.runEffects();
    await new Promise((resolve) => setImmediate(resolve));
    const tree = react.render(entry.component, {});
    assert.ok(nodeWithTestId(tree, PRESSURE_BAR_TESTID), "settings 的压力条不能被 overlay 的关闭状态影响");

    // overlay 侧确实不渲染——同一次会话里两件事同时成立
    const overlayEntry = slots.registrationOf(OVERLAY_SLOT);
    react.render(overlayEntry.component, {});
    await react.runEffects();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(countTestId(react.render(overlayEntry.component, {}), OVERLAY_HUD_TESTID), 0);
});
