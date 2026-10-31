/**
 * D24 单写者守卫测试 + 防回归 tripwire（beta3：observer / compaction:<scope> 两类席位）。
 *
 * tripwire 的意义（病案 2026-10-29，勿删）：
 * 守卫写在本模块里，最大风险是「将来更新插件时整包替换了 index.js /
 * single-writer-guard.js，守卫被悄悄抹掉」。本文件同时锁两层：
 *  ① 行为层：席位申请/归还/侦查的语义；
 *  ② 接线层：直接读 src/index.js 源码断言守卫仍在 apply 链路上——
 *     任何不带守卫的版本跑测试会在这里当场红灯，不存在静默回退。
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import {
    acquireSingleWriter,
    compactionSeat,
    releaseSingleWriter,
    inspectSingleWriter,
    MULTI_ENGINE_ESCAPE_ENV,
    OBSERVER_SEAT,
    __resetSingleWriterForTests,
} from "../src/single-writer-guard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "index.js");

beforeEach(() => {
    // 每个用例从空桌开始，并清掉逃生阀。
    __resetSingleWriterForTests();
    delete process.env[MULTI_ENGINE_ESCAPE_ENV];
});

test("D24-0 席位名：root 记作 compaction:root，realm 记作 compaction:<scopeId>", () => {
    assert.equal(compactionSeat(undefined), "compaction:root");
    assert.equal(compactionSeat(""), "compaction:root");
    assert.equal(compactionSeat("ptc-tc"), "compaction:ptc-tc");
    assert.equal(OBSERVER_SEAT, "observer");
    assert.throws(() => acquireSingleWriter("contract", {}), /席位名/, "席位名必须显式给出");
});

test("D24-1 observer 席位：第一位申请者持票，第二位拿 null", () => {
    const a = acquireSingleWriter("observer", { scope: OBSERVER_SEAT });
    assert.ok(a, "首个实例应当拿到席位");
    assert.equal(inspectSingleWriter().observerTaken, true);
    assert.deepEqual(inspectSingleWriter().scopes.map((s) => s.scope), ["observer"]);

    const warns = [];
    const b = acquireSingleWriter("observer", { scope: OBSERVER_SEAT, logger: { info() {}, warn: (m) => warns.push(m) } });
    assert.equal(b, null, "observer 全进程唯一");
    assert.ok(warns.some((m) => m.includes("单写者守卫")), "第二实例应收到守卫告警");

    assert.ok(releaseSingleWriter(a), "持票者本人能归还");
    assert.equal(inspectSingleWriter().taken, false, "归还后桌应为空");
});

test("D24-2 归还后可再申请（卸载-重装合法循环）", () => {
    const a = acquireSingleWriter("contract", { scope: compactionSeat() });
    releaseSingleWriter(a);
    const b = acquireSingleWriter("bypass", { scope: compactionSeat() });
    assert.ok(b, "归还后新申请者应能上位");
    releaseSingleWriter(b);
});

test("D24-3 非持票者无法归还他人席位；重复归还无效", () => {
    const a = acquireSingleWriter("contract", { scope: compactionSeat() });
    const fake = { kind: "fake", scope: "compaction:root", escaped: false, acquiredAt: Date.now() };
    assert.equal(releaseSingleWriter(fake), false, "陌生 token 不能还座");
    assert.equal(inspectSingleWriter().taken, true, "原席位不受影响");
    assert.equal(releaseSingleWriter(a), true);
    assert.equal(releaseSingleWriter(a), false, "过期 token 不能二次归还");
});

test("D24-4 逃生阀：环境变量放行并附告警", () => {
    process.env[MULTI_ENGINE_ESCAPE_ENV] = "1";
    const warns = [];
    const a = acquireSingleWriter("contract", { scope: compactionSeat(), logger: { info() {}, warn: (m) => warns.push(m) } });
    assert.ok(a, "逃生阀下应放行");
    assert.equal(a.escaped, true);
    assert.ok(warns.some((m) => m.includes(MULTI_ENGINE_ESCAPE_ENV)), "放行时必须鸣笛");
});

test("D24-5 compaction 分座：root 与各 realm 并存，同 scope 互斥", () => {
    const root = acquireSingleWriter("contract", { scope: compactionSeat() });
    const realmA = acquireSingleWriter("contract", { scope: compactionSeat("ptc-tc") });
    const realmB = acquireSingleWriter("contract", { scope: compactionSeat("standard") });
    assert.ok(root && realmA && realmB, "root 与不同 realm 各开一座（第 4 层按 realm 门控，不会双写）");

    const warns = [];
    const again = acquireSingleWriter("contract", {
        scope: compactionSeat("ptc-tc"),
        logger: { info() {}, warn: (m) => warns.push(m) },
    });
    assert.equal(again, null, "同 scope 第二实例必须被拦");
    assert.ok(warns.some((m) => m.includes("compaction:ptc-tc")), "告警应点名席位");
    assert.equal(acquireSingleWriter("contract", { scope: compactionSeat() }), null, "root 重复 apply 同样被拦");

    assert.deepEqual(
        inspectSingleWriter().scopes.map((s) => s.scope).sort(),
        ["compaction:ptc-tc", "compaction:root", "compaction:standard"],
    );
    assert.ok(releaseSingleWriter(root) && releaseSingleWriter(realmA) && releaseSingleWriter(realmB));
    assert.equal(inspectSingleWriter().taken, false);
});

test("D24-6 observer 与 compaction 席位互不影响", () => {
    const comp = acquireSingleWriter("contract", { scope: compactionSeat("standard") });
    const obs = acquireSingleWriter("observer", { scope: OBSERVER_SEAT });
    assert.ok(comp && obs);
    releaseSingleWriter(comp);
    assert.deepEqual(inspectSingleWriter().scopes.map((s) => s.scope), ["observer"]);
    releaseSingleWriter(obs);
});

test("D24-tripwire ★ src/index.js 的 apply 链路仍接着守卫", () => {
    const src = readFileSync(SRC, "utf8");
    assert.ok(src.includes("single-writer-guard.js"), "index.js 必须导入单写者守卫");
    assert.ok(src.includes("acquireSingleWriter"), "apply 链路必须申请席位");
    assert.ok(src.includes("releaseSingleWriter"), "席位必须有归还路径");
    assert.match(src, /ctx\.effect\(/, "席位必须由 ctx.effect 托管归还");
    assert.doesNotMatch(src, /export function detach\b/, "detach() 已删除");
    // 关键次序：早退 → compaction 席位 → observer 席位 → 接管路径
    const atEarlyExit = src.indexOf("if (!resolved.enabled)");
    const atCompaction = src.indexOf("holdSeat(ctx, \"contract\"");
    const atObserver = src.indexOf("holdSeat(ctx, \"observer\"");
    const atTakeover = src.indexOf("HostContractEngineService, {");
    assert.ok(atEarlyExit > -1 && atCompaction > -1 && atObserver > -1 && atTakeover > -1, "接线点缺失");
    assert.ok(
        atEarlyExit < atCompaction && atCompaction < atObserver && atObserver < atTakeover,
        "守卫次序错误：必须 早退判断 → compaction 席位 → observer 席位 → 接管路径"
    );
});

test("D24-tripwire ★ 守卫文件本体存在且语义键齐备", () => {
    const guardSrc = readFileSync(join(HERE, "..", "src", "single-writer-guard.js"), "utf8");
    assert.ok(guardSrc.includes("Symbol.for"), "守卫必须用 Symbol.for 全局表（抗多副本加载）");
    assert.ok(guardSrc.includes("DSH_TC_ALLOW_MULTI_ENGINE"), "逃生阀缺失——调试双写病理的入口没了");
});
