/**
 * DSH 分层压缩插件（dsh-tiered-compaction）入口。
 *
 * 定位：与宿主已装 `@deepseek-ai/dsh-compaction-basic` 并存、不替换；
 * 通过 Cordis 配置开关 `tieredCompaction.enabled`（默认 false）决定是否
 * 占用 `ctx.compaction` 服务位。关闭时本插件仅注册只读的自检服务，
 * 不影响 basic 的任何行为。
 *
 * 架构：四层管线（无损折叠 → 落盘 → 软压力 → 有损摘要）+ 目标切换旁路，
 * 详见 docs/设计.md §1-§2。
 */
import { Service } from "@deepseek-ai/cordis";

/** 本插件在 Cordis 中的服务位名（不与宿主 `compaction` 冲突）。 */
const SERVICE_NAME = "tieredCompaction";

/**
 * M2 骨架期服务：只做可加载性自检与配置解析，业务层随后续里程碑接入。
 * 后续 M3/M4 将把四层管线挂在同一服务实例上。
 */
class TieredCompactionService extends Service {
    constructor(ctx, config) {
        super(ctx, SERVICE_NAME);
        /** 已解析的插件配置（enabled 由调用方在挂载层判断）。 */
        this.config = config;
        ctx.logger.info(
            `dsh-tiered-compaction 骨架已加载（enabled=${config.enabled}，当前为 M2 空实现）`
        );
    }
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 * @param {{enabled?: boolean}} config 插件配置；enabled 默认 false（可并存铁律）
 */
export function apply(ctx, config = {}) {
    const resolved = {
        enabled: config.enabled ?? false,
    };
    // 开关关闭（默认）：只注册自检服务，绝不触碰 ctx.compaction 服务位，
    // 保证与 dsh-compaction-basic 完全并存、行为与纯 basic 一致（验收 A6）。
    if (!resolved.enabled) {
        ctx.plugin(TieredCompactionService, resolved);
        return;
    }
    // 开关开启：注册自检服务并宣告接管意图。
    // M2 接口验证结论（写入 docs/设计.md 附录）：ctx.compaction 是 Cordis
    // 服务位替换语义——basic 与本插件同时 enabled 会重复注册同一服务位，
    // 因此宿主 profile 侧必须只启用其一，本插件不做运行时让位。
    ctx.plugin(TieredCompactionService, resolved);
}

/** 插件卸载：Cordis 依据 Service 自动回收，无需手动清理。 */
export function detach() {}
