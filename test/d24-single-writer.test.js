/**
 * D24 单写者守卫测试 + 防回归 tripwire。
 *
 * tripwire 的意义（病案 2026-10-29，勿删）：
 * 守卫写在本模块里，最大风险是「将来更新插件时整包替换了 index.js /
 * single-writer-guard.js，守卫被悄悄抹掉」。本文件同时锁两层：
 *  ① 行为层：席位申请/归还/侦查的语义（含 scope 分座）；
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
    releaseSingleWriter,
    inspectSingleWriter,
    MULTI_ENGINE_ESCAPE_ENV,
} from "../src/single-writer-guard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "index.js");
const SEAT_SYMBOL = Symbol.for("dsh-tiered-compaction.single-writer.seat");

beforeEach(() => {
    // 每个用例从空桌开始：归还所有 scope 的遗留席位并清掉逃生阀。
    const seats = globalThis[SEAT_SYMBOL];
    if (seats) {
        for (const key of Object.keys(seats)) {
            releaseSingleWriter(seats[key]);
        }
    }
    delete process.env[MULTI_ENGINE_ESCAPE_ENV];
});

test("D24-1 global 席位：第一位申请者持票，第二位拿 null", () => {
    const a = acquireSingleWriter("contract", {});
    assert.ok(a, "首个实例应当拿到席位");
    assert.equal(a.scope, "global", "缺省 scope 应为 global");
    assert.equal(inspectSingleWriter().taken, true);
    assert.deepEqual(inspectSingleWriter().scopes.map((s) => s.scope), ["global"]);
    assert.equal(inspectSingleWriter().scopes[0].kind, "contract");

    const warns = [];
    const b = acquireSingleWriter("bypass", { logger: { info() {}, warn: (m) => warns.push(m) } });
    assert.equal(b, null, "同 scope 的第二个实例必须拿不到席位");
    assert.ok(warns.some((m) => m.includes("单写者守卫")), "第二实例应收到守卫告警");

    assert.ok(releaseSingleWriter(a), "持票者本人能归还");
    assert.equal(inspectSingleWriter().taken, false, "归还后桌应为空");
});

test("D24-2 归还后可再申请（卸载-重装合法循环）", () => {
    const a = acquireSingleWriter("contract", {});
    releaseSingleWriter(a);
    const b = acquireSingleWriter("bypass", {});
    assert.ok(b, "归还后新申请者应能上位");
    releaseSingleWriter(b);
});

test("D24-3 非持票者无法归还他人席位", () => {
    const a = acquireSingleWriter("contract", {});
    const fake = { kind: "fake", scope: "global", escaped: false, acquiredAt: Date.now() };
    assert.equal(releaseSingleWriter(fake), false, "陌生 token 不能还座");
    assert.equal(inspectSingleWriter().taken, true, "原席位不受影响");
    releaseSingleWriter(a);
});

test("D24-4 逃生阀：环境变量放行并附告警", () => {
    process.env[MULTI_ENGINE_ESCAPE_ENV] = "1";
    const warns = [];
    const a = acquireSingleWriter("contract", { logger: { info() {}, warn: (m) => warns.push(m) } });
    assert.ok(a, "逃生阀下应放行");
    assert.equal(a.escaped, true);
    assert.ok(warns.some((m) => m.includes(MULTI_ENGINE_ESCAPE_ENV)), "放行时必须鸣笛");
});

test("D24-5 realm 分座：不同 realm 可并存，同 realm 内互斥", () => {
    const realmA = acquireSingleWriter("contract", { scope: "realm:ptc-tc" });
    const realmB = acquireSingleWriter("contract", { scope: "realm:standard" });
    assert.ok(realmA && realmB, "不同 realm 应各开一座");

    const warns = [];
    const again = acquireSingleWriter("bypass", {
        scope: "realm:ptc-tc",
        logger: { info() {}, warn: (m) => warns.push(m) },
    });
    assert.equal(again, null, "同 realm 第二实例必须被拦");
    assert.ok(warns.some((m) => m.includes("realm:ptc-tc")), "告警应点名 scope");

    const snap = inspectSingleWriter();
    assert.deepEqual(
        snap.scopes.map((s) => s.scope).sort(),
        ["realm:ptc-tc", "realm:standard"],
    );

    assert.ok(releaseSingleWriter(realmA) && releaseSingleWriter(realmB));
    assert.equal(inspectSingleWriter().taken, false);
});

test("D24-6 ★ 混合互斥：global 与 realm 不得混居（GitHub 用户各种挂法都收敛）", () => {
    // 场景 A：先来 global（root 平面挂载先开机），后来的 realm 必须被降级
    const g = acquireSingleWriter("contract", { scope: "global" });
    assert.ok(g, "全局座应发放");
    const warnsA = [];
    const r = acquireSingleWriter("contract", {
        scope: "realm:standard",
        logger: { info() {}, warn: (m) => warnsA.push(m) },
    });
    assert.equal(r, null, "global 在场时 realm 申请必须被拒（防 root+realm 双写）");
    assert.ok(warnsA.some((m) => m.includes("全局写者")), "告警应说明覆盖关系");
    releaseSingleWriter(g);

    // 场景 B：先来 realm（preset 挂载先开机），后来的 global 必须被降级
    const ra = acquireSingleWriter("contract", { scope: "realm:ptc-tc" });
    assert.ok(ra, "realm 座应发放");
    const warnsB = [];
    const g2 = acquireSingleWriter("bypass", {
        scope: "global",
        logger: { info() {}, warn: (m) => warnsB.push(m) },
    });
    assert.equal(g2, null, "realm 在场时 global 申请必须被拒");
    assert.ok(warnsB.some((m) => m.includes("preset 写者")), "告警应点名 preset 写者");
    releaseSingleWriter(ra);

    // 场景 C：顺序无关——任一顺序最终都收敛到单一形态
    assert.equal(inspectSingleWriter().taken, false, "全部释放后应清空");
});

test("D24-tripwire ★ index.js 必须接线单写者守卫（防更新抹除）", () => {
    const src = readFileSync(SRC, "utf8");
    assert.ok(
        src.includes("./single-writer-guard.js"),
        "index.js 不再导入守卫模块——守卫很可能在更新中被整包替换，请在 apply 接线处恢复（病案 2026-10-29 双写会话损坏）"
    );
    assert.ok(
        src.includes("acquireSingleWriter"),
        "apply() 不再申请写者席位——双写防线被拔掉了，请恢复：拿到席位才允许注册观察者/引擎"
    );
    assert.ok(
        src.includes("releaseSingleWriter"),
        "detach() 不再归还席位——卸载-重装将被守卫永久拦下"
    );
    // 关键次序：席位申请必须发生在接管路径（HostContractEngineService）之前，
    // 且必须在 enabled=false 早退之后（纯自检实例不占座）。
    const atEarlyExit = src.indexOf("if (!resolved.enabled)");
    const atAcquire = src.indexOf("acquireSingleWriter(\"contract\"");
    const atTakeover = src.indexOf("HostContractEngineService, {");
    assert.ok(atEarlyExit > -1 && atAcquire > -1 && atTakeover > -1, "接线点缺失");
    assert.ok(
        atEarlyExit < atAcquire && atAcquire < atTakeover,
        "守卫次序错误：必须 早退判断 → 抢座 → 接管路径"
    );
});

test("D24-tripwire ★ 守卫文件本体存在且语义键齐备", () => {
    const guardSrc = readFileSync(join(HERE, "..", "src", "single-writer-guard.js"), "utf8");
    assert.ok(guardSrc.includes("Symbol.for"), "守卫必须用 Symbol.for 全局表（抗多副本加载）");
    assert.ok(guardSrc.includes("DSH_TC_ALLOW_MULTI_ENGINE"), "逃生阀缺失——调试双写病理的入口没了");
});
