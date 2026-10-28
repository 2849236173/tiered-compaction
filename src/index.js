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
