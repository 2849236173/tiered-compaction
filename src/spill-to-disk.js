/**
 * 第 2 层：落盘层（spill-to-disk）。
 *
 * 职责：超过阈值（默认 8,000 字符）的工具输出整体写入会话存档目录，
 * 上下文只保留 ≤1,500 字符预览 + 存档路径；写入后计算 SHA-256 供校验
 * （设计稿 §1 第 2 层 / 验收 A2）。写入失败由熔断器降级（见 circuit-breaker，M4 接入）。
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 默认落盘阈值（字符数）。 */
export const DEFAULT_SPILL_THRESHOLD = 8000;
/** 默认上下文预览上限（字符数），验收 A2 要求 ≤1500。 */
export const DEFAULT_PREVIEW_LIMIT = 1500;

/**
 * 计算文本的 SHA-256 十六进制摘要。
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 把超阈值文本落盘并生成预览。
 *
 * @param {string} text 待处理的工具输出
 * @param {string} archiveDir 存档目录（不存在则创建）
 * @param {string} baseName 存档文件名主体（建议带会话与序号，避免覆盖）
 * @param {{threshold?: number, previewLimit?: number}} [options]
 * @returns {Promise<null | {spilled: true, path: string, sha256: string, size: number, preview: string}>}
 *   未超阈值返回 null（调用方保持原文）；超阈值返回落盘结果。
 */
export async function spillIfNeeded(text, archiveDir, baseName, options = {}) {
    const threshold = options.threshold ?? DEFAULT_SPILL_THRESHOLD;
    const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
    if (text.length <= threshold) return null;

    await mkdir(archiveDir, { recursive: true });
    const path = join(archiveDir, `${baseName}.txt`);
    await writeFile(path, text, "utf8");
    const digest = sha256(text);
    const size = Buffer.byteLength(text, "utf8");
    const preview = text.length <= previewLimit ? text : text.slice(0, previewLimit);
    return { spilled: true, path, sha256: digest, size, preview };
}

/**
 * 回读存档并校验 SHA-256（恢复机制，保真原则 1：每层留恢复机制）。
 * @param {string} path 存档文件路径
 * @param {string} expectedSha256 期望摘要
 * @returns {Promise<string>} 校验通过时返回原文，否则抛错
 */
export async function restoreSpilled(path, expectedSha256) {
    const text = await readFile(path, "utf8");
    const digest = sha256(text);
    if (digest !== expectedSha256) {
        throw new Error(`spill-to-disk: SHA-256 校验失败 ${path} 期望 ${expectedSha256} 实得 ${digest}`);
    }
    return text;
}
