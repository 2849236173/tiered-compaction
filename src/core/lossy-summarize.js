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

/** 合法的 thresholdRatio 区间下界：低于它就会抢在第 3 层 80% 驱逐之前。 */
export const MIN_THRESHOLD_RATIO = 0.82;

/** 合法的 thresholdRatio 区间上界：高于它触发点贴着窗口，摘要必然撞窗。 */
export const MAX_THRESHOLD_RATIO = 0.95;

/**
 * 已告警过的夹取组合（去重）：`lossyThreshold` 在每次 pre-step 都会跑，
 * 不去重会把日志刷爆，而刷爆的告警等于没有告警。
 * key 用「原值→结果」，同一个错误配置只提示一次。
 * @type {Set<string>}
 */
const warnedClamps = new Set();

/**
 * 夹取告警的落点。默认 `console.warn`，由调用方（contract.js）注入 ctx.logger。
 * 之所以做成可注入：本模块是纯函数模块，不持有 ctx；而 `lossyThreshold`
 * 又被多处调用，不能靠参数把 logger 一路传下去污染签名。
 * @type {(message: string) => void}
 */
let warn = (message) => console.warn(message);

/**
 * 注入告警落点（幂等）。插件 `apply()` 时调一次即可。
 * @param {(message: string) => void} sink 日志函数
 */
export function setThresholdWarnSink(sink) {
    if (typeof sink === "function") warn = sink;
}

/**
 * ratio 被夹取时留痕（每个组合只报一次）。
 * @param {number} raw 调用方传入的原值
 * @param {number} applied 实际生效值
 * @param {(m: string) => void} sink 日志函数
 */
export function warnClampedRatio(raw, applied, sink = warn) {
    // 卫语句：没被夹取就什么都不做，正常路径零开销
    if (!Number.isFinite(raw) || raw === applied) return;

    const key = `ratio:${raw}`;
    if (warnedClamps.has(key)) return;
    warnedClamps.add(key);

    sink(
        `tiered-compaction: thresholdRatio ${raw} 超出合法区间 ` +
        `[${MIN_THRESHOLD_RATIO}, ${MAX_THRESHOLD_RATIO}]，已按 ${applied} 生效。` +
        `低于 ${MIN_THRESHOLD_RATIO} 会抢在第 3 层 80% 驱逐之前，高于 ${MAX_THRESHOLD_RATIO} 摘要必然撞窗。` +
        `（如果你用第三方插件调这个值，注意它的滑块行程可能大部分落在这里）`
    );
}

/**
 * headroom 被夹取时留痕（每个组合只报一次）。
 * @param {number} raw 调用方传入的原值
 * @param {number} applied 实际生效值
 * @param {(m: string) => void} sink 日志函数
 */
export function warnClampedHeadroom(raw, applied, sink = warn) {
    // 卫语句：合法非负值原样通过，不打扰
    if (!Number.isFinite(raw) || raw === applied) return;

    const key = `headroom:${raw}`;
    if (warnedClamps.has(key)) return;
    warnedClamps.add(key);

    sink(
        `tiered-compaction: headroomTokens ${raw} 非法（必须是有限的非负数），` +
        `已按 ${applied} 生效。${applied === 0 ? "0 意味着不给摘要留输出空间，事务可能撞窗。" : ""}`
    );
}

/**
 * 清空告警去重表（仅供测试使用）。
 */
export function resetThresholdWarnings() {
    warnedClamps.clear();
}

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
    // P1-3（2026-10-27 系统审计）：极小窗口视为无效。
    // 旧实现 window=1 → 阈值 0，空会话 0 token 即触发（每步都跑一次事务）。
    // 真实最小窗口是 8k（小模型），低于 1000 的窗口只可能是读数异常。
    if (contextWindow < 1000) return Number.POSITIVE_INFINITY;

    const rawRatio = options.thresholdRatio ?? 0.85;
    const rawHeadroom = options.headroomTokens ?? HEADROOM_TOKENS;
    const reserve = options.reserveTokens ?? RESERVE_TOKENS;

    // P1-2（2026-10-27 系统审计）：配置必须夹到合法区间，越界静默失效不可接受。
    // 实测旧实现：ratio=1.5 → 阈值 150% 窗口**永不触发**；
    //              ratio=0.5 → 抢在 80% 驱逐前且单调性破裂 1309 处；
    //              headroom=NaN → 阈值 NaN → 永不触发。
    // 夹取而非抛错：配置问题不该让压缩层整个罢工，但必须留痕。
    const ratio = Number.isFinite(rawRatio)
        ? Math.min(MAX_THRESHOLD_RATIO, Math.max(MIN_THRESHOLD_RATIO, rawRatio))
        : 0.85;
    const headroom = Number.isFinite(rawHeadroom) ? Math.max(0, rawHeadroom) : HEADROOM_TOKENS;

    // 夹取必须留痕（D22 外部改写审计）：`dsh-session-manager` 这类插件会拿
    // `agentPresets.serviceFor(agent,'compaction')` 找到本引擎，直接写
    // `engine.config.thresholdRatio`。它的滑块是 17%–90%，而下面 [0.82, 0.95]
    // 的夹取让 65% 的行程成为死区——用户拖到 17% 和 81% 效果完全一样。
    // 没有这条日志，整件事是静默的：改配置没有任何反馈，也没法从日志看出
    // 「我的设置为什么没生效」。只记一次（用模块级 Set 去重），避免每步刷屏。
    warnClampedRatio(rawRatio, ratio, warn);

    // headroom 被改写同样要留痕（同一机制）：负数会被夹到 0，
    // 而 0 意味着「不给摘要留输出空间」，是会让事务撞窗的危险值。
    warnClampedHeadroom(rawHeadroom, headroom, warn);

    // 比例线：不超过 window × ratio（给压缩事务留出确定空间）
    const byRatio = Math.floor(contextWindow * ratio);

    // 绝对线：窗口 − 摘要预留 − headroom（保证触发后仍装得下一次摘要的输出预算）。
    //
    // P1-1（2026-10-27 系统审计）：旧实现**算了 byAbsolute 却从未使用**，
    // 注释宣称的「双约束取小」并不存在。后果：
    //   window ≤ 112130 时，触发点之后的剩余空间 < RESERVE_TOKENS，
    //   摘要必然撞窗（32k 窗口只剩 5899、64k 只剩 11797）。
    //   这正是 A4a 声称「从根上杜绝 2048 截断」的地方——在小窗口上是假的。
    //
    // 现在真正接上：取两线较小者，但**不得低于 FLOOR_RATIO**
    // （否则抢跑第 3 层的 80% 驱逐，四层递进失效）。
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

    // 先把「层次底线 + 比例线」算出来（这部分是四层递进的保证，不能动）
    let base;
    if (contextWindow <= lowerEdge) {
        // 窗口装不下 reserve+headroom：比例线也不安全。
        // 但仍不许低于 FLOOR_RATIO，否则又抢跑第 3 层。
        base = Math.floor(contextWindow * FLOOR_RATIO);
    } else if (contextWindow >= upperEdge) {
        // 空间充裕：直接比例线
        base = byRatio;
    } else {
        // 过渡带：占比在 [FLOOR_RATIO, ratio] 之间线性插值，消除断崖
        const progress = (contextWindow - lowerEdge) / (upperEdge - lowerEdge);
        const blendedRatio = FLOOR_RATIO + progress * (ratio - FLOOR_RATIO);
        base = Math.floor(contextWindow * blendedRatio);
    }

    // P1-1：真正接上绝对线——触发后必须还剩得下一次摘要的输出预算。
    // 但**不得低于 FLOOR_RATIO**：那是四层递进的底线，宁可摘要撞窗重试，
    // 也不能让摘要抢在 80% 驱逐之前（否则第 3 层永远轮不到执行）。
    if (byAbsolute > 0) {
        const floor = Math.floor(contextWindow * FLOOR_RATIO);
        base = Math.max(floor, Math.min(base, byAbsolute));
    }
    return base;
}

