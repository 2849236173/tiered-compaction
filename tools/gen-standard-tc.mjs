/**
 * standard → standard-tc 生成与自检（供 tools/gen-standard-tc.ps1 调用）。
 *
 * 背景（D17 实测结论，比 D15 的 B 路线更深一层）：
 *   ds-bot 创建所有 Bot / 群会话时硬编码 `agentPreset: 'standard'`
 *   （src/host/roster.js:36-41，原因是 ptc 只准调 run_code，会把群聊的
 *   group_relay 废掉）。因此：
 *     1. `selectedDefault: ptc-tc` 对 Bot 会话完全不起作用；
 *     2. 根域的 `compaction-basic` 早已是 disabled: true，但会话里的压缩照常
 *        工作——因为每个 preset 内部自带一个 `isolate: compaction` 的隔离域，
 *        根域接管根本不在那个域里。
 *   要让压缩真正换引擎，只能把 preset 内部 compaction 组的引擎项替换掉。
 *
 * 为什么必须整块替换 preset-standard 的 config：
 *   实测 patch 的 `- id` 只在顶层（bundle 根层）按 id 定位。写
 *   `- id: compaction-basic` 完全无法命中 preset 内部的嵌套条目；
 *   写 `- id: preset-standard` + `config:` 则是**整体替换** config 对象
 *   （实测：只写 plugins[0] 时其余插件全部消失）。
 *   所以这里把 preset-standard 的完整 config 原样吐出来，只改引擎一项。
 *
 * 用法：
 *   node tools/gen-standard-tc.mjs <dumpFile> <outputFile> <archiveDir> [--diff-only]
 */

import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { assertNoStaleScopeNames, optionValue, PLUGIN_BASENAME, resolvePluginName } from "./lib/plugin-name.mjs";

/** D2：本 preset 的 realm 标识，写进引擎 config.scopeId（单写者守卫按它分座）。 */
const SCOPE_ID = "standard";

/** `!!js` 自定义标量：构造成 { __js: 源码 }，与现有 gen-ptc-tc 保持一致。 */
const JS_TYPE = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar",
    construct: (d) => ({ __js: d }),
    // 必须提供 predicate + represent：否则 dump 时 !!js 会被降级成普通 map
    // （`disabled:\n  __js: 源码`），与原 dump 的 `disabled: !!js 源码` 不一致。
    // 用 predicate 而不是 instanceOf: Object——后者会匹配所有对象。
    predicate: (obj) => obj !== null && typeof obj === "object" && "__js" in obj,
    represent: (obj) => obj.__js,
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TYPE]);

const [dumpPath, outPath, archiveDir, ...restArgs] = process.argv.slice(2);
const flag = restArgs.includes("--diff-only") ? "--diff-only" : "";
const profileDir = optionValue(restArgs, "--profile-dir");
const pluginNameOverride = optionValue(restArgs, "--plugin-name");

if (!archiveDir) {
    console.error("缺少 archiveDir 参数");
    process.exit(2);
}

/** 从 dump 中切出 preset-standard 顶层条目并解析为对象。 */
function loadPreset(dumpText, ids) {
    const lines = dumpText.split(/\r?\n/);
    const start = lines.findIndex((l) => l === "- id: preset-standard");
    if (start < 0) throw new Error("dump 里找不到顶层条目 '- id: preset-standard'");
    let end = start + 1;
    while (end < lines.length && !/^- id: /.test(lines[end])) end += 1;
    // 顶层条目内容缩进 2，去掉后作为对象根
    const body = lines.slice(start + 1, end).map((l) => l.replace(/^ {2}/, ""));
    const entry = yaml.load(["id: preset-standard", ...body].join("\n"), { schema: SCHEMA });
    if (entry.config.id !== ids) {
        throw new Error(`preset-standard 的 config.id 应为 ${ids}`);
    }
    return { entry, span: [start, end - 1] };
}

/**
 * 生成覆盖用的 standard：只把 compaction 组里的 compaction-basic 换成 tiered-compaction。
 *
 * 关键：config.id 必须保持 "standard"，不能改成别的名字。原因：
 *   ds-bot 硬编码按 id "standard" 建会话；136 个存量会话的 agentPreset 记录
 *   也都是 "standard"。改名会让它们全部报 agent-preset/not-found。
 * 所以本方案是「原地覆盖 standard 的压缩引擎」，不是新建一个 preset。
 *
 * 幂等：dump 是「已合成」的配置，落地后重跑时 compaction 组里已经是
 *   tiered-compaction 而不再有 compaction-basic。此时必须识别为「已应用」
 *   并原样重建同一产物，否则第二次 Apply 会直接报错。
 */
function buildStandardTc(standard, pluginName) {
    const tc = JSON.parse(JSON.stringify(standard));
    // config.id 原样保留（"standard"），不改名。
    // 一句话描述（typert.host.js schema 可选字段，预设列表 UI 显示）；
    // standard 原本无 description，新增属预期差异（见下方 expected 清单）。
    tc.config.description = "基于官方 standard，仅换装 tiered-compaction 四层压缩引擎，层 1-4 全开";

    const group = tc.config.plugins.find((p) => p.id === "compaction");
    if (!group) throw new Error("standard 里找不到 id=compaction 的组");
    if (!Array.isArray(group.config)) throw new Error("compaction 组的 config 不是数组");

    const target = {
        id: "tiered-compaction",
        name: pluginName,
        config: { enabled: true, archiveDir, scopeId: SCOPE_ID },
    };

    const basicIdx = group.config.findIndex((p) => p.id === "compaction-basic");
    if (basicIdx >= 0) {
        // 首次应用：把 compaction-basic 换成 tiered-compaction（原地保位）
        group.config[basicIdx] = target;
        return { entry: tc, alreadyApplied: false };
    }

    const tcIdx = group.config.findIndex((p) => p.id === "tiered-compaction");
    if (tcIdx < 0) {
        throw new Error("compaction 组里既无 compaction-basic 也无 tiered-compaction，结构异常");
    }
    // 已应用过：合并而非覆盖——保留用户在条目上加的其它配置（如 auto、阈值），
    // 只把 name / enabled / archiveDir / scopeId 规范化成目标值
    const existing = group.config[tcIdx];
    group.config[tcIdx] = {
        ...existing,
        ...target,
        config: { ...(existing?.config ?? {}), ...target.config },
    };
    return { entry: tc, alreadyApplied: true };
}

/* ---------------- 递归 diff ---------------- */
function diffTree(a, b, path = "(root)", out = []) {
    if (JSON.stringify(a) === JSON.stringify(b)) return out;
    const ta = Array.isArray(a) ? "arr" : typeof a;
    const tb = Array.isArray(b) ? "arr" : typeof b;
    if (ta !== tb || (ta === "arr" && a.length !== b.length)) {
        out.push({ path, from: a, to: b });
        return out;
    }
    if (ta === "arr") {
        for (let i = 0; i < a.length; i += 1) diffTree(a[i], b[i], `${path}[${i}]`, out);
        return out;
    }
    if (ta === "object" && a && b) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            diffTree(k in a ? a[k] : "__MISSING__", k in b ? b[k] : "__MISSING__", `${path}.${k}`, out);
        }
        return out;
    }
    out.push({ path, from: a, to: b });
    return out;
}

const dumpText = readFileSync(dumpPath, "utf8");
// D2：preset 行的 name 固定为 npm 包名 dsh-tiered-compaction（正式发布名）。
// 仍探测一次已装包：探测结果不同（如 @local/ 本地链接）只告警，不改写产物。
const pluginName = PLUGIN_BASENAME;
try {
    const installed = resolvePluginName({ profileDir, override: pluginNameOverride, dumpText });
    if (installed !== pluginName) {
        console.warn(`警告：本机解析到的包名是 ${installed}，产物仍写 ${pluginName}；请改用 npm 正式包安装，否则 preset 行会 import 失败`);
    }
} catch (error) {
    console.warn(`警告：未能确认本机已装 ${pluginName}（${error?.message ?? error}）`);
}
console.log(`插件包名: ${pluginName}`);

const { entry: standard, span } = loadPreset(dumpText, "standard");
const { entry: tc, alreadyApplied } = buildStandardTc(standard, pluginName);

/* ---------------- 自检：差异必须恰好是「引擎替换 + config.id 改名」 ---------------- */
const compIdx = standard.config.plugins.findIndex((p) => p.id === "compaction");
const base = `(root).config.plugins[${compIdx}].config[0]`;

const raw = diffTree(standard, tc);
// 新增的 config 对象展开成叶子，便于精确断言
const flat = [];
for (const d of raw) {
    if (d.path.endsWith(".config") && d.from === "__MISSING__" && d.to && typeof d.to === "object") {
        for (const [k, v] of Object.entries(d.to)) {
            flat.push({ path: `${d.path}.${k}`, from: "__MISSING__", to: v });
        }
    } else if (d.path === base && d.from && d.to) {
        // 整个引擎条目被替换：展开成字段级
        for (const k of new Set([...Object.keys(d.from), ...Object.keys(d.to)])) {
            flat.push({ path: `${base}.${k}`, from: d.from[k] ?? "__MISSING__", to: d.to[k] ?? "__MISSING__" });
        }
    } else {
        flat.push(d);
    }
}

const expected = [
    { path: "(root).config.description", to: "基于官方 standard，仅换装 tiered-compaction 四层压缩引擎，层 1-4 全开" },
    { path: `${base}.id`, to: "tiered-compaction" },
    { path: `${base}.name`, to: pluginName },
];
const archivePath = `${base}.config.archiveDir`;
const enabledPath = `${base}.config.enabled`;
const scopePath = `${base}.config.scopeId`;

const problems = [];
// 铁律：preset id 必须仍是 standard，否则 ds-bot 与 136 个存量会话全部找不到 preset。
if (tc.config.id !== standard.config.id) {
    problems.push(`config.id 被改动（${standard.config.id} → ${tc.config.id}）——必须保持原值，否则 ds-bot 找不到 preset`);
}

// 已应用过时，dump 里本来就是目标形态，diff 只剩 archiveDir/enabled 之类，
// 差异条数会不同；此时只校验「最终形态正确」，不要求差异条数。
if (!alreadyApplied) {
    if (flat.length !== expected.length + 3) {
        problems.push(`展开后差异 ${flat.length} 处，预期 ${expected.length + 3}（含 description/enabled/archiveDir/scopeId）`);
    }
    for (const exp of expected) {
        const hit = flat.find((d) => d.path === exp.path);
        if (!hit) problems.push(`缺少预期差异 ${exp.path}`);
        else if (JSON.stringify(hit.to) !== JSON.stringify(exp.to)) {
            problems.push(`${exp.path} 目标值应为 ${JSON.stringify(exp.to)}，实际 ${JSON.stringify(hit.to)}`);
        }
    }
}

// 无论首次还是重复应用，最终形态都必须正确——这条是真正的护栏。
const group = tc.config.plugins.find((p) => p.id === "compaction");
const applied = group.config.find((p) => p.id === "tiered-compaction");
if (!applied) problems.push("最终形态里 compaction 组没有 tiered-compaction");
else {
    if (applied.name !== pluginName) problems.push(`引擎 name 错误：${applied.name}`);
    if (applied.config?.enabled !== true) problems.push("引擎 enabled 必须为 true");
    if (applied.config?.archiveDir !== archiveDir) problems.push(`archiveDir 应为 ${archiveDir}，实际 ${applied.config?.archiveDir}`);
    if (applied.config?.scopeId !== SCOPE_ID) problems.push(`scopeId 应为 ${SCOPE_ID}，实际 ${JSON.stringify(applied.config?.scopeId)}`);
}
// description 护栏：宿主列表 UI 依赖它显示介绍（PO 单 #1）。
// 放在 alreadyApplied 分支之外，重复 Apply 时也校验最终形态。
if (tc.config?.description !== "基于官方 standard，仅换装 tiered-compaction 四层压缩引擎，层 1-4 全开") {
    problems.push(`config.description 应为一句话介绍，实际 ${JSON.stringify(tc.config?.description)}`);
}

const enabledHit = flat.find((d) => d.path === enabledPath);
if (!alreadyApplied) {
    if (!enabledHit) problems.push(`缺少预期差异 ${enabledPath}`);
    else if (enabledHit.to !== true) problems.push(`${enabledPath} 应为 true，实际 ${JSON.stringify(enabledHit.to)}`);
}

const adHit = flat.find((d) => d.path === archivePath);
if (!alreadyApplied) {
    if (!adHit) problems.push(`缺少预期差异 ${archivePath}`);
    else if (typeof adHit.to !== "string" || adHit.to.length === 0) problems.push(`${archivePath} 应为非空字符串`);
}

const allowed = new Set([...expected.map((e) => e.path), enabledPath, archivePath, scopePath]);
for (const d of flat) {
    if (!allowed.has(d.path)) problems.push(`出现预期之外的差异 ${d.path}`);
}

console.log("=== 差异明细（standard → standard-tc）===");
flat.forEach((d) => console.log(`  ${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`));
console.log(`  展开后差异条数: ${flat.length}`);

if (flag === "--diff-only") {
    if (problems.length) {
        console.log("\n=== 自检失败 ===");
        problems.forEach((p) => console.log("  ✖ " + p));
        process.exit(1);
    }
    console.log(`\n=== 自检通过：差异恰好 ${flat.length} 处，全部符合预期 ===`);
    process.exit(0);
}

if (problems.length) {
    console.log("\n=== 自检失败，不写产物 ===");
    problems.forEach((p) => console.log("  ✖ " + p));
    process.exit(1);
}

/* ---------------- 写产物 ---------------- */
// 首个标记行由 ps1 写入，这里不再重复输出版权/说明头
const header = [
    "# 本区块由 tools/gen-standard-tc.ps1 生成，请勿手工编辑；DSH 升级后重跑脚本重同步。",
    "# 为什么不用 selectedDefault: ds-bot 创建 Bot/群会话时硬编码 agentPreset: 'standard'",
    "#   （src/host/roster.js:36-41），改 default 对 Bot 会话无效，只能直接改 standard 本身。",
    "# 为什么整块重写 config: patch 的 - id 只在顶层按 id 定位，preset 内的嵌套条目改不到；",
    "#   写 - id: preset-standard + config: 是整体替换，必须吐完整 plugins。",
    "# config.id 保持 standard 不变——改名会让 ds-bot 与存量会话全部 not-found。",
    "# 回退：删掉本段即可恢复原 standard（本段是唯一改动处）。",
];

// 只输出 id + config：name/order 等其余顶层字段沿用原条目（整体替换 config，不替换整条）
const body = yaml.dump([{ id: "preset-standard", config: tc.config }], {
    lineWidth: -1,
    noRefs: true,
    schema: SCHEMA,
});

assertNoStaleScopeNames(body, pluginName);
writeFileSync(outPath, header.join("\n") + "\n" + body, "utf8");

console.log(`\n=== 自检通过${alreadyApplied ? "（检测到已应用过，产物已按目标形态重建）" : ""}，产物已写入 ${outPath} ===`);
console.log(`    preset-standard 原块位置: dump 行 ${span[0] + 1} ~ ${span[1] + 1}`);
process.exit(0);
