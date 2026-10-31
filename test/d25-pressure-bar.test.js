/**
 * 任务 #3 验收：压力条与三条刻度线（方案 §三、§五 #3、§六）。
 *
 * 延续 d23 的 vm 沙箱 + mock 模式（load/factory/slots/mock react），聚焦：
 *   1. 压力条区块在三入口（settings/main/sidebar、shell.overlay）都有渲染；
 *   2. ready 态三条刻度线可见可辨：left 定位 70%/80%/82%（位置互异可断言），
 *      且带语义标签（title=「70% 提醒线」等，方案 §3.1 命名）；
 *   3. 数值文本=API 返回值：mock 换一组 pressure，文本随之变——证明数值
 *      来源于 API 响应而非 client 自算（验收§六「压力数值从 API 读」）；
 *   4. loading/unavailable 不渲染假数字：无 x.x% 形态的数值文本（一位小数
 *      百分数是数值文本专属格式；刻度图例是 70%/80%/82% 整数，不冲突）；
 *   5. overlay 紧凑分支：隐藏图例（方案 §3.3），但条与三刻度线保留；
 *   6. 镜像常量防漂移：client 的 70/80/82 与 src/soft-pressure.js 的
 *      REMIND_RATIO/EVICT_RATIO、src/lossy-summarize.js 的
 *      MIN_THRESHOLD_RATIO 同值（浏览器端不能 import src/，成对维护，
 *      本测试就是「成对」的看守）。
 *
 * 运行：node --test test/d25-pressure-bar.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
const SOFT_PRESSURE_SOURCE = readFileSync(new URL("../src/soft-pressure.js", import.meta.url), "utf8");
const LOSSY_SUMMARIZE_SOURCE = readFileSync(new URL("../src/lossy-summarize.js", import.meta.url), "utf8");

const PACKAGE_NAME = "dsh-tiered-compaction";
const FAKE_BASE_URI = "http://127.0.0.1:16271/chat?session=abc";
const PRESSURE_BAR_TESTID = "pressure-bar";

/** 两组不同的 API 快照：换值断言用，证明数值文本来源于 API 响应。 */
const PAYLOAD_A = { status: "ok", pressure: 0.27 };
const PAYLOAD_B = { status: "ok", pressure: 0.1234 };

/**
 * mock react：与 d23 同构。useState 的当前值挂在 react.pendingSnapshot 上，
 * useEffect 暂存 effect 供测试手动驱动（跑完 effect 后手动重渲）。
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

/** mock slots：记录注册并立即执行回调（与 d23 同构，mock 直跑等价于宿主行为）。 */
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

/** 深遍历 vnode 树，访问每个节点（含字符串叶子的父级容器）。 */
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

/** 找 data-testid 命中的节点（本文件只有一个压力条区块，取第一个即可）。 */
function nodeWithTestId(tree, testId) {
    const hits = [];
    walkTree(tree, (node) => {
        if (node.props && node.props["data-testid"] === testId) hits.push(node);
    });
    return hits[0] ?? null;
}

/** 收集带刻度线语义 title 的节点（提醒线/驱逐线/摘要线）。 */
function markNodesOf(tree) {
    const hits = [];
    walkTree(tree, (node) => {
        if (typeof node.props?.title === "string" && /[提驱摘]|线$/.test(node.props.title)) {
            hits.push(node);
        }
    });
    return hits;
}

/**
 * 完整渲染流程：注册 → 初渲（挂 effect）→ 跑 effect → flush 微任务 → 重渲。
 * fetchMock 缺省时返回 PAYLOAD_A 的成功响应。
 */
async function renderedTreeOf({ slotName, fetchMock }) {
    const react = createMockReact();
    const { plugin, sandbox } = loadClientModule(react);
    const slots = applyModule(plugin);
    sandbox.fetch = async () => {
        const respond = fetchMock ?? (() => ({ ok: true, json: async () => PAYLOAD_A }));
        return respond();
    };

    const entry = slots.registrationOf(slotName);
    assert.ok(entry, `槽位 ${slotName} 必须已注册`);
    const element = entry.component({});
    assert.equal(typeof element.type, "function");
    element.type(element.props);
    await react.pendingEffect();
    await new Promise((resolve) => setImmediate(resolve));
    return element.type(element.props);
}

/** 收集子树里满足谓词的全部节点（walkTree 递归进 vnode 内部）。 */
function allNodesOf(tree, predicate) {
    const hits = [];
    walkTree(tree, (node) => {
        if (predicate(node)) hits.push(node);
    });
    return hits;
}

/** 压力条区块内的数值文本（key=pressure-value 的 span）。 */
function pressureValueTextOf(tree) {
    const bar = nodeWithTestId(tree, PRESSURE_BAR_TESTID);
    assert.ok(bar, "渲染树必须含压力条区块");
    let valueText = null;
    walkTree(bar, (node) => {
        if (node.props?.key === "pressure-value") valueText = collectTextOf(node);
    });
    return valueText;
}

test("D25-1 压力条区块在两入口都有渲染（settings/overlay）", async () => {
    for (const slotName of ["settings.section", "shell.overlay"]) {
        const tree = await renderedTreeOf({ slotName });
        assert.ok(nodeWithTestId(tree, PRESSURE_BAR_TESTID), `${slotName} 必须渲染压力条区块`);
    }
});

test("D25-2 ready 态三条刻度线：left=70%/80%/82% 位置互异，title 带语义标签", async () => {
    const tree = await renderedTreeOf({ slotName: "settings.section" });
    const marks = markNodesOf(tree);
    assert.equal(marks.length, 3, "必须恰有 三条刻度线");

    const positions = marks.map((mark) => mark.props.style.left);
    assert.deepEqual(positions.sort(), ["70%", "80%", "82%"], "三条线的横向位置必须各不相同");
    const titles = marks.map((mark) => mark.props.title);
    assert.ok(titles.some((title) => title.includes("提醒线")), "70% 线要有「提醒线」标签");
    assert.ok(titles.some((title) => title.includes("驱逐线")), "80% 线要有「驱逐线」标签");
    assert.ok(titles.some((title) => title.includes("摘要线")), "82% 线要有「摘要线」标签");
});

test("D25-3 数值文本=API 值：换一组 mock pressure，文本随之变化且填充宽度同源", async () => {
    const treeA = await renderedTreeOf({ slotName: "settings.section" });
    assert.match(collectTextOf(treeA), /27\.0%/, "PAYLOAD_A(0.27) 的数值文本必须是 27.0%");
    const widthsA = allNodesOf(treeA, (node) => typeof node.props?.style?.width === "string").map((node) => node.props.style.width);
    assert.ok(widthsA.includes("27%"), "填充宽度必须来自 API 的 pressure（27%）");

    const treeB = await renderedTreeOf({ slotName: "settings.section", fetchMock: () => ({ ok: true, json: async () => PAYLOAD_B }) });
    assert.match(collectTextOf(treeB), /12\.3%/, "PAYLOAD_B(0.1234) 的数值文本必须是 12.3%");
    const widthsB = allNodesOf(treeB, (node) => typeof node.props?.style?.width === "string").map((node) => node.props.style.width);
    assert.ok(widthsB.includes("12.34%"), "填充宽度跟着 API 值变（12.34%），证明不是写死的常数");
});

test("D25-4 loading 态：不出 x.x% 假数字，显「读取中…」，填充宽度为 0%", async () => {
    const tree = await renderedTreeOf({
        slotName: "settings.section",
        // fetch 永挂起：等价于「挂载后、取数返回前」的真实 loading 相位
        fetchMock: () => new Promise(() => {}),
    });
    const barText = collectTextOf(nodeWithTestId(tree, PRESSURE_BAR_TESTID));
    assert.doesNotMatch(barText, /\d+\.\d+%/, "loading 相位不得出现数值文本");
    assert.match(barText, /读取中/, "loading 相位必须显「读取中…」");

    // 三条刻度线的 width 是 "2px"，百分比宽度只有填充层这一处
    const percentWidths = allNodesOf(
        nodeWithTestId(tree, PRESSURE_BAR_TESTID),
        (node) => /^\d+(\.\d+)?%$/.test(node.props?.style?.width ?? ""),
    );
    assert.equal(percentWidths.length, 1, "loading 相位只有填充层一处百分比宽度");
    assert.equal(percentWidths[0].props.style.width, "0%", "loading 相位填充必须为 0%，不能渲染假进度");
});

test("D25-5 unavailable 态：不出 x.x% 假数字，显「数据不可用」", async () => {
    const tree = await renderedTreeOf({
        slotName: "settings.section",
        fetchMock: () => { throw new Error("network down"); },
    });
    const barText = collectTextOf(nodeWithTestId(tree, PRESSURE_BAR_TESTID));
    assert.doesNotMatch(barText, /\d+\.\d+%/, "unavailable 相位不得出现数值文本");
    assert.match(barText, /数据不可用/, "unavailable 相位必须显「数据不可用」");
});

test("D25-6 overlay 紧凑分支：隐藏图例文本，条与三刻度线保留", async () => {
    const overlayTree = await renderedTreeOf({ slotName: "shell.overlay" });
    const barText = collectTextOf(nodeWithTestId(overlayTree, PRESSURE_BAR_TESTID));
    assert.doesNotMatch(barText, /提醒线/, "overlay 不渲染图例文本（方案 §3.3 迷你版）");
    assert.ok(markNodesOf(overlayTree).length === 3, "overlay 仍必须有 三条刻度线");
    assert.ok(nodeWithTestId(overlayTree, PRESSURE_BAR_TESTID), "overlay 的条本体保留");

    const settingsTree = await renderedTreeOf({ slotName: "settings.section" });
    assert.match(collectTextOf(nodeWithTestId(settingsTree, PRESSURE_BAR_TESTID)), /提醒线/, "全尺寸入口才有图例");
});

test("D25-7 镜像常量与 src/ 阈值同值（防成对维护漂移）", () => {
    /** 从源码里抽 `NAME = <数字>` 常量。 */
    function numericConstOf(source, name) {
        const match = source.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)`));
        assert.ok(match, `${name} 必须在源码中以数字字面量定义`);
        return Number(match[1]);
    }

    assert.equal(
        numericConstOf(CLIENT_SOURCE, "PRESSURE_REMIND_RATIO"),
        numericConstOf(SOFT_PRESSURE_SOURCE, "REMIND_RATIO"),
        "client 70% 镜像必须等于 soft-pressure 的 REMIND_RATIO",
    );
    assert.equal(
        numericConstOf(CLIENT_SOURCE, "PRESSURE_EVICT_RATIO"),
        numericConstOf(SOFT_PRESSURE_SOURCE, "EVICT_RATIO"),
        "client 80% 镜像必须等于 soft-pressure 的 EVICT_RATIO",
    );
    assert.equal(
        numericConstOf(CLIENT_SOURCE, "PRESSURE_LOSSY_FLOOR_RATIO"),
        numericConstOf(LOSSY_SUMMARIZE_SOURCE, "MIN_THRESHOLD_RATIO"),
        "client 82% 镜像必须等于 lossy-summarize 的 MIN_THRESHOLD_RATIO",
    );
});
