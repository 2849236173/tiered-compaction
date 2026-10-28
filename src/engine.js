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
import { lossyThreshold } from "./lossy-summarize.js";
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
        const result = await arbitrate(text, at, {
            archiveDir: this.deps.archiveDir,
            lineage: this.lineage,
            spillBreaker: this.spillBreaker,
            logger: this.logger,
        });
        // 记下这次落盘的存档信息，供宿主替换事件写进预览（观察者取用）
        this.spillInfo ??= new Map();
        const entry = this.lineage.toArray().findLast(
            (item) => item.originalLocation === `node#${at.seq}` && item.replacedBy === "spill-to-disk",
        );
        if (entry !== undefined) {
            // D17 实测修复：原先只存 path + sha256，没存 size，预览因此显示
            // 「0 字节」而实际文件是 32KB——用户看到的第一条压缩提示就报错数。
            // 大小直接量落盘后的文件，保证与实物一致（不靠估算）。
            let size = 0;
            try {
                const { stat } = await import("node:fs/promises");
                size = (await stat(entry.newLocation)).size;
            } catch {
                // 文件已不在（外部清理）：保持 0，预览不显示误导性数字
            }
            this.spillInfo.set(`${at.sessionId ?? "?"}#${at.seq}`, {
                path: entry.newLocation,
                sha256: entry.digest,
                size,
            });
        }
        return result;
    }

    /**
     * 取某节点最近一次落盘的存档信息（无落盘返回 undefined）。
     *
     * 交叉审计修复（2026-10-27，gpt-6-astra 报、我实跑确认）：
     * 键原本只是裸 seq，而 seq 是**会话内**序号。两个会话都落盘 seq=1 时，
     * 后一个会覆盖前一个——实测会话 A 的元数据被 B 顶掉。
     * 文件名本身带会话标识、内容不会串，但**读到的元数据会是别人的**。
     *
     * @param {number|string} seq 节点 seq
     * @param {string} [sessionId] 会话标识；省略时按后缀匹配（兼容旧调用）
     * @returns {{path: string, sha256?: string, size?: number} | undefined}
     */
    lastSpillInfo(seq, sessionId) {
        if (sessionId !== undefined) return this.spillInfo?.get(`${sessionId}#${seq}`);
        const suffix = `#${seq}`;
        let hit;
        for (const [key, value] of this.spillInfo ?? []) {
            if (key.endsWith(suffix)) hit = value;
        }
        return hit;
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
