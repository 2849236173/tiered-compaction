/**
 * 四层管线引擎（M4.5 wiring）：按设计稿 §1 顺序串四层。
 *
 * 本模块只做接线编排，不含业务逻辑：四层各自可独立验证（M3/M4 单测），
 * 这里把它们按「工具输出 → 无损折叠 → 落盘>8k → 软压力 → 有损摘要」顺序
 * 串到 TieredCompactionService 上。目标切换旁路与熔断器按 M4 设计挂入，
 * 谱系表贯穿（保真原则 2：任何取代关系可审计）。
 *
 * 纯接线边界（PO 口径）：不新增业务逻辑、不改 M2-M5 任何既有代码。
 */
import { CircuitBreaker, arbitrate } from "./circuit-breaker.js";
import { pressureAction, evictVolatile } from "./soft-pressure.js";
import { lossyThreshold, summarizeSpan } from "./lossy-summarize.js";
import { Lineage } from "./lineage.js";

/**
 * 引擎依赖注入（全部由构造方提供，模块自身零环境依赖）：
 * - archiveDir：落盘存档目录
 * - tokenMeter: { currentTokens(), contextWindow() } 压力读数（第 3/4 层）
 * - summarizeFn：第 4 层摘要实现（测试注入假 LLM，宿主注入 ctx.llm 封装）
 * - summaryTarget：{ provider, model } 摘要路由
 * - logger：{ info, warn }
 */
export class TieredCompactionEngine {
    /**
     * @param {{
     *   archiveDir: string,
     *   tokenMeter?: { currentTokens(): number, contextWindow(): number },
     *   summarizeFn?: (req: {maxTokens: number}, text: string, signal?: AbortSignal) => Promise<string>,
     *   summaryTarget?: { provider: string, model: string },
     *   logger?: { info(msg: string): void, warn(msg: string): void },
     * }} deps
     */
    constructor(deps) {
        this.deps = deps;
        this.logger = deps.logger ?? { info() {}, warn() {} };
        /** 谱系表贯穿四层与旁路（A10）。 */
        this.lineage = new Lineage();
        /** 落盘层熔断器（A7）：单层连续失败自动降级，主流程不炸。 */
        this.spillBreaker = new CircuitBreaker({
            name: "spill-to-disk",
            onOpen: (name, err) => this.logger.warn(`tiered-compaction: ${name} 熔断：${err?.message ?? err}`),
        });
    }

    /**
     * 处理一段工具输出（§1 第 1-2 层：无损折叠 → 落盘>8k，经仲裁器短路）。
     * @param {string} text 原始工具输出
     * @param {{seq: number|string}} at 内容位置
     * @returns {Promise<{text: string, layers: string[]}>}
     */
    async processToolOutput(text, at) {
        // 仲裁器（M4）：先折叠、折叠后仍 >8k 才落盘，一份内容只归一层。
        return arbitrate(text, at, {
            archiveDir: this.deps.archiveDir,
            lineage: this.lineage,
            spillBreaker: this.spillBreaker,
        });
    }

    /**
     * 第 3 层软压力：70% 提醒（不改历史）、80% 驱逐易失内容。
     * @param {Array<{seq: number, kind: string, tool?: string, content: string}>} nodes 当前会话节点
     * @returns {Promise<{"action": "none"|"remind"|"evict", evicted?: Array, kept?: Array, reminder?: string}>}
     */
    async applySoftPressure(nodes) {
        const meter = this.deps.tokenMeter;
        if (!meter) return { action: "none" };
        const window = meter.contextWindow();
        const current = meter.currentTokens();
        const pressure = window > 0 ? current / window : 0;
        const action = pressureAction(pressure);
        if (action === "none") return { action };

        if (action === "remind") {
            const reminder =
                `[tiered-compaction] 窗口压力 ${(pressure * 100).toFixed(0)}%（70%）：` +
                `历史工具输出已折叠/落盘，建议收束当前任务。`;
            this.logger.info(reminder);
            return { action, reminder };
        }

        // evict：驱逐易失内容（§3 优先级表在 soft-pressure 内），谱系登记在层内完成
        const { evicted, kept } = evictVolatile(nodes, { lineage: this.lineage });
        this.logger.warn(
            `tiered-compaction: 窗口压力 ${(pressure * 100).toFixed(0)}%（80%），驱逐 ${evicted.length} 个易失节点` +
            `（可重放 ${evicted.filter((e) => e.replayable).length} 个）`
        );
        return { action, evicted, kept };
    }

    /**
     * 第 4 层有损摘要：压力阈值 = 窗口 − max(16k, 5%窗口) − 摘要预留(≤20k)，
     * 仅 enabled 且到阈值才调用（摘要预算提前预留，A4a）。
     * @param {Array<{seq: number, kind: string, content: string}>} span 待摘要历史区间
     * @returns {Promise<{summary: string, archivePath: string, budget: number} | null>}
     *   null = 未启用摘要或未到阈值。
     */
    async summarizeIfNeeded(span) {
        const { tokenMeter, summarizeFn, summaryTarget } = this.deps;
        if (!tokenMeter || !summarizeFn || !summaryTarget) return null;
        const threshold = lossyThreshold(tokenMeter.contextWindow());
        if (tokenMeter.currentTokens() < threshold) return null;
        // 全量存档 → 带预算摘要 → 谱系登记（都在 summarizeSpan 内，M4 已验证）
        const result = await summarizeSpan(span, summarizeFn, {
            archiveDir: this.deps.archiveDir,
            lineage: this.lineage,
        }, summaryTarget);
        this.logger.info(`tiered-compaction: 有损摘要完成（budget=${result.budget}），已登记谱系`);
        return result;
    }

    /**
     * 目标切换旁路（§1 旁路管线）：显式信号驱动的确定性清理，零 LLM。
     * @param {{oldGoalId: string, newGoalId: string, nodes: Array}} event
     */
    async purgeOnGoalSwitch(event) {
        const { purgeOnGoalSwitch } = await import("./goal-switch.js");
        return purgeOnGoalSwitch(event, { archiveDir: this.deps.archiveDir, lineage: this.lineage });
    }

    /** 引擎自检面：谱系条数 + 熔断器状态（供探针/告警，不进业务路径）。 */
    status() {
        return {
            lineageEntries: this.lineage.toArray().length,
            spillBreaker: this.spillBreaker.state,
        };
    }
}
