/**
 * 任务 #5 设计回归：入口收敛为设置页 + 低干扰悬浮入口。
 *
 * 旧版 main/sidebar.panellist 会把状态面板切进聊天主区，造成重复入口和布局
 * 争抢。本文件锁住新的产品决策：两处注册，侧栏两个注册点必须不存在。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
const PACKAGE_NAME = "dsh-tiered-compaction";
const FAKE_BASE_URI = "http://127.0.0.1:16271/chat?session=abc";

function createMockReact() {
    return {
        createElement(type, props, ...children) {
            return { type, props: props ?? {}, children };
        },
        useState(initial) {
            return [typeof initial === "function" ? initial() : initial, () => {}];
        },
        useEffect() {
            return () => {};
        },
    };
}

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
    assert.ok(loadedSpec, "client.js 必须注册模块");
    assert.equal(loadedSpec.id, PACKAGE_NAME);
    return loadedSpec.factory(() => react);
}

function applyModule(plugin) {
    const slots = {
        injections: [],
        registrations: [],
        inject(name, callback) {
            slots.injections.push(name);
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

test("D27-1 两入口注册：只保留设置页和 shell.overlay", () => {
    const slots = applyModule(loadClientModule(createMockReact()));
    assert.deepEqual([...slots.injections].sort(), ["settings.section", "shell.overlay"].sort());
    assert.equal(slots.registrations.length, 2);
    assert.ok(slots.registrationOf("settings.section"));
    assert.ok(slots.registrationOf("shell.overlay"));
});

test("D27-2 旧侧栏注册不存在，避免切换聊天主区", () => {
    const slots = applyModule(loadClientModule(createMockReact()));
    assert.equal(slots.registrationOf("main"), undefined);
    assert.equal(slots.registrationOf("sidebar.panellist"), undefined);
});

test("D27-3 设置入口与悬浮入口的 surface 契约保持独立", () => {
    const slots = applyModule(loadClientModule(createMockReact()));
    const settingsEntry = slots.registrationOf("settings.section");
    const overlayEntry = slots.registrationOf("shell.overlay");
    const settingsElement = settingsEntry.component({});
    const overlayElement = overlayEntry.component({});
    const settingsTree = settingsElement.type(settingsElement.props);
    const overlayTree = overlayElement.type(overlayElement.props);
    assert.equal(settingsTree.props["data-surface"], "settings");
    assert.equal(overlayTree.props["data-surface"], "overlay");
    assert.equal(overlayTree.props.style.position, "fixed");
});

test("D27-4 两入口 label 都可求值", () => {
    const slots = applyModule(loadClientModule(createMockReact()));
    for (const name of ["settings.section", "shell.overlay"]) {
        const options = slots.registrationOf(name).options;
        assert.equal(typeof options.label, "function");
        assert.equal(typeof options.label(), "string");
    }
});
