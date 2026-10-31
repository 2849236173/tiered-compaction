/**
 * 软压力层（第 3 层）：70% 窗口插入提醒（不改历史）；80% 窗口驱逐易失内容。
 * 驱逐优先级按设计稿 §3：bash/edit/write 大输出 → read/grep/glob（可重放）→ 系统提醒；
 * todo/goal/plan/用户消息/摘要节点永不清理。被驱逐项一律登记谱系表（A10），
 * 可重放项标记 replayable 供重跑恢复（保真原则 1）。
 */
import { nodeLocation } from "./lineage.js";

/** 驱逐优先级表（设计稿 §3）：数值越小越先驱逐；-1 表示永不清理。 */
export const EVICTION_PRIORITY = {
    "bash": 1,
    "pwsh": 1,
    "edit": 1,
    "write": 1,
    "read": 2,
    "grep": 2,
    "glob": 2,
    "system-reminder": 3,
    "todo": -1,
    "goal": -1,
    "plan": -1,
    "user-message": -1,
    "summary": -1,
};

/** 70% 压力：只提醒，不改历史（A3 前半）。 */
export const REMIND_RATIO = 0.7;
/** 80% 压力：开始驱逐（A3 后半）。 */
export const EVICT_RATIO = 0.8;

/**
 * 依据当前压力决定动作。
 * @param {number} pressure 0-1 的窗口压力值（读数口径：ctx.tokenMeter / 自算，双跑一致）
 * @returns {"none" | "remind" | "evict"}
 */
export function pressureAction(pressure) {
    if (pressure >= EVICT_RATIO) return "evict";
    if (pressure >= REMIND_RATIO) return "remind";
    return "none";
}

/**
 * 对一批会话节点做一次 80% 驱逐。
 *
 * 节点形状（M4 fixture 范围的最小接口）：
 *   { seq, kind, tool?, content, removable? }
 *   kind ∈ EVICTION_PRIORITY 键；tool ∈ bash/pwsh/edit/write/read/grep/glob
 *
 * @param {Array<{seq: number, kind: string, tool?: string, content: string}>} nodes
 * @param {{lineage: import('./lineage.js').Lineage}} deps 谱系表（必传，驱逐必须可审计）
 * @returns {{evicted: Array<{seq: number, reason: string, replayable: boolean}>, kept: Array<object>}}
 *   evicted：被驱逐节点及其恢复方式；kept：保留节点（含永不清理项）
 */
export function evictVolatile(nodes, deps, options = {}) {
    const evicted = [];
    const kept = [];
    // 可选：本次还能腾出多少预算（token）。不传表示不限制（保持旧行为）。
    // 审计指出旧实现「一次清空全部命中项」——200 个 read 在压力刚过 80% 时全灭。
    let budget = Number.isFinite(options.budgetTokens) ? options.budgetTokens : Number.POSITIVE_INFINITY;
    // 按优先级数值升序真正排序（审计指出旧实现只判断"是否驱逐"，
    // 不决定"先驱逐谁"，实测出现 read(P2) 排在 bash(P1) 前面，与设计稿相反）。
    const ordered = [...nodes].sort((left, right) => {
        const a = EVICTION_PRIORITY[left.kind] ?? -1;
        const b = EVICTION_PRIORITY[right.kind] ?? -1;
        if (a === -1 && b === -1) return 0;
        if (a === -1) return 1;
        if (b === -1) return -1;
        return a - b;
    });
    for (const node of ordered) {
        // 永不清理类直接保留（A3：todo/goal/plan/用户消息/摘要零丢失）
        const priority = EVICTION_PRIORITY[node.kind] ?? -1;
        if (priority === -1) {
            kept.push(node);
            continue;
        }
        // A-P0-4（2026-10-27 系统审计）：**不可重放的内容不得驱逐**。
        //
        // 缺陷：旧实现把 bash/edit/write（优先级 1，设计稿明写"不可重放，
        // 依赖落盘存档"）也驱逐了，而谱系里写的只是一句占位文本
        // `-（已驱逐，靠落盘存档/重放恢复）`——**没有任何存档**。
        // 一旦真的丢掉，这份内容就永久消失（命令输出/写入结果无法重来）。
        //
        // 修法：只有可重放（read/grep/glob，重跑即恢复）才能无条件驱逐；
        // 不可重放的，必须调用方**已确认有存档**（node.archived === true）
        // 才允许驱逐，否则一律保留。
        const replayable = node.kind === "read" || node.kind === "grep" || node.kind === "glob";
        if (!replayable && node.archived !== true) {
            kept.push(node);
            continue;
        }
        // 预算：够了就停（避免一次清空全部）
        const cost = Number.isFinite(node.tokens) ? node.tokens : 0;
        if (budget <= 0) {
            kept.push(node);
            continue;
        }
        const reason = replayable ? "volatile-replayable" : "volatile-archived";
        deps.lineage.record(
            nodeLocation(node.seq, options.sessionId),
            replayable ? "-（可重跑恢复）" : String(node.archivePath ?? "-"),
            "soft-pressure",
        );
        evicted.push({ seq: node.seq, reason, replayable });
        budget -= cost;
    }
    return { evicted, kept };
}
