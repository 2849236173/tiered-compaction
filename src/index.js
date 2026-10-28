/**
 * DSH 分层压缩插件（dsh-tiered-compaction）入口。
 *
 * 装上即接管 `ctx.compaction` 服务位，替代官方 `dsh-compaction-basic`。
 * 插件自带的 patch 会同时停用 basic，用户无需改任何配置。
 *
 * 要退回官方压缩：把配置里的 `enabled` 设为 false（本插件转为只注册
 * 只读自检服务，不占服务位），并把 basic 的 `disabled` 改回 false。
 *
 * 架构：四层管线（无损折叠 → 落盘 → 软压力 → 有损摘要）+ 目标切换旁路。
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { Service } from "@deepseek-ai/cordis";
import { TieredCompactionEngine } from "./engine.js";
// A12 契约层：宿主三入口 + 自动钩子的真实实现（enabled=true 的接管路径）。
// 注意：本模块名与 TieredCompactionEngineService 同名导出会与下方 M4.5 服务类
// 冲突，故以契约类名义导入并替换接管服务的实现。
import { TieredCompactionEngineService as HostContractEngineService } from "./contract.js";
// P1/P2-1 修补：工具结果观察者——把第 1-3 层真正接到宿主会话事件流。
import { ToolResultObserver } from "./tool-result-observer.js";
// D22：把阈值夹取的告警接到宿主日志（见 reportCoexistingEngines 与 lossy-summarize）。
import { setThresholdWarnSink } from "./lossy-summarize.js";

/** 本插件在 Cordis 中的服务位名（不与宿主 `compaction` 冲突）。 */
const SERVICE_NAME = "tieredCompaction";

/**
 * 存档目录默认值：`~/.dsh/tiered-archive`。
 *
 * 为什么不放在插件目录里：插件可能装在全局位置或只读位置，且存档属于
 * 运行时数据不属于代码。放在用户配置目录下与 DSH 自身的存储位置同级。
 *
 * @returns {string} 绝对路径
 */
function defaultArchiveDir() {
    return join(homedir(), ".dsh", "tiered-archive");
}

/**
 * 旁路观测服务（enabled=false 时注册）：不接管压缩，仅暴露配置与运行状态，
 * 供并存验证与开关切换观测。压缩行为完全由 basic 负责（验收 A6）。
 */
class TieredCompactionService extends Service {
    constructor(ctx, config) {
        super(ctx, SERVICE_NAME);
        /** 已解析的插件配置（enabled 由调用方在挂载层判断）。 */
        this.config = config;
        ctx.logger.info(
            `dsh-tiered-compaction 已加载（enabled=${config.enabled}，未接管压缩，basic 照常工作）`
        );
    }
}

/*
 * ⚠ D17 教训（勿删此注释）：
 * 这里曾经有一个 `TieredCompactionEngineService` 类，创建四层引擎与观察者，
 * 看起来就是「接管实现」。但它**在接管路径上从未被实例化**——
 * apply() 用的是 contract.js 的同名类（导入别名 HostContractEngineService）。
 *
 * 后果：第 1-2 层代码存在、测试全绿（都在测零件），但真实会话里
 * 没有任何活对象持有引擎 → archiveDir 永远不写 → 且零报错。
 * 我因此连续修错了两轮（补日志、改钩子签名），因为一直在读这个死类。
 *
 * 现已删除，避免再次误导。接管实现只有一处：contract.js。
 */

/**
 * 旁路自检服务：槽位被占时降级注册「第 1-2 层旁路模式」（§9-6）。
 * 无损折叠+落盘仍可服务（与 rollover 形态互补），第 3-4 层挂起不注册引擎。
 */
class TieredCompactionBypassService extends Service {
    constructor(ctx, config) {
        super(ctx, SERVICE_NAME);
        this.config = config;
        this.bypassMode = true;
        this.engine = new TieredCompactionEngine({
            // config 由 apply 传入，已含解析后的默认存档目录
            archiveDir: config.archiveDir,
            logger: ctx.logger,
        });
        // 旁路模式下第 1-2 层照样服务（与 rollover 形态互补，设计稿 §9-6）
        this.observer = new ToolResultObserver({ engine: this.engine, ctx });
        this.observer.register();
        ctx.logger.warn(
            "dsh-tiered-compaction：compaction 服务位已被占用，降级为第 1-2 层旁路模式" +
            "（无损折叠+落盘仍可用；第 3-4 层挂起）"
        );
    }
}

/**
 * 检测「preset realm 内另有压缩引擎」（D22 新增）。
 *
 * 为什么必须有这一步：
 * 在 preset 架构下（web / desktop 都是），每个会话的 agent 跑在 preset 自己的
 * `isolate` realm 里，realm 内有一份独立的 `compaction` 服务。插件自带的
 * cordis patch 只能停用 **root 平面**那份 `compaction-basic`，因为它走的
 * `buildMap` 只递归 `group && Array.isArray(config)`，而 preset 的插件列表
 * 躺在 `agentPreset.config.plugins` 这个**对象字段**里，递归不进去。
 *
 * 后果：我们在 root realm 注册成功、日志显示「已接管 compaction 服务位」，
 * 但每个真实会话用的是 preset realm 里那个官方 basic。用户装了插件，
 * 实际压缩行为没有任何变化，且**全程零报错**——这是最难查的一类失效。
 *
 * 这一步不试图修复（改写别人 preset 的 config 风险高），只把静默变可见。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 */
async function reportCoexistingEngines(ctx) {
    // 卫语句：拿不到 preset 注册表（headless / 老宿主 / 测试桩）就无事可做。
    // 用可选链而非 ctx.get 直接调用：ctx.get 可能强制实例化懒声明服务。
    const registry = typeof ctx.get === "function" ? ctx.get("agentPresets") : undefined;
    if (registry === undefined || registry === null) {
        ctx.logger.info(
            "dsh-tiered-compaction: 无 agentPresets 服务（非 preset 架构），" +
            "本插件即为唯一的 compaction 实现"
        );
        return;
    }
    // 卫语句：注册表版本不支持 list() 时不做无根据的结论
    if (typeof registry.list !== "function") return;

    let rows;
    try {
        rows = await registry.list();
    } catch (error) {
        // 探测失败绝不能阻断加载：它只是诊断，不是功能
        ctx.logger.warn(
            `dsh-tiered-compaction: 枚举 preset 失败（已忽略）：${error?.message ?? error}`
        );
        return;
    }
    if (!Array.isArray(rows) || rows.length === 0) return;

    // 逐个 preset 查它 realm 内有没有 compaction 实现。
    // serviceFor 需要 (agent, name)，但我们只有 preset 定义、没有 agent 实例；
    // 因此退一步：凡是「声明了 compaction 组的 preset」都要报——这些 preset
    // 一旦被某个会话选中，realm 内就有自己的引擎，我们的 patch 管不到它。
    const risky = [];
    for (const row of rows) {
        if (declaresOwnCompactionGroup(row)) risky.push(presetLabel(row));
    }
    if (risky.length === 0) {
        ctx.logger.info(
            "dsh-tiered-compaction: 所有 preset 均未自带 compaction 组，本插件为唯一压缩实现"
        );
        return;
    }

    ctx.logger.warn(
        `dsh-tiered-compaction：以下 preset 自带 compaction 组，其 realm 内会挂一份独立压缩引擎：` +
        `${risky.join("、")}。` +
        `插件 patch 只能停用 root 平面那份 compaction-basic，管不到 preset 内部——` +
        `**若你的会话正在使用这些 preset，实际压缩由 preset 内引擎执行，本插件的四层管线不会生效**。` +
        `解决办法：用 tools/gen-ptc-tc.ps1 这类脚本把 preset 的 config 整块重写（把 compaction-basic 换成 tiered-compaction）。`
    );
}

/**
 * 判断一个 preset 定义是否自带 compaction 组。
 * @param {object} row preset 定义（registry.list() 的一项）
 * @returns {boolean} 自带则为 true
 */
function declaresOwnCompactionGroup(row) {
    const plugins = row?.config?.plugins ?? row?.plugins;
    if (!Array.isArray(plugins)) return false;
    return plugins.some((entry) => entry?.id === "compaction");
}

/**
 * preset 的可读标识，用于告警文案。
 * @param {object} row preset 定义
 * @returns {string} 例如 `ptc` 或 `(未命名 preset)`
 */
function presetLabel(row) {
    const id = row?.config?.id ?? row?.id;
    if (typeof id === "string" && id.length > 0) return id;
    return "(未命名 preset)";
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {{enabled?: boolean, bypassMode?: boolean, archiveDir?: string,
 *          tokenMeter?: object, summarizeFn?: Function, summaryTarget?: object}} config
 *   插件配置；enabled 默认 false（可并存铁律）。enabled=true 时接管走
 *   宿主契约层（src/contract.js，A12）：CompactionEngine 基类 + static inject
 *   三入口 + agent/pre-step 自动钩子；config 中的 tokenMeter/summarizeFn/
 *   summaryTarget 仅作为测试桩与兜底（宿主真链路从 ctx 注入解析）。
 */
export async function apply(ctx, config = {}) {
    const resolved = {
        // 默认开启：装上就该生效。要并存或临时停用，显式配 enabled: false。
        enabled: config.enabled ?? true,
        // 存档目录必须有个能用的默认值。
        // 为什么不能留空：archiveDir 缺失时第 1-2 层（折叠 + 落盘）会被整层跳过，
        // 而且是静默跳过——装了插件、界面不报错、日志只有一行「无 archiveDir（落盘层跳过）」。
        // 这正是「装了但没生效」最典型的一种。
        // 默认放在宿主配置目录下，与 DSH 自身的存储位置同级，不污染用户目录。
        archiveDir: config.archiveDir ?? defaultArchiveDir(),
    };
    // 观测：apply 是否被调用、拿到的配置是什么。放在最前面——
    // 「preset 内插件静默不生效」时，这一行能区分两种完全不同的原因：
    //   apply 根本没被调用（模块解析/挂载问题）
    //   apply 被调用了但服务没构造（static inject 依赖缺）
    ctx.logger.info(
        `dsh-tiered-compaction apply 被调用（enabled=${resolved.enabled}）`
    );

    // D22：把阈值夹取的告警接到宿主日志。
    // 背景：`dsh-session-manager` 这类插件会直接写 engine.config.thresholdRatio
    // （17%–90% 滑块），而我们的 lossyThreshold 把值夹到 [0.82, 0.95]。
    // 不接这条 sink，夹取就是静默的——用户改了设置、没生效、日志里一个字都没有。
    setThresholdWarnSink((message) => ctx.logger.warn(message));

    // D22：检测「realm 内另有压缩引擎」——这是 preset 架构下最隐蔽的失效：
    // 我们注册在 root realm 成功、日志显示「已接管」，但每个会话实际跑的是
    // preset realm 内那份官方 basic（preset 的 plugins 是对象字段，patch 的
    // buildMap 递归不进去，所以插件自带 patch 停不掉它）。
    // 期望 false 以外的结果都要报出来，把「装了但没用」从静默变可见。
    await reportCoexistingEngines(ctx);
    // 开关关闭（默认）：只注册自检服务，绝不触碰 ctx.compaction 服务位，
    // 保证与 dsh-compaction-basic 完全并存、行为与纯 basic 一致（验收 A6）。
    if (!resolved.enabled) {
        ctx.plugin(TieredCompactionService, resolved);
        return;
    }
    // 开关开启：construction-catch 探测服务位（设计稿 §8 R38-1 定稿写法）。
    // 严禁 ctx.get('compaction') 探针——它会强制实例化懒声明的引擎、把槽占掉
    // 反噬自己（headless 实测坑）。改为直接构造引擎服务：Cordis 的 Service
    // 构造器在 await ctx.plugin(...) 时同步 provide，槽被占时抛
    // "service ... has been registered at <...>"，catch 后解析持有者并降级为
    // 第 1-2 层旁路模式（§9-6），显式标 bypassMode。
    // （cordis 实测：ctx.plugin() 返回 thenable fiber，构造发生在 await 后，
    //   报错文案 `service "<name>" has been registered at <owner>`。）
    try {
        // A12 起接管服务 = 宿主契约层（CompactionEngine 基类 + 三入口 + 自动钩子）。
        // 契约层内部仍持有四层引擎（engine.js）的依赖；config 桩仅测试用。
        await ctx.plugin(HostContractEngineService, {
            ...resolved,
            bypassMode: config.bypassMode ?? false,
            archiveDir: resolved.archiveDir,
            tokenMeter: config.tokenMeter,
            summarizeFn: config.summarizeFn,
            summaryTarget: config.summaryTarget,
        });
    } catch (err) {
        if (!/has been registered/.test(String(err?.message))) throw err;
        const holder = /has been registered at <([^>]+)>/.exec(String(err?.message))?.[1] ?? "unknown";
        ctx.logger.warn(
            `dsh-tiered-compaction：compaction 服务位已被 <${holder}> 占用，降级旁路模式`
        );
        await ctx.plugin(TieredCompactionBypassService, {
            ...resolved,
            bypassMode: true,
            archiveDir: resolved.archiveDir,
        });
    }
}

/** 插件卸载：Cordis 依据 Service 自动回收，无需手动清理。 */
export function detach() {}
