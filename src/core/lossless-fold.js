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
            // start 记**原文中的行号**（不是输出数组下标）。
            // 审计指出旧写法存 out.length，语义错且从不被读取。
            runs.push({ line, start: i, count: runLen });
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
    if (record === null || typeof record !== "object" || !Array.isArray(record.runs)) {
        throw new Error("lossless-fold: 折叠记录缺失或格式不对，拒绝逆变换");
    }
    // 真正的逆变换：**按 runs 重建**，而不是相信 record.original。
    //
    // P0 审计发现（2026-10-27）：旧实现自校验后直接 `return record.original`，
    // 即"还原"只是把保存的原文吐回来，runs 从头到尾没参与重建。
    // 后果（实测）：把 runs 清空 / count 改小 / start 改成 999，
    // 三种篡改**全部通过**——所谓自校验形同虚设。
    //
    // 现在改为：把折叠文本按行扫一遍，遇到折叠标记就按 runs 里的 count
    // 展开成 N 行原文。任何不一致都拒绝。
    const markerPattern = new RegExp(`^${FOLD_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)x\\]$`);
    const foldedLines = folded.split("\n");
    const out = [];
    let runIndex = 0;
    for (const line of foldedLines) {
        const marker = markerPattern.exec(line);
        if (marker === null) {
            out.push(line);
            continue;
        }
        const count = Number(marker[1]);
        const run = record.runs[runIndex];
        if (run === undefined) {
            throw new Error(`lossless-fold: 第 ${runIndex + 1} 个折叠标记在记录里没有对应项`);
        }
        if (run.count !== count) {
            throw new Error(
                `lossless-fold: 折叠标记声明 ${count} 行，记录里是 ${run.count} 行（记录与文本不一致）`,
            );
        }
        // 必须紧邻上一行：标记展开的就是它前面那一行
        if (out.length === 0 || out[out.length - 1] !== run.line) {
            throw new Error("lossless-fold: 折叠标记前一行与记录里的重复行不一致");
        }
        for (let k = 1; k < count; k += 1) out.push(run.line);
        runIndex += 1;
    }
        if (runIndex !== record.runs.length) {
        throw new Error(
            `lossless-fold: 记录里有 ${record.runs.length} 个折叠组，文本里只解析出 ${runIndex} 个`,
        );
    }
    const rebuilt = out.join("\n");
    // 终检：重建结果重新折叠必须还原出传入的 folded（双向一致）
    if (foldRepeatedLines(rebuilt).folded !== folded) {
        throw new Error("lossless-fold: 重建结果与 folded 文本不自洽，拒绝返回");
    }
    // 位置校验：record.runs[i].start 记的是**原文中的行号**（从 0 起）。
    // 审计指出旧实现里 start 存的是输出数组下标、且从不被读取——
    // 既是死字段，语义又是错的。现在按原文行号校验，让它真正起作用。
    if (record.runs.some((run) => typeof run?.start === "number")) {
        const rebuiltLines = rebuilt.split("\n");
        let lineNo = 0;
        for (const run of record.runs) {
            // 找到该重复行的首次出现位置（从上一个组之后开始找）
            while (lineNo < rebuiltLines.length && rebuiltLines[lineNo] !== run.line) lineNo += 1;
            if (lineNo >= rebuiltLines.length) {
                throw new Error(`lossless-fold: 记录里的重复行在重建结果中找不到（第 ${run.start} 行）`);
            }
            if (typeof run.start === "number" && run.start !== lineNo) {
                throw new Error(
                    `lossless-fold: 折叠记录的位置 ${run.start} 与重建结果的实际位置 ${lineNo} 不符`,
                );
            }
            lineNo += run.count;
        }
    }
    // 若记录附带了 original，必须与重建结果逐字一致（防止记录与文本被同时篡改）
    if (typeof record.original === "string" && record.original !== rebuilt) {
        throw new Error("lossless-fold: 重建结果与记录中的原文不一致，拒绝返回");
    }
    return rebuilt;
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
