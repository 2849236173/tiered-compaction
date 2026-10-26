/**
 * 有损摘要层（第 4 层，最后手段）+ 摘要预算预留。
 *
 * A4a（硬验证项）：摘要调用的输出预算必须显式预留 ≥ RESERVE_TOKENS，
 * 从根上杜绝 basic 实测的 2,048 截断（预算由调用参数写死，可对参数断言）。
 * 摘要前先全量存档（保真原则 1），摘要成功后登记谱系表。
 */

/** 摘要输出预算预留（token）：设计稿 §1 第 4 层要求 ≤20k 且必须预留。 */
export const RESERVE_TOKENS = 20000;

/**
 * 计算压力阈值：压力阈值 = 窗口 − max(16k, 5%窗口) − 摘要预留。
 * 与设计稿公式一致，是第 4 层触发线的唯一算法。
 *
 * **必须有下限保护**（D16 实锤）：小窗口下公式会算成负数（128k 窗口时为
 * 92,000 正常，但窗口读成 0 或很小则变负数，`current >= 负数` 恒真 →
 * 每一步都强行触发摘要事务、每步都失败）。这里取窗口的 60% 作为最低触发线，
 * 保证「阈值永远是一个有意义的正数，且永远高于第 3 层的 80% 不冲突」。
 * @param {number} contextWindow 模型上下文窗口（token）
 * @returns {number} 触发有损摘要的压力阈值（token）
 */
export function lossyThreshold(contextWindow) {
    // 窗口无效（0/负数/非数）时不触发：宁可不动，也不能反向强触发
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Number.POSITIVE_INFINITY;
    const guard = Math.max(16000, Math.floor(contextWindow * 0.05));
    const formula = contextWindow - guard - RESERVE_TOKENS;
    // 公式算成非正数说明窗口小于「保护量 + 预算」，此时期望值是窗口的六成
    const floor = Math.floor(contextWindow * 0.6);
    return Math.max(formula, floor);
}

/**
 * 构造一次摘要调用的参数（A4a 硬验证面：budget 必须等于 RESERVE_TOKENS）。
 * @param {{provider: string, model: string}} target 摘要用的模型路由
 * @returns {{provider: string, model: string, maxTokens: number, purpose: string}}
 */
export function summarizationRequest(target) {
    return {
        provider: target.provider,
        model: target.model,
        maxTokens: RESERVE_TOKENS,
        purpose: "compaction",
    };
}

/**
 * 执行一次有损摘要的完整流程（M4 内存版；接入 ctx.llm 在 M6 前完成）。
 * 流程：全量存档 → 调 LLM 摘要（budget 预留）→ 登记谱系表。
 * summarizeFn 由调用方注入（测试注入假 LLM，宿主注入 ctx.llm 封装），
 * 本模块不直接依赖网络，保证可离线验证（A4a/A5 同口径）。
 *
 * @param {Array<{seq: number, kind: string, content: string}>} span 待摘要的历史区间
 * @param {(req: {maxTokens: number}, text: string, signal?: AbortSignal) => Promise<string>} summarizeFn 摘要实现
 * @param {{archiveDir: string, lineage: import('./lineage.js').Lineage, sessionId?: string}} deps
 * @param {{provider: string, model: string}} target
 * @returns {Promise<{summary: string, archivePath: string, budget: number}>}
 */
export async function summarizeSpan(span, summarizeFn, deps, target) {
    // 第一步：摘要前全量存档（保真原则 1：第 4 层摘要前全量存档，A4 依据）
    const { spillIfNeeded, sha256 } = await import("./spill-to-disk.js");
    const full = span.map((node) => `[node#${node.seq} ${node.kind}] ${node.content}`).join("\n");
    const digest = sha256(full);
    const archive = await spillIfNeeded(full, deps.archiveDir, `summary-archive-${digest.slice(0, 12)}`, { threshold: 1 });
    // 第二步：带预算预留的摘要调用（A4a：budget 写死，杜绝截断）
    const request = summarizationRequest(target);
    const summary = await summarizeFn(request, full);
    if (summary.length === 0) throw new Error("lossy-summarize: 摘要结果为空，拒绝提交");
    // 第三步：登记谱系（被取代引用记谱系，不静默删）
    deps.lineage.record(
        `session#${deps.sessionId ?? "current"} span[${span[0]?.seq}-${span[span.length - 1]?.seq}]`,
        archive?.path ?? "-",
        "lossy-summarize",
        digest,
    );
    return { summary, archivePath: archive?.path ?? "-", budget: request.maxTokens };
}
