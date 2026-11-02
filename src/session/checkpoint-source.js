/**
 * 压缩检查点消息的 source，按当前 session 的存储格式版本生成。
 *
 * 为什么不从 `@deepseek-ai/dsh-compaction` 导入：插件不声明这个依赖，运行时按 Node
 * 解析规则向上找，落到哪一份取决于用户机器的目录布局，不一定和正在运行的宿主同版本。
 * 不同宿主对同一概念的写法不同：
 *   - 格式 v4 及以上（dsh 0.2.x）：{ kind: "compact-checkpoint", compactionId, sourceCommandId? }，
 *     写入 { kind: "plugin" } 会被拒（"format v4 message requires a producer-owned source kind"）。
 *   - 格式 v4 之前（dsh 0.1.x）：{ kind: "plugin", plugin: "compact", compactionId, sourceCommandId? }。
 * 所以按 session.header.version 判断，不写死某一代格式，也不依赖任何安装路径。
 */

export const V4_FORMAT_VERSION = 4;

/**
 * 读 session 的存储格式版本。读不到时返回 undefined。
 * @param {unknown} session
 */
export function sessionFormatVersion(session) {
    const version = session?.header?.version;
    return typeof version === "number" && Number.isFinite(version) ? version : undefined;
}

/**
 * @param {string} compactionId
 * @param {string | undefined} sourceCommandId
 * @param {number | undefined} formatVersion 读不到版本时按当前格式（v4）处理
 */
export function compactCheckpointSource(compactionId, sourceCommandId, formatVersion) {
    const legacy = formatVersion !== undefined && formatVersion < V4_FORMAT_VERSION;
    return Object.freeze({
        ...(legacy ? { kind: "plugin", plugin: "compact" } : { kind: "compact-checkpoint" }),
        compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    });
}

/** 判断一个 source 是否为压缩检查点（两代写法都认）。 */
export function isCompactCheckpointSource(source) {
    if (source === null || typeof source !== "object") return false;
    return source.kind === "compact-checkpoint" || (source.kind === "plugin" && source.plugin === "compact");
}
