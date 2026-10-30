/**
 * 插件包名解析：单一真源。
 *
 * 为什么必须这么写（2026-10-30 事故复盘）：
 *   包名在 0.2.0 已去掉 `@local/` scope，但 tools/gen-*.mjs 里仍硬编码
 *   `@local/dsh-tiered-compaction`。无论从 `link:` 的本地测试仓装，还是从
 *   `github:2849236173/tiered-compaction` 正式装，落进 profile 的包都叫
 *   `dsh-tiered-compaction`。名字对不上时：
 *     preset 行 import 失败 → cordis loader 的 Entry._init 只 logger.error 后 return，
 *     fiber 永不创建 → agent-preset-registry 的 auditRows 记
 *     `tiered-compaction (@local/dsh-tiered-compaction): never started`
 *     → mountPreset 抛错 → 会话 resume 失败。
 *   真因（模块解析不到）在这一整条链里被彻底吞掉，所以只能靠生成侧护栏。
 *
 * 解析优先级：
 *   1. 显式 `--plugin-name` 覆盖（必须仍能解析，否则报错）；
 *   2. profile package.json 的 `dsh.profile.bundles` / `dependencies` 候选；
 *   3. dump 出来的合成配置里出现过的 tiered-compaction 行名；
 *   4. 都没有 → 报错并给出装法。
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 包基础名（不含 scope）。注意是包名 `dsh-tiered-compaction`，不是仓库目录名。 */
export const PLUGIN_BASENAME = "dsh-tiered-compaction";

/** 包名/安装相关的可读错误：message 多行，便于 CLI 直接打印。 */
export class PluginNameError extends Error {
    constructor(message, details = []) {
        super([message, ...details.map((d) => `  - ${d}`)].join("\n"));
        this.name = "PluginNameError";
        this.details = details;
    }
}

/** 默认 profile 目录：~/.dsh/profiles/<name> */
export function defaultProfileDir(profile = "desktop") {
    return join(homedir(), ".dsh", "profiles", profile);
}

/** 该名字是否指向本插件（兼容历史遗留的带 scope 写法）。 */
export function isPluginPackageName(name) {
    return typeof name === "string" && (name === PLUGIN_BASENAME || name.endsWith(`/${PLUGIN_BASENAME}`));
}

/** 取 `--flag <value>` 的值；不存在返回空串。 */
export function optionValue(argv, flag) {
    const at = argv.indexOf(flag);
    if (at < 0) return "";
    const value = argv[at + 1];
    return typeof value === "string" && !value.startsWith("--") ? value : "";
}

/** 从 resolved 入口文件向上找自报 name 匹配的 package.json。 */
function packageRootOf(entryFile, name) {
    let dir = dirname(entryFile);
    for (;;) {
        const manifestPath = join(dir, "package.json");
        if (existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
                if (manifest.name === name) return { dir, manifest };
            } catch {
                // 坏 JSON 不阻断：继续向上找，最后统一报「name 不一致」
            }
        }
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * 校验一个包名能否从 profile 解析，且解析到的包自报名字与之一致。
 * @returns {{name: string, ok: boolean, dir?: string, version?: string, reason?: string}}
 */
export function probePackageName(profileDir, name) {
    const anchor = join(profileDir, "package.json");
    const req = createRequire(existsSync(anchor) ? anchor : join(profileDir, "index.js"));
    let entryFile;
    try {
        entryFile = req.resolve(name);
    } catch (error) {
        return { name, ok: false, reason: error?.code ?? String(error) };
    }
    const root = packageRootOf(entryFile, name);
    if (!root) {
        return { name, ok: false, reason: `解析到 ${entryFile}，但其 package.json 的 name 不是 ${name}` };
    }
    return { name, ok: true, dir: root.dir, version: root.manifest.version };
}

/** profile 里登记过的候选：bundles（宿主真正挂载的清单）优先，其次 dependencies 键。 */
function candidatesFromProfile(profileDir) {
    const manifestPath = join(profileDir, "package.json");
    if (!existsSync(manifestPath)) {
        throw new PluginNameError(`找不到 profile package.json：${manifestPath}`, [
            "确认 --profile / --profile-dir 指向已装插件的 profile",
        ]);
    }
    let pkg;
    try {
        pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
        throw new PluginNameError(`profile package.json 不是合法 JSON：${manifestPath}`, [String(error?.message ?? error)]);
    }
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const deps = Object.keys(pkg?.dependencies ?? {});
    return [...new Set([...bundles.filter(isPluginPackageName), ...deps.filter(isPluginPackageName)])];
}

/** 合成配置 dump 里出现过的行名（兜底来源）。 */
function candidatesFromDump(dumpText) {
    if (typeof dumpText !== "string") return [];
    const names = [];
    for (const line of dumpText.split(/\r?\n/)) {
        const hit = /^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
        if (hit && isPluginPackageName(hit[1])) names.push(hit[1]);
    }
    return [...new Set(names)];
}

function installHint() {
    return [
        "正式装（npm）：dsh plugin --profile desktop add dsh-tiered-compaction",
        "升级：dsh plugin --profile desktop update dsh-tiered-compaction",
        '本地测试装（软链）：dsh plugin --profile desktop add "link:H:/project/dsh-plugin/tiered-compaction"',
        `npm / tarball / github / link 四条路线落地的包名都是 ${PLUGIN_BASENAME}；npm 上没有 @local/ 这个 scope`,
    ];
}

/**
 * 解析出「当前这台机器实际装的那个包名」。
 * @param {{profileDir?: string, override?: string, dumpText?: string}} options
 * @returns {string} 可直接写进 preset 行的包名
 */
export function resolvePluginName({ profileDir = defaultProfileDir(), override = "", dumpText = "" } = {}) {
    if (override) {
        const probe = probePackageName(profileDir, override);
        if (probe.ok) return probe.name;
        throw new PluginNameError(`--plugin-name ${override} 从 ${profileDir} 解析不到（${probe.reason}）`, installHint());
    }

    const candidates = [...new Set([...candidatesFromProfile(profileDir), ...candidatesFromDump(dumpText)])];
    if (candidates.length === 0) {
        throw new PluginNameError(`profile 里没有任何指向 ${PLUGIN_BASENAME} 的包：${profileDir}`, [
            "profile package.json 的 dsh.profile.bundles / dependencies 都没登记本插件（可能还没装）",
            ...installHint(),
        ]);
    }

    const failures = [];
    for (const name of candidates) {
        const probe = probePackageName(profileDir, name);
        if (probe.ok) return probe.name;
        failures.push(`${name} → ${probe.reason}`);
    }
    throw new PluginNameError(`候选包名全部解析失败：${profileDir}`, [
        ...failures,
        "包名必须与已装包 package.json 的 name 完全一致（带不带 scope 是两个不同的包）",
        ...installHint(),
    ]);
}

/**
 * 产物护栏：生成的 YAML 里凡是 tiered-compaction 的行名必须等于解析结果。
 * 专治「生成器里又写死一个 scope」的老毛病——历史事故就是这么来的。
 */
export function assertNoStaleScopeNames(text, expectedName) {
    const bad = [];
    text.split(/\r?\n/).forEach((line, index) => {
        const hit = /^\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/.exec(line);
        if (hit && isPluginPackageName(hit[1]) && hit[1] !== expectedName) {
            bad.push(`第 ${index + 1} 行 name: ${hit[1]}（应为 ${expectedName}）`);
        }
    });
    if (bad.length) {
        throw new PluginNameError(`产物里的插件名与已装包不一致：${expectedName}`, bad);
    }
}
