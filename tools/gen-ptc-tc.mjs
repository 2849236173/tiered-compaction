/**
 * ptc → ptc-tc 生成与自检（供 tools/gen-ptc-tc.ps1 调用）。
 *
 * 为什么用 Node 而不是 PowerShell 处理文本：
 *   preset 配置里含大段中文（plan-mode 提示词）与 !!js 自定义标量。
 *   PowerShell 的 Set-Content -Encoding UTF8 在不同版本（5.1 带 BOM / 7 不带）
 *   与管道编码上行为不一致，实测会造成中文乱码（鈥? 之类）与产物不幂等。
 *   Node 全程按 UTF-8 读写，且 dsh 的输出本来就是 UTF-8，不经过转换最稳。
 *
 * 用法：
 *   node tools/gen-ptc-tc.mjs <dumpFile> <outputFile> <order> <archiveDir> [--diff-only]
 */

import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { assertNoStaleScopeNames, optionValue, resolvePluginName } from "./lib/plugin-name.mjs";

const JS_TYPE = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar",
    construct: (d) => ({ __js: d }),
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TYPE]);

const [dumpPath, outPath, orderArg, archiveDir, ...restArgs] = process.argv.slice(2);
const flag = restArgs.includes("--diff-only") ? "--diff-only" : "";
const profileDir = optionValue(restArgs, "--profile-dir");
const pluginNameOverride = optionValue(restArgs, "--plugin-name");
const order = Number(orderArg);

/** 从 dump 中切出 preset-ptc 顶层条目并解析为对象。 */
function loadPtc(dumpText) {
    const lines = dumpText.split(/\r?\n/);
    const start = lines.findIndex((l) => l === "- id: preset-ptc");
    if (start < 0) throw new Error("dump 里找不到顶层条目 '- id: preset-ptc'");
    let end = start + 1;
    while (end < lines.length && !/^- id: /.test(lines[end])) end += 1;
    // 顶层条目内容缩进 2，去掉后作为对象根
    const body = lines.slice(start + 1, end).map((l) => l.replace(/^ {2}/, ""));
    return {
        entry: yaml.load(["id: preset-ptc", ...body].join("\n"), { schema: SCHEMA }),
        rawBlock: lines.slice(start, end),
    };
}

/** 生成 ptc-tc 对象：只改 id / config.id / order / compaction 组的引擎项。 */
function buildPtcTc(ptc, pluginName) {
    const tc = JSON.parse(JSON.stringify(ptc));
    tc.id = "preset-ptc-tc";
    tc.config.id = "ptc-tc";
    tc.config.order = order;
    // 一句话描述（typert.host.js schema 可选字段），预设列表 UI 直接显示。
    tc.config.description = "基于官方 ptc，仅换装 tiered-compaction 四层压缩引擎，层 1-4 全开";
    const group = tc.config.plugins.find((p) => p.id === "compaction");
    if (!group) throw new Error("ptc 里找不到 id=compaction 的组");
    const idx = group.config.findIndex((p) => p.id === "compaction-basic");
    if (idx < 0) throw new Error("compaction 组里找不到 compaction-basic");
    group.config[idx] = {
        id: "tiered-compaction",
        name: pluginName,
        config: { enabled: true, archiveDir },
    };
    return tc;
}

/**
 * 构造可稳定序列化的文本。
 * 关键：plan-mode 的 section 是多行中文块，js-yaml 会按 lineWidth 折行，
 * 而原 dump 用的是另一种折行（DSH 自己的序列化）。为保证产物稳定且幂等，
 * 把长块统一改成 YAML 的 "|-" 字面块（保留原文、不折行）。
 */
function stabilize(node) {
    if (Array.isArray(node)) return node.map(stabilize);
    if (node && typeof node === "object") {
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            // 多行字符串转成显式块标量，避免 js-yaml 折行带来的不确定性
            if (typeof v === "string" && v.includes("\n")) {
                out[k] = new yaml.Type("tag:yaml.org,2002:str", {}) && v;
            } else {
                out[k] = stabilize(v);
            }
        }
        return out;
    }
    return node;
}

const dumpText = readFileSync(dumpPath, "utf8");
// 包名一律从「这台机器实际装了什么」推导，禁止硬编码（见 tools/lib/plugin-name.mjs 顶部事故说明）。
const pluginName = resolvePluginName({ profileDir, override: pluginNameOverride, dumpText });
console.log(`插件包名（从已装包推导）: ${pluginName}`);

const { entry: ptc } = loadPtc(dumpText);
const tc = buildPtcTc(ptc, pluginName);

/* ---------------- 自检：递归 diff ---------------- */
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

const compIdx = ptc.config.plugins.findIndex((p) => p.id === "compaction");
const raw = diffTree(ptc, tc);

// config 对象整体新增时展开成叶子，便于精确断言
const flat = [];
for (const d of raw) {
    if (d.path.endsWith(".config") && d.from === "__MISSING__" && d.to && typeof d.to === "object") {
        for (const [k, v] of Object.entries(d.to)) flat.push({ path: `${d.path}.${k}`, from: "__MISSING__", to: v });
    } else {
        flat.push(d);
    }
}

const base = `(root).config.plugins[${compIdx}].config[0]`;
const expected = [
    { path: "(root).id", to: "preset-ptc-tc" },
    { path: "(root).config.id", to: "ptc-tc" },
    { path: "(root).config.order", to: order },
    { path: "(root).config.description", to: "基于官方 ptc，仅换装 tiered-compaction 四层压缩引擎，层 1-4 全开" },
    { path: `${base}.id`, to: "tiered-compaction" },
    { path: `${base}.name`, to: pluginName },
    { path: `${base}.config.enabled`, to: true },
];
const archivePath = `${base}.config.archiveDir`;

const problems = [];
if (flat.length !== expected.length + 1) {
    problems.push(`展开后差异 ${flat.length} 处，预期 ${expected.length + 1}（含 description/archiveDir）`);
}
for (const exp of expected) {
    const hit = flat.find((d) => d.path === exp.path);
    if (!hit) problems.push(`缺少预期差异 ${exp.path}`);
    else if (JSON.stringify(hit.to) !== JSON.stringify(exp.to)) {
        problems.push(`${exp.path} 目标值应为 ${JSON.stringify(exp.to)}，实际 ${JSON.stringify(hit.to)}`);
    }
}
const adHit = flat.find((d) => d.path === archivePath);
if (!adHit) problems.push(`缺少预期差异 ${archivePath}`);
else if (typeof adHit.to !== "string" || adHit.to.length === 0) problems.push(`${archivePath} 应为非空字符串`);
for (const d of flat) {
    if (!expected.some((e) => e.path === d.path) && d.path !== archivePath) {
        problems.push(`出现预期之外的差异 ${d.path}`);
    }
}

console.log("=== 差异明细（ptc → ptc-tc）===");
flat.forEach((d) => console.log(`  ${d.path}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`));
console.log(`  展开后差异条数: ${flat.length}`);

if (flag === "--diff-only") {
    if (problems.length) {
        console.log("\n=== 自检失败 ===");
        problems.forEach((p) => console.log("  ✖ " + p));
        process.exit(1);
    }
    console.log(`\n=== 自检通过：差异恰好 ${expected.length + 1} 处，全部符合预期 ===`);
    process.exit(0);
}

if (problems.length) {
    console.log("\n=== 自检失败，不写产物 ===");
    problems.forEach((p) => console.log("  ✖ " + p));
    process.exit(1);
}

/* ---------------- 写产物 ---------------- */
const header = [
    "# ══ D15 B 路线：自有 ptc-tc preset（只换压缩引擎为 tiered-compaction）══",
    "# 本区块由 tools/gen-ptc-tc.ps1 生成，请勿手工编辑；DSH 升级后重跑脚本重同步。",
    "# 回退：删掉本段 + 把 agent-preset-registry 的 selectedDefault 改回 ptc",
];
const body = yaml.dump([{ insert: [tc] }], {
    lineWidth: -1,       // 不折行：避免长中文块换行位置随版本变化导致产物不稳定
    noRefs: true,
    schema: SCHEMA,
});
assertNoStaleScopeNames(body, pluginName);
writeFileSync(outPath, header.join("\n") + "\n" + body, "utf8");

console.log(`\n=== 自检通过，产物已写入 ${outPath} ===`);
process.exit(0);
