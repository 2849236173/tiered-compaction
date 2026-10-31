/**
 * 目标切换旁路（goal-switch purge）：确定性清理，全程零 LLM 调用（A5）。
 *
 * 触发（铁律：只挂显式信号，不做语义自动识别）：
 *   调用方显式传入 {oldGoal, newGoal} 结构化事件才执行。
 *
 * 动作：
 *   1. 旧目标的 todo/goal/plan 关键状态打包成结构化胶囊（并入新上下文）；
 *   2. 过程性内容（大输出、中间产物）归档到会话目录（复用第 2 层落盘）；
 *   3. 全部取代关系登记谱系表。
 */
import { Lineage, nodeLocation } from "./lineage.js";
import { spillIfNeeded } from "./spill-to-disk.js";

/**
 * 执行一次目标切换清理。
 *
 * @param {{oldGoalId: string, newGoalId: string, nodes: Array<{seq: number, kind: string, content: string}>}} event
 *   显式切换事件：oldGoalId/newGoalId 必填（无显式信号则抛错，防语义误判）。
 * @param {{archiveDir: string, lineage?: Lineage}} deps
 * @returns {Promise<{capsule: object, archived: string[], llmCalls: 0}>}
 *   capsule：结构化胶囊（旧目标状态）；archived：过程内容存档路径清单；llmCalls 恒为 0（A5）。
 */
export async function purgeOnGoalSwitch(event, deps) {
    if (!event?.oldGoalId || !event?.newGoalId) {
        throw new Error("goal-switch: 缺显式信号（oldGoalId/newGoalId），拒绝执行——本旁路不做语义自动识别");
    }
    const lineage = deps.lineage ?? new Lineage();

    // 1) 胶囊：旧目标相关的 todo/goal/plan 节点按 seq 原样打包（关键状态零丢失）
    const capsuleNodes = event.nodes.filter((node) => ["todo", "goal", "plan"].includes(node.kind));
    const capsule = {
        oldGoalId: event.oldGoalId,
        newGoalId: event.newGoalId,
        carriedNodes: capsuleNodes.map((node) => ({ seq: node.seq, kind: node.kind, content: node.content })),
    };

    // 2) 过程性内容归档（>0 即落盘，复用第 2 层机制）
    const archived = [];
    const processNodes = event.nodes.filter((node) => !["todo", "goal", "plan"].includes(node.kind));
    for (const node of processNodes) {
        const spill = await spillIfNeeded(node.content, deps.archiveDir, `goal-switch-${event.oldGoalId}-node${node.seq}`, { threshold: 1 });
        if (spill) {
            archived.push(spill.path);
            lineage.record(nodeLocation(node.seq, event.sessionId), spill.path, "goal-switch", spill.sha256);
        } else {
            lineage.record(nodeLocation(node.seq, event.sessionId), "-", "goal-switch-dropped-short");
        }
    }

    // 胶囊携带的节点也登记（取代者=goal-switch-capsule，可审计）
    for (const node of capsuleNodes) {
        lineage.record(nodeLocation(node.seq, event.sessionId), `capsule:${event.newGoalId}`, "goal-switch-capsule");
    }

    return { capsule, archived, llmCalls: 0 };
}
