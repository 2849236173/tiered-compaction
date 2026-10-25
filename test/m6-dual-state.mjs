/**
 * M6 双态验证探针（运维对接员 · 2026-10-26）
 *
 * 目的：在真实 Cordis 运行时下验证 M4.5 接线后的两态行为差异。
 * 用法：node test/m6-dual-state.mjs
 *
 * 不依赖 LLM：直接用 Cordis 的应用容器挂载插件，检查服务位归属。
 */

import { Context } from "@deepseek-ai/cordis";
import { apply as tieredApply } from "../src/index.js";
import { TieredCompactionEngine } from "../src/engine.js";

const results = [];

function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? "✔" : "✖"} ${name}${detail ? " — " + detail : ""}`);
}

/** 造一个最小上下文替身：只实现插件用到的方法。 */
function makeFakeCtx() {
    const plugins = [];
    const services = new Map();
    const logs = [];
    const ctx = {
        logger: {
            info: (m) => logs.push(["info", m]),
            warn: (m) => logs.push(["warn", m]),
            error: (m) => logs.push(["error", m]),
        },
        plugin: (Plugin, config) => {
            plugins.push({ Plugin, config });
            return Promise.resolve();
        },
        get: (name) => services.get(name),
        set: (name, v) => services.set(name, v),
        _plugins: plugins,
        _services: services,
        _logs: logs,
    };
    return ctx;
}

/** 用真实 Cordis Context 跑一遍，测服务位真实占用情况。 */
async function realCordisProbe() {
    const ctx = new Context();

    // 先注册一个"宿主 basic 引擎"占住 compaction 槽，模拟真实宿主环境
    const { Service } = await import("@deepseek-ai/cordis");
    class FakeBasicEngine extends Service {
        constructor(c) {
            super(c, "compaction");
            this.kind = "basic";
        }
        summarize() { return "basic-summary"; }
    }
    ctx.plugin(FakeBasicEngine);
    await new Promise((r) => setTimeout(r, 20));

    const holder = ctx.get("compaction");
    record(
        "A 宿主 basic 引擎已占位 compaction 槽",
        holder?.kind === "basic",
        `holder=${holder?.kind}`
    );

    // 在槽被占的情况下启用本插件：应走 construction-catch 降级旁路
    await tieredApply(ctx, { enabled: true });
    await new Promise((r) => setTimeout(r, 20));

    const after = ctx.get("compaction");
    record(
        "B 槽被占时本插件不抢占，basic 仍持有 compaction",
        after?.kind === "basic",
        `holder=${after?.kind}`
    );

    const bypass = ctx.get("tieredCompaction");
    record(
        "C 降级为旁路模式并注册 tieredCompaction 服务",
        Boolean(bypass),
        bypass ? `service=${bypass.constructor.name}` : "未注册"
    );

    return { bypass };
}

/** 干净槽场景：enabled=true 时应真实接管 compaction。 */
async function takeoverProbe() {
    const ctx = new Context();
    await tieredApply(ctx, { enabled: true });
    await new Promise((r) => setTimeout(r, 30));

    const holder = ctx.get("compaction");
    record(
        "D 干净槽 + enabled=true：compaction 被本插件接管",
        holder?.constructor?.name === "TieredCompactionEngineService",
        `holder=${holder?.constructor?.name ?? "none"}`
    );

    const engine = ctx.get("tieredCompaction");
    // 注意：接管态下 compaction 槽就是引擎服务实例本身，engine 挂在它身上；
    // 而 tieredCompaction 自检服务只在 enabled=false / 旁路模式注册。
    const holderWithEngine = ctx.get("compaction");
    const hasEngine = Boolean(holderWithEngine?.engine);
    record(
        "E 接管后挂载了 TieredCompactionEngine 实例",
        hasEngine,
        hasEngine
            ? `engine 方法=${Object.getOwnPropertyNames(Object.getPrototypeOf(holderWithEngine.engine)).join(",")}`
            : "无 engine"
    );
    return { engine: holderWithEngine?.engine, holder: holderWithEngine };
}

/** enabled=false：绝不可触碰 compaction 槽。 */
async function coexistProbe() {
    const ctx = new Context();

    const { Service } = await import("@deepseek-ai/cordis");
    class FakeBasicEngine extends Service {
        constructor(c) {
            super(c, "compaction");
            this.kind = "basic";
        }
    }
    ctx.plugin(FakeBasicEngine);
    await new Promise((r) => setTimeout(r, 20));

    await tieredApply(ctx, { enabled: false });
    await new Promise((r) => setTimeout(r, 20));

    const holder = ctx.get("compaction");
    const self = ctx.get("tieredCompaction");
    record(
        "F enabled=false：basic 独占 compaction，本插件不干扰",
        holder?.kind === "basic" && Boolean(self),
        `compaction=${holder?.kind}, tieredCompaction=${Boolean(self)}`
    );
    return { holder, self };
}

console.log("=== M6 双态验证（真实 Cordis 运行时）===\n");

try {
    console.log("[场景 1] 干净槽 + enabled=true → 接管");
    await takeoverProbe();
    console.log();
} catch (e) {
    record("场景 1 异常", false, e.message);
}

try {
    console.log("[场景 2] enabled=false → 与 basic 并存");
    await coexistProbe();
    console.log();
} catch (e) {
    record("场景 2 异常", false, e.message);
}

try {
    console.log("[场景 3] 槽被占 + enabled=true → 降级旁路");
    await realCordisProbe();
    console.log();
} catch (e) {
    record("场景 3 异常", false, e.message);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
}
