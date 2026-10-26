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
 * 压缩余量（token）：阈值之外还要留这么多，避免压缩事务本身撞窗。
 * 取原版 basic 的 `headroomTokens` 默认值 65536（dsh-compaction-basic:63），
 * 这是上游验证过的安全余量，不自行发明数字。
 */
export const HEADROOM_TOKENS = 65536;

/**
 * 计算压力阈值（第 4 层触发线）——**比例与绝对余量双约束取小**。
 *
 * 为什么改成双约束（D17 对照原版 basic 后的择优结论）：
 *
 *   旧公式：`窗口 − max(16k, 5%) − 20k`，纯绝对值。
 *             128k → 92,000（72%）、1M → 930,000（93%）
 *             问题：窗口越大触发越晚，1M 窗口要等到 93% 才压缩，
 *             留给摘要事务的空间被压到极限。
 *
 *   原版：   `min(窗口 × thresholdRatio, 窗口 − 输出预留 − headroom)`
 *             ratio 默认 0.85、headroom 65536。
 *             128k → 62,464（49%）、1M → 850,000（85%）
 *             问题：窗口小于约 100k 时 headroom 吃掉全部压力预算，直接抛错。
 *
 *   择优合成：两条线都算，取**较小者**——
 *     - 大窗口由比例线主导，压缩更及时（学原版的 0.85 上限）
 *     - 小窗口由绝对线主导，永远不会算成负数（保留我们自己的护栏）
 *     - 窗口无效时返回 Infinity，永不触发（宁可不动，不反向强触发）
 *
 * @param {number} contextWindow 模型上下文窗口（token）
 * @param {{thresholdRatio?: number, headroomTokens?: number, reserveTokens?: number}} [options]
 * @returns {number} 触发有损摘要的压力阈值（token）
 */
export function lossyThreshold(contextWindow, options = {}) {
    // 窗口无效（0/负数/非数）时不触发：宁可不动，也不能反向强触发
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return Number.POSITIVE_INFINITY;

    const ratio = options.thresholdRatio ?? 0.85;
    const headroom = options.headroomTokens ?? HEADROOM_TOKENS;
    const reserve = options.reserveTokens ?? RESERVE_TOKENS;

    // 比例线：不超过 window × ratio（给压缩事务留出确定空间）
    const byRatio = Math.floor(contextWindow * ratio);

    // 绝对线：窗口 − 摘要预留 − headroom。
    // ≤0 表示窗口连「一次摘要的预留 + 压缩余量」都装不下——
    // 此时比例线本身已经不安全，需要把触发线压低到 60% 档。
    const byAbsolute = contextWindow - reserve - headroom;

    // 目标占比：装得下就 85%，装不下就抬到「不与第 3 层抢跑」的下限。
    //
    // 层次底线（本公式最重要的约束，2026-10-27 与用户共同定案）：
    //   第 3 层：70% 提醒 → 80% 驱逐（驱逐可重放的 read/grep 结果，最便宜）
    //   第 4 层：有损摘要，最贵，必须晚于 80% 驱逐之后。
    //   否则驱逐永远轮不到执行，等于少了一层——四层递进是本插件相对 basic 的
    //   核心价值，不能为了「摘要更从容」把它牺牲掉。
    //
    // 实测教训链（这条约束是三轮实测才收敛的）：
    //   初版下限 60% → 100k 窗口 60.7%、200k 窗口 65.9%，抢在 70% 提醒前面；
    //   改为 72% → 200k 窗口 75.1%，仍抢在 80% 驱逐前面，A12② 报「80% 驱逐不动
    //   会话表面」失败；
    //   最终取 82%：留 2 个百分点缓冲，确保 80% 驱逐先发生。
    const FLOOR_RATIO = 0.82;

    // 过渡带下沿：窗口 = reserve + headroom（绝对线 = 0）
    // 过渡带上沿：窗口 × ratio = 窗口 − reserve − headroom
    //            → 窗口 = (reserve + headroom) / (1 − ratio)
    const lowerEdge = reserve + headroom;
    const upperEdge = Math.ceil(lowerEdge / (1 - ratio));

    if (contextWindow <= lowerEdge) {
        // 窗口装不下 reserve+headroom：比例线也不安全。
        // 但仍不许低于 FLOOR_RATIO，否则又抢跑第 3 层。
        return Math.floor(contextWindow * FLOOR_RATIO);
    }
    if (contextWindow >= upperEdge) {
        // 空间充裕：直接比例线
        return byRatio;
    }
    // 过渡带：占比在 [FLOOR_RATIO, ratio] 之间线性插值，消除断崖
    const progress = (contextWindow - lowerEdge) / (upperEdge - lowerEdge);
    const blendedRatio = FLOOR_RATIO + progress * (ratio - FLOOR_RATIO);
    return Math.floor(contextWindow * blendedRatio);
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
