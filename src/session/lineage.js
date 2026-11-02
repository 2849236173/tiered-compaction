/**
 * 谱系表（lineage）：保真原则 2 的落地——任何内容被折叠/落盘/驱逐/摘要取代时，
 * 在此登记「原位置 → 新位置 → 取代者」，可审计可回溯，绝不静默删除（验收 A10）。
 */

/** 单条谱系记录。 */
export class LineageEntry {
    /**
     * @param {string} id 记录 ID（调用方保证唯一，建议自增或 UUID）
     * @param {string} originalLocation 原位置（会话内定位，如节点 seq 或偏移描述）
     * @param {string} newLocation 新位置（存档路径 / 折叠块 ID / 摘要节点 ID；未被移动填 "-"）
     * @param {string} replacedBy 取代者（lossless-fold / spill-to-disk / soft-pressure / lossy-summarize）
     * @param {string} [digest] 内容摘要（SHA-256，便于对实物）
     */
    constructor(id, originalLocation, newLocation, replacedBy, digest = "") {
        this.id = id;
        this.originalLocation = originalLocation;
        this.newLocation = newLocation;
        this.replacedBy = replacedBy;
        this.digest = digest;
    }
}

/**
 * 谱系表：内存实现（M3 范围），持久化到会话目录由 M4 统一接管。
 */
export class Lineage {
    constructor() {
        /** @type {Map<string, LineageEntry>} */
        this.entries = new Map();
        this._nextId = 1;
    }

    /**
     * 登记一条取代关系。
     * @param {string} originalLocation 原位置
     * @param {string} newLocation 新位置
     * @param {string} replacedBy 取代者
     * @param {string} [digest] 可选内容摘要
     * @returns {LineageEntry} 登记后的记录
     */
    record(originalLocation, newLocation, replacedBy, digest = "") {
        const id = `L${String(this._nextId).padStart(4, "0")}`;
        this._nextId += 1;
        const entry = new LineageEntry(id, originalLocation, newLocation, replacedBy, digest);
        this.entries.set(id, entry);
        return entry;
    }

    /**
     * 按原位置查询谱系（可审计回溯入口，验收 A10 的查询面）。
     * @param {string} originalLocation
     * @returns {LineageEntry[]}
     */
    findByOriginal(originalLocation) {
        const hits = [];
        for (const entry of this.entries.values()) {
            if (entry.originalLocation === originalLocation) hits.push(entry);
        }
        return hits;
    }

    /** 导出为可序列化数组（供持久化与测试断言）。 */
    toArray() {
        return [...this.entries.values()].map((entry) => ({ ...entry }));
    }
}

/**
 * 谱系里的节点原位置：带会话维度（seq 是会话内序号，裸 `node#seq` 跨会话会撞）。
 * 无会话 id 时退回旧格式 `node#seq`（纯函数层/测试无会话时的兼容口径）。
 * @param {number|string} seq
 * @param {string} [sessionId]
 * @returns {string}
 */
export function nodeLocation(seq, sessionId) {
    return typeof sessionId === "string" && sessionId !== ""
        ? `${sessionId}#node#${seq}`
        : `node#${seq}`;
}
