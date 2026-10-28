/**
 * 熔断器 + 仲裁器（保真原则 3）。
 *
 * 熔断器：单层连续失败达到阈值即熔断该层（自动降级跳过 + 告警回调），
 * 主流程绝不被压缩层故障阻断（验收 A7：人为制造落盘失败必须降级不炸主流程）。
 * 半开探测：熔断后冷却期过去，放一次试探调用，成功即恢复。
 *
 * 仲裁器：一份内容只归一层处理，避免多层重复加工——按「先折叠、再落盘、
 * 软压力最后」的顺序短路：折叠后已 ≤ 阈值的内容不再落盘。
 */
import { foldRepeatedLines } from "./lossless-fold.js";
import { spillIfNeeded, DEFAULT_SPILL_THRESHOLD, byteLength } from "./spill-to-disk.js";

/**
 * 单层熔断器。
 */
export class CircuitBreaker {
    /**
     * @param {{name: string, threshold?: number, cooldownMs?: number, onOpen?: (name: string, err: Error) => void}} options
     */
    constructor(options) {
        this.name = options.name;
        this.threshold = options.threshold ?? 3;
        this.cooldownMs = options.cooldownMs ?? 30000;
        this.onOpen = options.onOpen ?? (() => {});
        /** @type {"closed" | "open" | "half-open"} */
        this.state = "closed";
        this.failures = 0;
        this.openedAt = 0;
    }

    /**
     * 受保护执行：closed 放行；open 且冷却未过直接拒绝（调用方降级）；
     * half-open 放一次试探，成功恢复 closed，失败重回 open。
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T | null>} null 表示已熔断，调用方应跳过该层降级
     */
    async exec(fn) {
        if (this.state === "open") {
            if (Date.now() - this.openedAt < this.cooldownMs) return null;
            this.state = "half-open"; // 冷却已过，放一次试探
        }
        try {
            const result = await fn();
            this.failures = 0;
            this.state = "closed";
            return result;
        } catch (err) {
            this.failures += 1;
            if (this.state === "half-open" || this.failures >= this.threshold) {
                this.state = "open";
                this.openedAt = Date.now();
                this.onOpen(this.name, err);
            }
            return null;
        }
    }
}

/**
 * 仲裁器：对一段工具输出决定唯一处理层并执行（含谱系登记）。
 * 顺序：先无损折叠；折叠后仍 >8k 才落盘；都不需要则原样返回。
 *
 * @param {string} text 工具输出
 * @param {{seq: number|string, sessionId?: string}} at 内容在会话中的位置（sessionId 可选，用于文件名去重）
 * @param {{archiveDir: string, lineage: import('./lineage.js').Lineage, spillBreaker?: CircuitBreaker}} deps
 * @returns {Promise<{text: string, layers: string[]}>} 处理后文本与实际命中的层清单
 */
export async function arbitrate(text, at, deps) {
    const lineage = deps.lineage;
    const layers = [];
    // 第 1 层：无损折叠（纯内存变换，但**原文必须落盘**——见下方 P0 修复说明）
    const { folded, record } = foldRepeatedLines(text);
    let current = folded;
    if (record.runs.length > 0) {
        layers.push("lossless-fold");
        // P0-1（2026-10-27 系统审计）：折叠的原文必须持久化，否则「无损」不成立。
        //
        // 缺陷：旧实现只 `lineage.record(node#seq, "fold:1", ...)` ——
        // `fold:1` 不是文件路径、没有 digest，而 `record.original`
        // （含完整原文）被直接丢弃。实测：2599 字节原文折叠后，
        // 存档目录 **0 个文件**，原文只活在当次进程内存里。
        // 进程重启 → 原文永久丢失，「无损折叠」变成「不可逆丢失」。
        //
        // 修法：折叠发生时把**原文**落盘（threshold 设为 1，强制写入），
        // 谱系指向真实文件路径 + SHA-256。这样折叠产物在会话里省 token，
        // 而原文随时能从磁盘逐字节取回。
        let foldArchive = null;
        try {
            foldArchive = await spillIfNeeded(text, deps.archiveDir, spillBaseName(at), { threshold: 1 });
        } catch (error) {
            // 存档失败 → 放弃折叠（宁可原样返回，也不能留下不可恢复的损失）
            deps.logger?.warn?.(
                `tiered-compaction: 折叠存档失败，放弃本次折叠以保原文可恢复：${error?.message ?? error}`,
            );
            return { text, layers: [] };
        }
        if (foldArchive !== null) {
            lineage.record(`node#${at.seq}`, foldArchive.path, "lossless-fold", foldArchive.sha256);
            layers.push("fold-archive");
        } else {
            // threshold:1 下不该出现 null；真出现就视为存档失败，同样放弃折叠
            return { text, layers: [] };
        }
    }
    // 第 2 层：落盘（带熔断；>8k 字节才触发，仲裁器保证不与其它层重复处理）
    // P3-1：阈值口径统一为 UTF-8 字节数，与 spillIfNeeded 内部判断一致
    if (byteLength(current) > DEFAULT_SPILL_THRESHOLD) {
        const name = spillBaseName(at);
        // P0 审计（2026-10-27）：落盘必须写**原始文本**，不能写折叠产物。
        //
        // 缺陷：旧实现把 `current`（折叠后内容）传给 spillIfNeeded，而
        // `foldRepeatedLines` 返回的 `record`（含完整原文）被直接丢弃、
        // 从未持久化。实测：
        //   原文 17589 字节 → 磁盘 16429 字节，且磁盘内容含 `…[folded` 标记
        // → 「落盘 = 完整存档、可逐字节还原」这条安全底线是假的；
        //   要还原还得依赖当次进程内存里的折叠记录，进程重启后原文永久丢失。
        //
        // 修法：落盘传原始 `text`。折叠只作用于**回填表面的预览**，
        // 存档本身必须是能独立还原的原文。
        const spill = deps.spillBreaker
            ? await deps.spillBreaker.exec(() => spillIfNeeded(text, deps.archiveDir, name))
            : await spillIfNeeded(text, deps.archiveDir, name);
        if (spill) {
            layers.push("spill-to-disk");
            lineage.record(`node#${at.seq}`, spill.path, "spill-to-disk", spill.sha256);
            // 回填表面的仍是折叠后的预览（体积小，且够模型判断要不要回读）
            current = spill.preview;
        } else {
            layers.push("spill-to-disk:bypassed(circuit-open)");
        }
    }
    return { text: current, layers };
}

/**
 * 构造存档文件名主体（D17 验收 P0-1）。
 *
 * 旧实现只用 `arbitrated-${seq}`：seq 是**会话内**序号，不同会话必然重号，
 * 于是同名文件互相覆盖——先落盘的内容静默丢失，而谱系表仍指向该路径，
 * 回读得到的是别人的内容。
 *
 * 新规则带上会话短标识与时间戳，使跨会话同名概率降到可忽略：
 *   arbitrated-<session8>-<seq>-<base36 time>
 * 会话 id 缺失时退回旧格式——`spillIfNeeded` 内部还有「绝不覆盖」护栏兜底。
 *
 * @param {{seq: number|string, sessionId?: string}} at
 * @returns {string} 文件名主体（不含扩展名）
 */
function spillBaseName(at) {
    const seq = at.seq;
    const session = typeof at.sessionId === "string" ? at.sessionId : "";
    // 取会话 id 末 8 位：DSH 的 session id 形如 session-<uuid>，末段区分度足够
    const short = session.length >= 8 ? session.slice(-8) : "";
    const stamp = Date.now().toString(36);
    return short === "" ? `arbitrated-${seq}-${stamp}` : `arbitrated-${short}-${seq}-${stamp}`;
}
