/**
 * D31（beta3 多 realm 结构修复）：真实 cordis Context，root + 两个 scopeId realm。
 *
 * 锁定的行为：
 *   1. 全进程恰好一份工具结果观察者（root 持有）；
 *   2. 每个 realm 的 compaction 服务都是本插件各自的实例；
 *   3. 同 scope 重复 apply 被拒（降级为自检服务，不再接管）；
 *   4. 真实 emit agent/pre-step：root 不对 preset realm 的会话跑第 4 层，只有该 realm 的实例跑；
 *   5. 只有 preset 实例（无 root）时仍只有一份观察者；
 *   6. fiber dispose 后席位可重新取得；
 *   7. 状态路由全进程只注册一条，webServer 晚到时也是一条，持有者卸载后由别的实例补位。
 *
 * 运行：node --test test/d31-multi-realm.test.js
 */
import { resetProcessState } from "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";

import * as tieredPlugin from "../src/index.js";
import { TieredCompactionEngineService } from "../src/contract.js";
import { inspectSingleWriter } from "../src/single-writer-guard.js";
import { activeObserver } from "../src/shared-stats.js";
import { STATUS_ROUTE_PATH } from "../src/status-route.js";

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

class LlmStub extends Service {
    constructor(ctx) { super(ctx, "llm"); }
}
class MeterStub extends Service {
    constructor(ctx) { super(ctx, "tokenMeter"); }
    measure() { return { totalTokens: 0, nodes: [] }; }
    estimateMessage() { return 0; }
}
class SessionsStub extends Service {
    constructor(ctx) { super(ctx, "sessions"); }
    async flush() {}
}
class WebServerStub extends Service {
    constructor(ctx) {
        super(ctx, "webServer");
        this.live = [];
        this.total = 0;
    }
    register(spec) {
        this.live.push(spec);
        this.total += 1;
        return () => { this.live = this.live.filter((s) => s !== spec); };
    }
}

/** 等 cordis 的异步回收 / inject 回调跑完。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** 每个用例一个干净的 root：宿主依赖服务齐备，进程级状态清零。 */
async function makeRoot(t) {
    resetProcessState();
    const archiveDir = await mkdtemp(join(tmpdir(), "d31-"));
    const root = new Context();
    root.logger = quietLogger;
    await root.plugin(LlmStub);
    await root.plugin(MeterStub);
    await root.plugin(SessionsStub);
    t.after(async () => {
        resetProcessState();
        await rm(archiveDir, { recursive: true, force: true });
    });
    return { root, archiveDir };
}

/** 统计「真正挂了观察者」的实例数。 */
function observerOwners(...services) {
    return services.filter((svc) => svc?._ownObserver !== undefined).length;
}

test("D31-1 root + 两个 realm：恰好一份观察者，且由 root 持有", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    const ptc = root.isolate("compaction");
    await root.plugin(tieredPlugin, { archiveDir });
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    await ptc.plugin(tieredPlugin, { archiveDir, scopeId: "ptc-tc" });

    const r = root.get("compaction");
    const s = standard.get("compaction");
    const p = ptc.get("compaction");
    assert.equal(observerOwners(r, s, p), 1, "全进程只能有一份观察者");
    assert.ok(r._ownObserver, "root 先 apply，观察者归 root");
    assert.equal(activeObserver(), r._ownObserver, "共享表登记的就是 root 那份");
    assert.equal(s.observer, r._ownObserver, "realm 实例读到的是同一份观察者");
    assert.deepEqual(
        inspectSingleWriter().scopes.map((seat) => seat.scope).sort(),
        ["compaction:ptc-tc", "compaction:root", "compaction:standard", "observer"],
    );
});

test("D31-2 每个 realm 的 compaction 服务都是本插件各自的实例", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    const ptc = root.isolate("compaction");
    await root.plugin(tieredPlugin, { archiveDir });
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    await ptc.plugin(tieredPlugin, { archiveDir, scopeId: "ptc-tc" });

    const services = [root, standard, ptc].map((c) => c.get("compaction"));
    for (const svc of services) {
        assert.ok(svc instanceof TieredCompactionEngineService, "realm 内 compaction 必须是本插件契约层");
    }
    assert.equal(new Set(services.map((svc) => svc.config.scopeId ?? "root")).size, 3, "三个互不相同的实例");
    // realm 身份：isolate 键各不相同（服务按该键存放）
    const keys = [root, standard, ptc].map((c) => c[Context.isolate].compaction);
    assert.equal(new Set(keys).size, 3);
});

test("D31-3 同 scope 重复 apply 被拒：不接管、不挂观察者、不占第二个席位", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    const first = standard.get("compaction");

    // 同一 scopeId 的第二份挂在另一个 realm 上：服务位不冲突，只靠席位拦
    const dup = root.isolate("compaction");
    const warns = [];
    dup.logger = { ...quietLogger, warn: (m) => warns.push(m) };
    await dup.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    assert.equal(dup.get("compaction"), undefined, "重复者不得接管 compaction");
    assert.equal(typeof dup.get("tieredCompaction"), "object", "重复者降级为自检服务");
    assert.ok(warns.some((m) => m.includes("compaction:standard")), "告警点名被占席位");
    assert.equal(standard.get("compaction").config.scopeId, "standard", "原持有者不受影响");
    assert.ok(first._ownObserver, "原持有者仍持有观察者");
    assert.equal(
        inspectSingleWriter().scopes.filter((seat) => seat.scope === "compaction:standard").length,
        1,
    );

    // root 重复同理
    await root.plugin(tieredPlugin, { archiveDir });
    const rootDup = root.isolate("compaction");
    await rootDup.plugin(tieredPlugin, { archiveDir });
    assert.equal(rootDup.get("compaction"), undefined, "第二个 root 挂载被拒");
});

test("D31-4 真实 emit：root 不对 preset realm 的会话跑第 4 层", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    const ptc = root.isolate("compaction");
    await root.plugin(tieredPlugin, { archiveDir });
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    await ptc.plugin(tieredPlugin, { archiveDir, scopeId: "ptc-tc" });

    // 记录哪个实例进了 compactIfNeeded（第 4 层入口）；用原型打桩以穿过服务代理
    const calls = [];
    const proto = TieredCompactionEngineService.prototype;
    const original = proto.compactIfNeeded;
    proto.compactIfNeeded = async function (agent) {
        calls.push({ who: this.config.scopeId ?? "root", session: agent.session.id });
        return null;
    };
    t.after(() => { proto.compactIfNeeded = original; });

    // agent 的 ctx 来自所属 realm（宿主 createScope → fiber.ctx.extend，isolate 键随之继承）
    const presetAgent = { ctx: standard.extend({}), session: { id: "preset-session" } };
    const rootAgent = { ctx: root.extend({}), session: { id: "root-session" } };
    const signal = new AbortController().signal;
    await root.emit("agent/pre-step", { agent: presetAgent, signal, step: 1, messages: [] }, () => {});
    await root.emit("agent/pre-step", { agent: rootAgent, signal, step: 1, messages: [] }, () => {});
    await tick();

    assert.deepEqual(
        calls.sort((a, b) => a.session.localeCompare(b.session)),
        [
            { who: "standard", session: "preset-session" },
            { who: "root", session: "root-session" },
        ],
        "每个会话只由所属 realm 的实例处理；root 与 ptc-tc 都不碰 standard 的会话",
    );

    // agent/request-error 同一门控：非本 realm 的 agent 直接 next()
    const r = root.get("compaction");
    assert.equal(r._ownsAgent(presetAgent), false);
    assert.equal(standard.get("compaction")._ownsAgent(presetAgent), true);
    assert.equal(ptc.get("compaction")._ownsAgent(presetAgent), false);
    assert.equal(r._ownsAgent({ session: {} }), true, "无 ctx 的 agent 桩视为本实例（兼容旧调用面）");
});

test("D31-4b agentPresets.serviceFor 给出的实现优先于 isolate 键", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    await root.plugin(tieredPlugin, { archiveDir });
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    // 宿主 serviceForMount 返回 store 里的原始 impl.value（非 ctx.get 的追踪代理），这里照做
    const raw = (c) => root.reflect.store[c[Context.isolate].compaction].value;
    const r = raw(root);
    const s = raw(standard);
    // 真实 preset：agent-loop 在 compaction 组外，agent ctx 的 isolate 键仍是 root 的；
    // 归属只能由注册表按 mount 子树判定（registry serviceFor）
    const agent = { ctx: root.extend({}), session: { id: "p" } };
    const registry = { serviceFor: (a, name) => (a === agent && name === "compaction" ? s : undefined) };
    const realGet = Context.prototype.get;
    const patch = (svc) => {
        svc.ctx.get = function (name, ...rest) {
            return name === "agentPresets" ? registry : realGet.call(this, name, ...rest);
        };
    };
    patch(r);
    patch(s);
    assert.equal(r._ownsAgent(agent), false, "注册表说归 standard，root 不得处理");
    assert.equal(s._ownsAgent(agent), true);
});

test("D31-5 只有 preset 实例（无 root）：仍只有一份观察者", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    const ptc = root.isolate("compaction");
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    await ptc.plugin(tieredPlugin, { archiveDir, scopeId: "ptc-tc" });
    const s = standard.get("compaction");
    const p = ptc.get("compaction");
    assert.equal(observerOwners(s, p), 1, "第一个 apply 的实例持有观察者，后来者不挂");
    assert.ok(s._ownObserver, "standard 先 apply");
    assert.equal(inspectSingleWriter().observerTaken, true);
});

test("D31-6 dispose 后席位可重新取得（含 observer 交接）", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    const fiber = standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    await fiber;
    assert.ok(standard.get("compaction")._ownObserver);
    await fiber.dispose();
    await tick();
    assert.equal(inspectSingleWriter().taken, false, "卸载即归还 compaction 与 observer 两个席位");
    assert.equal(activeObserver(), null, "共享表里的观察者随之注销");

    const again = root.isolate("compaction");
    await again.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    const svc = again.get("compaction");
    assert.ok(svc instanceof TieredCompactionEngineService, "同 scope 重新 apply 能接管");
    assert.ok(svc._ownObserver, "observer 席位也能重新取得");
});

test("D31-7 状态路由全进程只注册一条（webServer 先到）", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    await root.plugin(WebServerStub);
    const ws = root.get("webServer");
    const standard = root.isolate("compaction");
    const ptc = root.isolate("compaction");
    const rootFiber = root.plugin(tieredPlugin, { archiveDir });
    await rootFiber;
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });
    await ptc.plugin(tieredPlugin, { archiveDir, scopeId: "ptc-tc" });
    await tick();
    assert.equal(ws.live.length, 1, "三个实例只挂一条路由");
    assert.equal(ws.live[0].path, STATUS_ROUTE_PATH);
    assert.equal(ws.total, 1);

    // 持有者（root）卸载：路由随之注销，并由剩下的实例补位，始终恰好一条
    await rootFiber.dispose();
    await tick();
    assert.equal(ws.live.length, 1, "持有者卸载后由别的实例补位");
    assert.equal(ws.total, 2);
});

test("D31-7b webServer 晚到：仍只注册一条", async (t) => {
    const { root, archiveDir } = await makeRoot(t);
    const standard = root.isolate("compaction");
    await root.plugin(tieredPlugin, { archiveDir });
    await standard.plugin(tieredPlugin, { archiveDir, scopeId: "standard" });

    const wsFiber = root.plugin(WebServerStub);
    await wsFiber;
    await tick();
    const ws = root.get("webServer");
    assert.equal(ws.live.length, 1, "webServer 出现后补挂，且只挂一条");
    assert.equal(ws.total, 1);

    // 载荷来自共享表：路由能正常出数
    const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    ws.live[0].handler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.ok("hasArchiveDir" in JSON.parse(res.body));
});
