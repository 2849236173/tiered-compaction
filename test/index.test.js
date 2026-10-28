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

test("默认 enabled=true：装上即接管，不要求用户改配置", async () => {
    const ctx = stubCtx();
    await apply(ctx, {});
    assert.equal(ctx.calls.length >= 1, true, "apply 必须注册服务");
    const cfg = ctx.calls.at(-1).config;
    assert.equal(cfg.enabled, true, "默认必须为 true——装了就该生效");
    assert.ok(
        typeof cfg.archiveDir === "string" && cfg.archiveDir.length > 0,
        "默认必须带可用存档目录，否则第 1-2 层静默跳过",
    );
});

test("显式 enabled=false 时退化为自检服务", async () => {
    const ctx = stubCtx();
    await apply(ctx, { enabled: false });
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].config.enabled, false);
});
