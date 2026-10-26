/**
 * DSH 分层压缩插件（dsh-tiered-compaction）入口。
 *
 * 定位：与宿主已装 `@deepseek-ai/dsh-compaction-basic` 并存、不替换；
 * 通过 Cordis 配置开关 `tieredCompaction.enabled`（默认 false）决定是否
 * 占用 `ctx.compaction` 服务位。关闭时本插件仅注册只读的自检服务，
 * 不影响 basic 的任何行为。
 *
 * 架构：四层管线（无损折叠 → 落盘 → 软压力 → 有损摘要）+ 目标切换旁路，
 * 详见 docs/设计.md §1-§2。M4.5 起四层由 src/engine.js 串联。
 */
import { Service } from "@deepseek-ai/cordis";
import { TieredCompactionEngine } from "./engine.js";
// A12 契约层：宿主三入口 + 自动钩子的真实实现（enabled=true 的接管路径）。
// 注意：本模块名与 TieredCompactionEngineService 同名导出会与下方 M4.5 服务类
// 冲突，故以契约类名义导入并替换接管服务的实现。
import { TieredCompactionEngineService as HostContractEngineService } from "./contract.js";
// P1/P2-1 修补：工具结果观察者——把第 1-3 层真正接到宿主会话事件流。
import { ToolResultObserver } from "./tool-result-observer.js";

/** 本插件在 Cordis 中的服务位名（不与宿主 `compaction` 冲突）。 */
const SERVICE_NAME = "tieredCompaction";

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

/**
 * 接管引擎服务：占用 `compaction` 服务位（enabled=true 且槽位空闲时）。
 * 四层管线经 TieredCompactionEngine 串联（M4.5 wiring）。
 */
class TieredCompactionEngineService extends Service {
    constructor(ctx, config) {
        // 构造即占用 'compaction' 服务位——槽被占时 Cordis 在此处抛错，
        // 由 apply() 的 construction-catch 探测捕获并降级（设计稿 §8 R38-1）。
        super(ctx, "compaction");
        this.config = config;
        this.engine = new TieredCompactionEngine({
            archiveDir: config.archiveDir,
            tokenMeter: config.tokenMeter,
            summarizeFn: config.summarizeFn,
            summaryTarget: config.summaryTarget,
            logger: ctx.logger,
        });
        // P1 + P2-1：观察者把第 1-3 层接到宿主会话事件（工具结果压缩 + 80% 驱逐）
        this.observer = new ToolResultObserver({ engine: this.engine, ctx });
        this.observer.register();
        ctx.logger.info(
            `dsh-tiered-compaction 已接管 compaction 服务位` +
            (config.bypassMode ? "（旁路模式：仅第 1-2 层）" : "（四层管线 + 工具结果观察者）")
        );
    }
}

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
        enabled: config.enabled ?? false,
    };
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
            archiveDir: config.archiveDir,
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
            archiveDir: config.archiveDir,
        });
    }
}

/** 插件卸载：Cordis 依据 Service 自动回收，无需手动清理。 */
export function detach() {}
