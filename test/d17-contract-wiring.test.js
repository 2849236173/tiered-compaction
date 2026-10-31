/**
 * D17 接管路径接线测试：**接管类必须自己持有四层引擎与观察者**。
 *
 * 为什么单独一个文件（这是今晚最贵的一课）：
 *   `apply()` 在 enabled=true 时实例化的是 **contract.js 的
 *   TieredCompactionEngineService**（导入别名 HostContractEngineService）。
 *   但四层引擎（TieredCompactionEngine）与工具结果观察者
 *   （ToolResultObserver）原先只在 **index.js 的同名类**里创建——
 *   那个类在接管路径上从未被实例化。
 *
 *   后果链条：
 *     第 1-2 层代码存在 → 但没有任何活对象持有它 →
 *     archiveDir 永远不被写入 → 目录永远不创建 →
 *     且全过程零报错、零警告（因为根本没有代码在跑）
 *
 *   为什么 41 条测试全绿也抓不到：
 *     它们都在测「engine 能不能折叠/落盘」「observer 能不能处理事件」，
 *     即**零件本身是好的**；没有一条测「接管类有没有把这些零件装上」。
 *     这正是团队记忆里那条：接入宿主的功能，验收必须含真实装配路径。
 *
 * 本文件的原则：从 `apply()` 进入，断言接管出来的服务**身上真的挂着**
 * engine 与 observer，并且 observer 真的注册了 session/event 钩子。
 *
 * 运行：node --test test/d17-contract-wiring.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

const quietLogger = { info() {}, warn() {}, error() {} };

/**
 * 造一个能真实构造 Cordis Service 的根 Context。
 *
 * 真实宿主里 `compaction` 槽位由 preset 的隔离域提供；这里用一个最小
 * 占位实现把宿主侧依赖（llm / tokenMeter / sessions）补齐，
 * 让 `static inject` 能解析——否则 Service 会静默待命，测不到构造。
 */
function makeCtx({ withObserverHooks = true } = {}) {
    const ctx = new Context();
    const hooks = new Map();

    // 宿主三依赖：给最小可用桩（本测试只关心装配，不关心读数）
    ctx.provide("llm", { stream: async () => ({}) });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: 0 }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });

    // logger：Service 构造里会用到，且我们要能观察日志
    ctx.logger = quietLogger;

    // 记录 session/event 注册（观察者是否真的挂上）
    if (withObserverHooks) {
        const realOn = ctx.on.bind(ctx);
        ctx.on = (name, fn) => {
            if (!hooks.has(name)) hooks.set(name, []);
            hooks.get(name).push(fn);
            return realOn(name, fn);
        };
    }

    return { ctx, hooks };
}

test("D17 接管接线：apply(enabled=true) 产出的服务必须自己持有 engine 与 observer", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d17wire-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const { ctx, hooks } = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });

    // 接管服务本身就挂在 ctx.compaction 上
    const service = ctx.get("compaction");
    assert.ok(service !== undefined, "apply 后 compaction 服务位必须被本插件接管");

    // 核心断言：接管类必须真的持有四层引擎
    assert.ok(
        service.engine !== undefined,
        "接管服务必须持有 engine——这是 D17 的真 bug：引擎只在未被实例化的类里创建",
    );
    assert.equal(typeof service.engine.processToolOutput, "function");

    // 核心断言：接管类必须真的持有观察者
    assert.ok(
        service.observer !== undefined,
        "接管服务必须持有 observer——否则第 1-2 层没有任何活对象驱动",
    );
    assert.equal(typeof service.observer.handleEvent, "function");

    // 观察者必须真的注册了 session/event 钩子
    assert.ok(hooks.has("session/event"), "observer.register() 必须注册 session/event");

    // 引擎必须拿到了 archiveDir（否则落盘层静默跳过）
    assert.equal(service.engine.deps.archiveDir, dir, "engine 必须拿到 archiveDir");
});

test("D17 接管接线：走真实钩子派发即可产生归档文件（端到端最小闭环）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "d17wire2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const { ctx, hooks } = makeCtx();
    await apply(ctx, { enabled: true, archiveDir: dir, auto: false });
    const service = ctx.get("compaction");

    // 造一段唯一行输出（fold 折叠不了，必然落到第 2 层），>8000 字节
    const lines = [];
    for (let i = 0; i < 300; i += 1) {
        lines.push(`D17-WIRE 行${i} 唯一内容 abcdefghijklmnop-${i}-padding-padding`);
    }
    const text = lines.join("\n");
    assert.ok(Buffer.byteLength(text, "utf8") > 8000, "测试数据必须超过落盘阈值");

    // 最小会话桩（append 同步派发 session/event——本测试的钩子正注册在 ctx 上）
    const log = [];
    const session = {
        surface: { nodes: [] },
        eventAt: (seq) => log.find((e) => e.seq === seq),
        append(type, data, options = {}) {
            const seq = log.length + 1;
            const event = { seq, type, data, ...options };
            log.push(event);
            if (options.surfaceOp?.op === "replace") {
                const at = session.surface.nodes.indexOf(options.surfaceOp.startSeq);
                if (at !== -1) session.surface.nodes[at] = seq;
            }
            // 宿主语义：append 同步派发 session/event，不 await 返回的 Promise
            for (const fn of hooks.get("session/event") ?? []) {
                try {
                    const result = fn(session, event);
                    if (result !== undefined && typeof result.catch === "function") result.catch(() => {});
                } catch { /* 宿主也是 catch 掉监听者的同步异常 */ }
            }
            return event;
        },
    };
    const source = {
        seq: 1,
        type: "tool/result",
        data: { message: { content: [{ type: "text", text }] } },
    };
    log.push(source);
    session.surface.nodes.push(1);

    // 按宿主真实签名（位置参数）派发
    for (const fn of hooks.get("session/event")) await fn(session, source);

    // 归档目录必须出现文件——这是 archiveDir 的唯一真实消费证据
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(dir);
    assert.ok(files.length > 0, "第 2 层必须真的写出归档文件（此前为 0 是 D17 的核心症状）");

    const archived = await readFile(join(dir, files[0]), "utf8");
    assert.match(archived, /D17-WIRE/, "归档内容必须是原始工具输出");
});
