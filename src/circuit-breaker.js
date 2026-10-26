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
    // 第 1 层：无损折叠（纯内存，不设熔断；异常原样上抛属实现缺陷）
    const { folded, record } = foldRepeatedLines(text);
    let current = folded;
    if (record.runs.length > 0) {
        layers.push("lossless-fold");
        lineage.record(`node#${at.seq}`, `fold:${at.seq}`, "lossless-fold");
    }
    // 第 2 层：落盘（带熔断；>8k 字节才触发，仲裁器保证不与其它层重复处理）
    // P3-1：阈值口径统一为 UTF-8 字节数，与 spillIfNeeded 内部判断一致
    if (byteLength(current) > DEFAULT_SPILL_THRESHOLD) {
        const name = spillBaseName(at);
        const spill = deps.spillBreaker
            ? await deps.spillBreaker.exec(() => spillIfNeeded(current, deps.archiveDir, name))
            : await spillIfNeeded(current, deps.archiveDir, name);
        if (spill) {
            layers.push("spill-to-disk");
            lineage.record(`node#${at.seq}`, spill.path, "spill-to-disk", spill.sha256);
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
