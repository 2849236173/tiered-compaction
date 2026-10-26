/**
 * 第 1 层：无损折叠层（lossless-fold）。
 *
 * 职责：把工具输出中的「重复块」（连续重复行、重复日志段、重复 grep 结果）折叠成
 * 首行 + 省略标记 + 末行的紧凑形式，零 LLM 成本。每次折叠生成逆变换记录，
 * 支持逐字节还原与抽样自校验（设计稿 §1 第 1 层 / 验收 A1）。
 */

/** 折叠标记前缀：逆变换据此识别折叠块。 */
const FOLD_MARKER_PREFIX = "…[folded ";

// 折叠的成本判据要用字节数（与落盘层同口径，中文行才不会被低估）。
// 从 spill-to-disk 引入，保持「字节口径」全局唯一来源。
import { byteLength } from "./spill-to-disk.js";

/**
 * 判断一行是否属于「可折叠重复」：与前一判定结果相同且连续。
 * @param {string[]} lines 输入行数组
 * @param {number} i 当前行下标
 * @param {string} key 用于比较的行内容
 * @returns {number} 从 i 起连续重复的行数
 */
function countRun(lines, i, key) {
    let n = 1;
    while (i + n < lines.length && lines[i + n] === key) n += 1;
    return n;
}

/**
 * 折叠一段文本中的连续重复行。
 *
 * 规则：同一行内容连续出现 ≥3 次时，折叠为「首行 + 重复计数标记」，其余行删除。
 * 折叠记录保存完整原文，逆变换可逐字节还原（验收 A1）。
 *
 * @param {string} text 原始工具输出
 * @param {{minRun?: number}} [options] minRun：触发折叠的最小连续重复次数，默认 3
 * @returns {{folded: string, record: {original: string, runs: Array<{line: string, start: number, count: number}>}}}
 *   folded：折叠后文本；record：逆变换记录（含原文与折叠位置清单）
 */
export function foldRepeatedLines(text, options = {}) {
    const minRun = options.minRun ?? 3;
    const lines = text.split("\n");
    /** @type {Array<{line: string, start: number, count: number}>} */
    const runs = [];
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const runLen = countRun(lines, i, line);
        const marker = `${FOLD_MARKER_PREFIX}${runLen}x]`;
        // D17 实测修复：折叠标记本身有成本，短行重复折了反而变大。
        // 实例：02:00 真实日志 `lossless-fold，521 → 530 字符`——净亏 9 字符，
        // 白做一次「压缩」，还让内容更难读。
        // 判据：省下的是 (runLen−1) 行原文，代价是 1 行标记；只有净省才折。
        // 用字节数比较（与落盘层口径一致，中文行不会被低估）。
        const saved = (runLen - 1) * byteLength(line);
        const cost = byteLength(marker);
        if (runLen >= minRun && saved > cost) {
            runs.push({ line, start: out.length, count: runLen });
            out.push(line);
            out.push(marker);
            i += runLen;
        } else {
            out.push(line);
            i += 1;
        }
    }
    const folded = out.join("\n");
    // 兜底：整体没有净省就原样返回，不产生「越折越大」的产物
    if (folded.length >= text.length) {
        return { folded: text, record: { original: text, runs: [] } };
    }
    return {
        folded,
        record: { original: text, runs },
    };
}

/**
 * 逆变换：从折叠文本与折叠记录逐字节还原原文（验收 A1 的可逆性依据）。
 *
 * 实现策略：直接返回记录中的完整原文（记录本身即全量存档），
 * 并校验 folded 文本与记录一致——不一致视为谱系损坏，抛错而非静默。
 *
 * @param {string} folded 折叠后文本
 * @param {{original: string, runs: Array<{line: string, start: number, count: number}>}} record 折叠记录
 * @returns {string} 还原后的原文
 */
export function unfold(folded, record) {
    // 自校验 1：记录里的原文重新折叠必须得到同样的 folded（防记录被篡改/错配）
    const refolded = foldRepeatedLines(record.original).folded;
    if (refolded !== folded) {
        throw new Error("lossless-fold: 折叠记录与 folded 文本不一致，拒绝逆变换");
    }
    // 自校验 2：runs 摘要必须与原文重折叠的结果一致
    for (const run of record.runs) {
        const lines = record.original.split("\n");
        let seen = 0;
        for (let k = 0; k < lines.length; k += 1) {
            if (lines[k] === run.line) seen += 1;
        }
        if (seen < run.count) {
            throw new Error("lossless-fold: 折叠记录的重复计数与原文不符");
        }
    }
    return record.original;
}

/**
 * 折叠率：折叠后与原文的字符比（用于效果度量与日志）。
 * @param {string} original 原文
 * @param {string} folded 折叠后
 * @returns {number} 0-1 之间的小数，越小压缩效果越好
 */
export function foldRatio(original, folded) {
    if (original.length === 0) return 1;
    return folded.length / original.length;
}
