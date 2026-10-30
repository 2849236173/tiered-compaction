#!/usr/bin/env node
/**
 * 安装自检：确认 profile 里引用的 tiered-compaction 包名能真正被解析。
 *
 * 为什么需要它：
 *   包名与实际安装不一致时，宿主报的是
 *     `tiered-compaction (<name>): never started`
 *   后面才跟会话 resume 失败，真因（模块解析不到）被 loader 的 logger.error 吞掉。
 *   装完 / 换安装来源（本地 link ↔ github）之后跑这一条命令，就能提前发现。
 *
 * 用法：
 *   node tools/check-install.mjs [--profile desktop] [--profile-dir <dir>]
 *   node node_modules/<已装包>/tools/check-install.mjs --profile desktop
 *
 * 退出码：0 全部可解析 / 1 存在问题
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    PLUGIN_BASENAME,
    defaultProfileDir,
    isPluginPackageName,
    optionValue,
    probePackageName,
} from "./lib/plugin-name.mjs";

const argv = process.argv.slice(2);
const profile = optionValue(argv, "--profile") || "desktop";
const profileDir = optionValue(argv, "--profile-dir") || defaultProfileDir(profile);
const patchPath = join(profileDir, "cordis.patch.yml");

/** 补丁里所有指向本插件的行名（带行号，便于直接改）。 */
const rows = [];
if (existsSync(patchPath)) {
    readFileSync(patchPath, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
            const hit = /^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
            if (hit && isPluginPackageName(hit[1])) rows.push({ line: index + 1, name: hit[1] });
        });
} else {
    console.log(`未找到 profile 补丁（${patchPath}），跳过行检查。`);
}

/** profile 登记挂载的包（宿主启动时按它装配 root 平面实例）。 */
const bundles = [];
const manifestPath = join(profileDir, "package.json");
if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const name of manifest?.dsh?.profile?.bundles ?? []) {
        if (isPluginPackageName(name)) bundles.push(name);
    }
}

const names = [...new Set([...rows.map((row) => row.name), ...bundles])];
if (names.length === 0) {
    console.error(`✖ ${profileDir} 里没有任何 ${PLUGIN_BASENAME} 的引用（既没装也没挂）`);
    process.exit(1);
}

console.log(`profile: ${profileDir}`);
let failed = 0;
for (const name of names) {
    const probe = probePackageName(profileDir, name);
    const where = rows.filter((row) => row.name === name).map((row) => `cordis.patch.yml:${row.line}`);
    if (bundles.includes(name)) where.push("package.json:dsh.profile.bundles");
    if (probe.ok) {
        console.log(`  ✔ ${name} → ${probe.dir} (v${probe.version})  [${where.join(", ")}]`);
    } else {
        failed += 1;
        console.log(`  ✖ ${name} → ${probe.reason}  [${where.join(", ")}]`);
    }
}

if (failed > 0) {
    console.log(`
结论：${failed} 个包名解析不到。宿主挂载 preset 时会报
  <id> (<name>): never started，随后该会话 resume 失败。
最常见原因：包名与已装包 package.json 的 name 不一致
  （例如写了 @local/<name>，而实际装的是无 scope 的 <name>）。
修复：把上面 ✖ 行的 name 改成 ✔ 行的名字；或按当前安装来源重跑
  tools/gen-standard-tc.ps1 -Apply / tools/gen-ptc-tc.ps1 -Apply。
npm 装的还可以先升级到最新版：dsh plugin --profile desktop update dsh-tiered-compaction`);
    process.exit(1);
}

console.log("\n✔ 全部可解析：preset 挂载不会因包名失败。");
process.exit(0);
