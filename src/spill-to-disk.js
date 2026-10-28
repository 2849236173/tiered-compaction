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
/**
 * 默认上下文预览上限（字符数）。
 *
 * **对齐原版 pruner**（dsh-compaction-tool-result-pruner lib/index.js:10-14）：
 * 原版预算是 headChars 4096 + 标记 + tailChars 1024 ≈ 5100+，
 * 这里取 5120 作为同一量级的单一上限（头 4096 + 尾 1000 + 标记余量 24）。
 * 曾经的 1500 过紧：比原版少 3.4 倍上下文，模型更容易回头重读文件。
 * 我们比原版多做的事——原文 100% 落盘存档——是「保留量可以更小」的资本，
 * 但用户拍板按原版量给足上下文（2026-10-28）。
 */
export const DEFAULT_PREVIEW_LIMIT = 5120;

/**
 * 生成「首尾各留一段」的预览（D17 验收 P2-1 建议，D20 对齐原版预算）。
 *
 * 为什么不能只留开头：工具输出的**结论常在末尾**——错误码、汇总行、
 * `exit code: N`、测试结果的 `pass/fail` 计数、git 的 `N files changed`。
 * 只留开头会让模型看到一堆中间过程却看不到结论，反而促使它重跑命令。
 *
 * 分配策略：头尾 4:1（对齐原版 pruner 的 4096:1024），头部为主但保留
 * 结论行；中间用一行标记说明省略了多少字符并可查存档。
 *
 * @param {string} text 原始文本
 * @param {number} limit 总字符上限
 * @returns {string} 首尾拼接的预览
 */
export function headTailPreview(text, limit = DEFAULT_PREVIEW_LIMIT) {
    // 非法 limit（NaN/负数/0）一律回落到默认值。
    // 审计实测：limit=NaN 时旧实现返回**空串**——模型看不到任何内容。
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_PREVIEW_LIMIT;
    if (text.length <= limit) return text;
    // 省略标记本身要计入总长——预览总长必须 ≤ limit（含标记），
    // 不能因为多插一行说明就超限。
    const markerReserve = 60; // "…[中间省略 N 字符，完整内容见下方存档]" 预留
    const budget = Math.max(0, limit - markerReserve);
    // 头尾 4:1（对齐原版 pruner 的 headChars 4096 : tailChars 1024）。
    // 曾经是 1:2（结论更重要）——原版选头部 4 倍于尾部，官方判断是
    // 开头（命令、参数、路径）信息量更大；2026-10-28 用户拍板照抄原版。
    const headSize = Math.floor((budget / 5) * 4);
    const tailSize = budget - headSize;
    // P1-4/P1-5（2026-10-27 系统审计）：切分必须落在**安全边界**上。
    //
    // 缺陷：裸 `slice` 按 UTF-16 code unit 切，会：
    //   · 把 emoji 的代理对劈成两半 → 产生孤立代理项 → 写文件变 U+FFFD
    //     （实测 limit 100..2000 中 1268 个取值会出问题）
    //   · 把 CRLF 劈开 → 头部以孤立 \r 结尾、尾部以孤立 \n 开头
    //     （实测 309 个取值）
    //
    // 修法：切点若落在代理对中间就挪一位；尾部若以孤立 \n 开头就再退一位
    // （那是被劈开的 CRLF 的后半）。
    const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

    let headEnd = headSize;
    // 头部：若切点前一字符是高代理（说明切点在代理对中间），少切一位
    if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
    // 头部：若以 \r 结尾而文本此处原本是 \r\n（CRLF 被劈开），少切一位
    if (headEnd > 0 && text[headEnd - 1] === "\r" && text[headEnd] === "\n") headEnd -= 1;
    const head = text.slice(0, headEnd);

    let tailStart = text.length - tailSize;
    // 尾部：若切点处是低代理（切点劈开了代理对），后移一位
    if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
    // 尾部：若以 \n 开头前一位是 \r（CRLF 被劈开），把 \n 也去掉
    if (tailStart < text.length && text[tailStart] === "\n" && text[tailStart - 1] === "\r") tailStart += 1;
    const tail = text.slice(tailStart);

    const omitted = text.length - head.length - tail.length;
    const marker = `\n…[中间省略 ${omitted} 字符，完整内容见下方存档]\n`;
    // 兜底：极端情况下（omitted 位数特别多）再裁一次，保证绝不超过 limit。
    // 裁尾会切到合法位置（尾部是纯文本片段），并且这里用 code point 安全切法。
    const composed = `${head}${marker}${tail}`;
    if (composed.length <= limit) return composed;
    let cut = limit;
    if (cut > 0 && isHighSurrogate(composed.charCodeAt(cut - 1))) cut -= 1;
    if (cut > 0 && composed[cut] === "\n" && composed[cut - 1] === "\r") cut -= 1;
    return composed.slice(0, cut);
}

/**
 * 计算文本的 SHA-256 十六进制摘要。
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 计算文本的 UTF-8 字节长度。
 *
 * 为什么不用 `text.length`：那是 JS 字符数（UTF-16 code unit），对中文/emoji
 * 会严重低估体积——8,000 个汉字约 24,000 字节，用字符数判断会让「8k 阈值」
 * 在大段中文输出上失效（D16 审计 P3-1）。阈值与 size 口径必须都是字节。
 * @param {string} text
 * @returns {number}
 */
export function byteLength(text) {
    return Buffer.byteLength(text, "utf8");
}

/**
 * 把超阈值文本落盘并生成预览。
 *
 * **绝不覆盖已有存档**（D17 验收 P0-1）：同名文件已存在时追加 `-2`/`-3`…
 * 直到找到空位。这条护栏放在本函数内而不是只靠调用方传对名字，因为
 * 存档是「压缩后唯一能还原原文的东西」——一旦被静默覆盖，谱系表仍指向
 * 该路径，回读会拿到**别人的内容**且无任何告警，属于越用越坏。
 *
 * @param {string} text 待处理的工具输出
 * @param {string} archiveDir 存档目录（不存在则创建）
 * @param {string} baseName 存档文件名主体（调用方应带会话与序号，减少冲突）
 * @param {{threshold?: number, previewLimit?: number}} [options]
 * @returns {Promise<null | {spilled: true, path: string, sha256: string, size: number, preview: string}>}
 *   未超阈值返回 null（调用方保持原文）；超阈值返回落盘结果。
 */
export async function spillIfNeeded(text, archiveDir, baseName, options = {}) {
    const threshold = options.threshold ?? DEFAULT_SPILL_THRESHOLD;
    const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
    // P3-1 修复：按 UTF-8 字节数比较，与落盘时写入的 size 口径一致
    if (byteLength(text) <= threshold) return null;

    // P0-3（2026-10-27 系统审计）：落盘前必须确认 UTF-8 往返无损。
    //
    // 缺陷：文本含**孤立代理项**（如 "\uD800"）时，`writeFile(...,"utf8")`
    // 会把它替换成 U+FFFD；而 `createHash().update(text,"utf8")` 做**同样的
    // 替换**——于是两个哈希相同，`restoreSpilled` 校验通过，但内容已经变了。
    //
    // 实测：9003 字节含 \uD800 的串，写盘读回后 !== 原串、含 U+FFFD，
    // 而 SHA-256 完全一致 → **校验通过、内容已变**，这是最坏的一种失败：
    // 它不报错，还盖了"已校验"的章。
    //
    // 处理：往返不一致就拒绝落盘（返回 null，调用方保持原文）。
    // 宁可少压缩一次，也不能存档一份被悄悄改过的内容。
    const probe = Buffer.from(text, "utf8");
    if (probe.toString("utf8") !== text) {
        return null;
    }

    await mkdir(archiveDir, { recursive: true });
    const path = await uniquePath(archiveDir, baseName);
    // 写二进制缓冲（与上面探测用的同一份编码结果），避免二次编码差异
    await writeFile(path, probe);
    const digest = sha256(text);
    const size = probe.length;
    // 预览首尾各留一段：结论常在末尾（错误码/汇总行/pass 计数），
    // 只留开头会让模型看不到结论、反而去重跑命令（D17 验收 P2-1）。
    const preview = headTailPreview(text, previewLimit);
    return { spilled: true, path, sha256: digest, size, preview };
}

/**
 * 找一个尚未被占用的存档路径（不覆盖任何已有文件）。
 *
 * 用 `wx` 标志原子地「创建或失败」，避免先检查后写入之间的竞态：
 * 两个并发落盘抢同一名字时，只有一个能建成，另一个自然落到下一个后缀。
 *
 * **交叉审计修复（2026-10-27，gpt-6-astra 报、我实跑确认）**：
 * baseName 可能来自外部输入（如 `goal-switch` 用 oldGoalId 拼名字），
 * 而 `join()` 只会规范化路径、**不会阻止 `../` 逃出目录**。
 * 实测：baseName = `goal-switch-../../../escaped-node1` 时，
 * 文件被写到了 archiveDir **外面**（`...\escaped-node1.txt`）。
 *
 * 修法：把 baseName 里的路径分隔符与 `..` 消毒掉，
 * 并最终断言解析后的绝对路径仍在 archiveDir 之内（双保险）。
 *
 * @param {string} archiveDir 存档目录
 * @param {string} baseName 文件名主体
 * @returns {Promise<string>} 可用路径
 */
async function uniquePath(archiveDir, baseName) {
    const { open } = await import("node:fs/promises");
    const { resolve, sep } = await import("node:path");
    // 消毒：去掉路径分隔符、父目录引用、以及 NUL 等控制字符，
    // 只保留文件系统上安全的字符（中文/字母/数字/._- 都保留）
    const safeName = String(baseName)
        .replace(/[\\/]+/g, "-")        // 分隔符 → 短横
        .replace(/\.\.+/g, ".")          // .. → .
        .replace(/[\u0000-\u001f]/g, "") // 控制字符
        .replace(/^\.+/, "")             // 别以点开头（隐藏文件/相对引用）
        .slice(0, 120) || "archive";     // 兜底 + 限长（Windows 路径上限）
    const rootAbs = resolve(archiveDir);
    for (let n = 1; n <= 1000; n += 1) {
        const name = n === 1 ? `${safeName}.txt` : `${safeName}-${n}.txt`;
        const candidate = join(archiveDir, name);
        // 双保险：解析后的绝对路径必须仍在 archiveDir 之内
        if (!resolve(candidate).startsWith(rootAbs + sep)) {
            throw new Error(`spill-to-disk: 存档名越出目录（已拒绝）：${name}`);
        }
        try {
            // wx：文件已存在则抛 EEXIST，绝不截断已有内容
            const handle = await open(candidate, "wx");
            await handle.close();
            return candidate;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
        }
    }
    throw new Error(`spill-to-disk: ${baseName} 连续 1000 个后缀都被占用，拒绝落盘以免覆盖`);
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
