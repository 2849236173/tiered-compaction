/**
 * 软压力层（第 3 层）：70% 窗口插入提醒（不改历史）；80% 窗口驱逐易失内容。
 * 驱逐优先级按设计稿 §3：bash/edit/write 大输出 → read/grep/glob（可重放）→ 系统提醒；
 * todo/goal/plan/用户消息/摘要节点永不清理。被驱逐项一律登记谱系表（A10），
 * 可重放项标记 replayable 供重跑恢复（保真原则 1）。
 */

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
export function evictVolatile(nodes, deps) {
    const evicted = [];
    const kept = [];
    for (const node of nodes) {
        // 永不清理类直接保留（A3：todo/goal/plan/用户消息/摘要零丢失）
        const priority = EVICTION_PRIORITY[node.kind] ?? -1;
        if (priority === -1) {
            kept.push(node);
            continue;
        }
        const replayable = node.kind === "read" || node.kind === "grep" || node.kind === "glob";
        const reason = replayable ? "volatile-replayable" : "volatile-nonreplayable";
        deps.lineage.record(
            `node#${node.seq}`,
            "-（已驱逐，靠落盘存档/重放恢复）",
            "soft-pressure",
        );
        evicted.push({ seq: node.seq, reason, replayable });
    }
    return { evicted, kept };
}
