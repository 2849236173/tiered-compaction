/**
 * M2 骨架自检：验证插件模块可被 Node ESM 加载、导出面完整。
 * 运行：node --test test/（不依赖宿主运行时）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, detach } from "../src/index.js";

test("插件模块可加载且导出面完整", () => {
    assert.equal(typeof apply, "function", "必须导出 apply 函数");
    assert.equal(typeof detach, "function", "必须导出 detach 函数");
});

/** 极简宿主桩：记录 plugin() 调用，模拟 Cordis ctx 的最小表面。 */
function stubCtx() {
    const calls = [];
    return {
        calls,
        plugin(Service, config) {
            calls.push({ name: Service.name ?? String(Service), config });
        },
        logger: { info() {}, warn() {} },
    };
}

test("默认 enabled=false：仅注册自检服务，不触碰 compaction 服务位", () => {
    const ctx = stubCtx();
    apply(ctx, {});
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].config.enabled, false);
});

test("enabled=true：注册服务并携带开关配置", () => {
    const ctx = stubCtx();
    apply(ctx, { enabled: true });
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].config.enabled, true);
});
