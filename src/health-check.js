/**
 * 运行时自检（健康探针）：证明四层在工作，而不是"看起来在工作"。
 *
 * 为什么需要（D17 全部实测教训）：
 *   这一轮挖出的 10 个 bug 里，有 8 个是同一形态——
 *   日志正常、单测全绿、不报错，但功能**根本没跑**：
 *     · 接管类从未被实例化（引擎代码在，没活对象持有）
 *     · 钩子签名写错（注册了，宿主从不派发到有效分支）
 *     · 窗口读数走猜的路径（读不到就静默回落 128k）
 *     · 80% 驱逐只 emit、无监听者（广播了，没人接）
 *     · 工具名取错字段（永远挑不出可驱逐项）
 *     · 第 3 层与第 1-2 层共用去重标记（被前者永久禁用）
 *     · 可压区间太小时仍进事务（每次注定失败）
 *     · 空 summaryTarget 短路失效（空路由发出去）
 *
 *   这些都不能靠"看日志有没有报错"发现。所以需要一份**结构化健康快照**：
 *   把"各层的实际计数 + 关键配置 + 判定结果"打成一条可扫描的记录，
 *   一旦某层长期为 0 或关键项异常，一眼就能看出来。
 *
 * 设计原则：
 *   1. **零副作用**：只读状态，不改会话、不写事件、不调 LLM
 *   2. **零失败风险**：任何异常都吞掉并降级，绝不阻断会话
 *   3. **有节制**：不是每步都打，按间隔触发（默认每 10 分钟最多一条）
 *   4. **可判定**：每条带 `status`（ok / warn / fail），异常项显式列出
 */

/** 默认自检间隔：10 分钟。压缩层出问题通常以小时为尺度，不必更密。 */
export const DEFAULT_SELFCHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 收集一次健康快照（纯函数，零副作用）。
 *
 * @param {object} deps
 * @param {object} deps.observer 工具结果观察者（提供 done/evicted/stats）
 * @param {object} deps.engine 四层引擎（提供 lineage）
 * @param {object} [deps.session] 当前会话（用于窗口/压力读数）
 * @param {number} [deps.window] 窗口 token 数（由调用方用 contextWindowOf 取）
 * @param {number} [deps.currentTokens] 当前压力读数
 * @param {object} [deps.config] 插件配置
 * @returns {object} 结构化快照
 */
export function collectHealth(deps = {}) {
    const {
        observer,
        engine,
        session,
        window = 0,
        currentTokens = 0,
        config = {},
    } = deps;

    // 各层实际计数——这是"真的在跑"的唯一硬证据
    const stats = observer?.stats ?? {};
    const layer3Evicted = observer?.evicted?.size ?? 0;
    const layer12Processed = observer?.done?.size ?? 0;
    const lineage = engine?.lineage?.toArray?.() ?? [];
    const lineageSize = lineage.length;
    // 落盘次数：数谱系里由第 2 层登记的条目。
    // 字段语义见 src/lineage.js：replacedBy 记录**是谁取代的**
    // （lossless-fold / spill-to-disk / soft-pressure / lossy-summarize），
    // newLocation 才是存档路径。别把两者搞反——那是 D17 反复出现的坑。
    const spillCount = lineage.filter((entry) => entry?.replacedBy === "spill-to-disk").length;

    const pressure = window > 0 ? currentTokens / window : 0;

    // 判定：只报"明确异常"，不做启发式猜测
    const problems = [];

    // 1. 窗口读数可疑：压力 0 但会话明显有内容，或窗口正好等于兜底值
    if (window === 0) {
        problems.push("窗口读数为 0（contextWindowOf 未取到路由元数据）");
    }
    if (currentTokens > 0 && window > 0 && pressure === 0) {
        problems.push("压力算出来是 0 但存在读数（分母/分子口径不一致）");
    }

    // 2. 第 1-2 层长期不工作：有工具结果却一次都没处理
    if ((stats.failed ?? 0) > 0 && (stats.replaced ?? 0) === 0) {
        problems.push(`第 1-2 层有 ${stats.failed} 次失败且零成功（可能是钩子或引擎未接线）`);
    }

    // 3. 第 3 层可疑：压力已越过 80% 却一次驱逐都没有
    if (pressure >= 0.8 && layer3Evicted === 0 && (stats.replaced ?? 0) === 0) {
        problems.push("压力 ≥80% 但第 3 层零驱逐、第 1-2 层零处理（观察者可能未生效）");
    }

    // 4. 摘要路由：配置里是空对象会导致摘要请求带 undefined 路由（D17 bug 2）
    const st = config?.summaryTarget;
    if (st !== undefined && st !== null) {
        const hasProvider = typeof st.provider === "string" && st.provider.length > 0;
        const hasModel = typeof st.model === "string" && st.model.length > 0;
        if (!hasProvider && !hasModel && Object.keys(st).length === 0) {
            // 空对象是"未配置"的正常反序列化结果，靠回落会话路由工作
            // —— 但如果会话也没有路由，摘要就会失败，这里只提示不判失败
            // （会话早期还没发过请求时属于正常）
        } else if (!hasProvider || !hasModel) {
            problems.push("summaryTarget 只配了一半（provider/model 缺一），会覆盖掉会话路由");
        }
    }

    const status = problems.length === 0 ? "ok" : "warn";

    return {
        status,
        pressure: Number(pressure.toFixed(4)),
        window,
        currentTokens,
        layers: {
            l12Processed: layer12Processed,
            l12Replaced: stats.replaced ?? 0,
            l12Failed: stats.failed ?? 0,
            l12Skipped: stats.skipped ?? 0,
            l12BytesSaved: stats.bytesSaved ?? 0,
            l3Evicted: layer3Evicted,
            spillCount,
            lineageEntries: lineageSize,
        },
        config: {
            hasArchiveDir: typeof config?.archiveDir === "string" && config.archiveDir.length > 0,
            auto: config?.auto ?? true,
            summaryTargetConfigured: typeof st?.provider === "string" && st.provider.length > 0,
            modelPolicies: Array.isArray(config?.modelPolicies) ? config.modelPolicies.length : 0,
        },
        sessionId: session?.id ?? undefined,
        problems,
    };
}

/**
 * 把快照格式化成一行可扫描的日志文本。
 * 形如：`tiered-compaction 健康 window=1000000 pressure=3.5% l12=12/repl9/0fail l3=0 spill=9 lineage=21 status=ok`
 *
 * @param {object} health collectHealth 的返回值
 * @returns {string}
 */
export function formatHealth(health) {
    const l = health.layers;
    const parts = [
        `window=${health.window}`,
        `pressure=${(health.pressure * 100).toFixed(1)}%`,
        `l12=${l.l12Processed}/${l.l12Replaced}repl/${l.l12Failed}fail`,
        `l3=${l.l3Evicted}evict`,
        `spill=${l.spillCount}`,
        `lineage=${l.lineageEntries}`,
        `status=${health.status}`,
    ];
    if (health.problems.length > 0) parts.push(`problems=${health.problems.join("；")}`);
    return `tiered-compaction 健康 ${parts.join(" ")}`;
}

/**
 * 带节流的自检器。每条间隔内最多输出一次。
 *
 * 为什么节流：pre-step 每步都会调，不节流会把日志冲垮；
 * 但压缩问题以小时为尺度，10 分钟一条足够早发现。
 */
export class HealthReporter {
    /**
     * @param {{logger: object, intervalMs?: number, now?: () => number}} options
     */
    constructor({ logger, intervalMs = DEFAULT_SELFCHECK_INTERVAL_MS, now = () => Date.now() }) {
        this.logger = logger;
        this.intervalMs = intervalMs;
        this.now = now;
        // 用 null 表示「还没输出过」。
        // 不能用 0：时钟起点就是 0 时会把首次调用误判成「间隔内」而跳过
        // ——首次必须无条件输出，否则插件跑一整天也可能一条健康日志都没有。
        this.lastAt = null;
        this.lastStatus = undefined;
    }

    /**
     * 若距上次超间隔、或状态从 ok 变 warn，则输出一条。
     * @param {object} health collectHealth 的返回值
     * @returns {boolean} 是否真的输出了
     */
    maybeReport(health) {
        const now = this.now();
        const statusChanged = health.status !== this.lastStatus;
        // 状态恶化（ok → warn）立即报，不等间隔；其余按间隔
        const deteriorated = statusChanged && health.status !== "ok";
        const firstTime = this.lastAt === null;
        if (!firstTime && !deteriorated && now - this.lastAt < this.intervalMs) return false;
        this.lastAt = now;
        this.lastStatus = health.status;
        const line = formatHealth(health);
        // 自检本身绝不能抛：打日志失败也只吞掉
        try {
            if (health.status === "ok") this.logger?.info?.(line);
            else this.logger?.warn?.(line);
        } catch {
            /* 忽略：健康探针失败不得影响会话 */
        }
        return true;
    }
}
