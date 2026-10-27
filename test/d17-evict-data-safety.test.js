/**
 * 软压力驱逐不得丢数据（系统审计 P0-4）。
 *
 * 缺陷（2026-10-27 系统审计）：
 *   `evictVolatile` 把 bash/edit/write（优先级 1，设计稿明写"不可重放，
 *   依赖落盘存档"）也驱逐了，但谱系里只写一句占位文本
 *   `-（已驱逐，靠落盘存档/重放恢复）`——**根本没有存档**。
 *   这些内容一旦丢掉就永久消失：命令输出无法重来，写入结果不可复原。
 *
 *   另外三个问题：
 *   · 无"够用即停"：200 个 read 在压力刚过 80% 时一次全清
 *   · 优先级只决定"是否驱逐"，不决定"先驱逐谁"（实测 read 排在 bash 前面）
 *   · 谱系字段语义错位（描述文本塞进 newLocation）
 *
 * 当前 `evictVolatile` 是死代码（engine.applySoftPressure 未被 contract 调用），
 * 但接线前必须是对的——否则一接线就是数据丢失。
 *
 * 运行：node --test test/d17-evict-data-safety.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { evictVolatile, EVICTION_PRIORITY } from "../src/soft-pressure.js";
import { Lineage } from "../src/lineage.js";

test("A-P0-4 不可重放且无存档的内容不得驱逐（bash/edit/write）", () => {
    const lineage = new Lineage();
    const nodes = [
        { seq: 1, kind: "bash", content: "命令输出（不可重来）" },
        { seq: 2, kind: "edit", content: "编辑结果" },
        { seq: 3, kind: "write", content: "写入结果" },
    ];
    const { evicted, kept } = evictVolatile(nodes, { lineage });

    assert.equal(evicted.length, 0, "三种都不可重放且无存档，一个都不能驱逐");
    assert.equal(kept.length, 3, "全部必须保留");
});

test("A-P0-4 已存档的不可重放内容可以驱逐，且谱系必须指向真实路径", () => {
    const lineage = new Lineage();
    const nodes = [
        { seq: 1, kind: "bash", content: "命令输出", archived: true, archivePath: "/a/x.txt" },
        { seq: 2, kind: "bash", content: "未存档的命令输出" },
    ];
    const { evicted, kept } = evictVolatile(nodes, { lineage });

    assert.deepEqual(evicted.map((e) => e.seq), [1], "只有已存档的可驱逐");
    assert.ok(kept.some((n) => n.seq === 2), "未存档的必须保留");

    const rec = lineage.findByOriginal("node#1")[0];
    assert.equal(rec.newLocation, "/x.txt".slice(1) === "x.txt" ? "/a/x.txt" : "", "谱系指向真实存档路径");
    assert.doesNotMatch(rec.newLocation, /已驱逐，靠落盘存档/, "不得再写占位文本");
});

test("可重放内容（read/grep/glob）可以无条件驱逐", () => {
    const lineage = new Lineage();
    const nodes = [
        { seq: 1, kind: "read", content: "文件内容" },
        { seq: 2, kind: "grep", content: "搜索结果" },
        { seq: 3, kind: "glob", content: "文件列表" },
    ];
    const { evicted } = evictVolatile(nodes, { lineage });
    assert.equal(evicted.length, 3);
    assert.ok(evicted.every((e) => e.replayable === true), "三者都可重放");
});

test("永不清理项在任何情况下都不得驱逐", () => {
    const lineage = new Lineage();
    const nodes = [
        { seq: 1, kind: "user-message", content: "用户原话" },
        { seq: 2, kind: "todo", content: "待办" },
        { seq: 3, kind: "goal", content: "目标" },
        { seq: 4, kind: "plan", content: "计划" },
        { seq: 5, kind: "summary", content: "摘要" },
    ];
    const { evicted, kept } = evictVolatile(nodes, { lineage });
    assert.equal(evicted.length, 0);
    assert.equal(kept.length, 5);
});

test("A-P0-4 优先级必须真正决定驱逐顺序（bash 先于 read）", () => {
    const lineage = new Lineage();
    // 故意把 read 放在数组前面，验证排序真的生效
    const nodes = [
        { seq: 1, kind: "read", content: "文件", tokens: 10 },
        { seq: 2, kind: "bash", content: "命令输出", archived: true, archivePath: "/a/b.txt", tokens: 10 },
    ];
    const { evicted } = evictVolatile(nodes, { lineage });
    // bash 优先级 1，read 优先级 2 → bash 必须先被驱逐
    assert.deepEqual(
        evicted.map((e) => e.seq),
        [2, 1],
        "必须按优先级数值升序驱逐，而不是按数组顺序",
    );
    assert.ok(EVICTION_PRIORITY.bash < EVICTION_PRIORITY.read);
});

test("A-P0-4 预算够就停，不得一次清空全部可驱逐项", () => {
    const lineage = new Lineage();
    const nodes = Array.from({ length: 10 }, (_, i) => ({
        seq: i + 1,
        kind: "read",
        content: `内容${i}`,
        tokens: 100,
    }));
    const { evicted, kept } = evictVolatile(nodes, { lineage }, { budgetTokens: 250 });

    assert.ok(evicted.length > 0, "预算内应驱逐一些");
    assert.ok(evicted.length < 10, "不得一次清空全部");
    assert.ok(kept.length > 0, "必须有保留");
    // 预算大致用完就停（每项 100 token，250 预算最多 3 项）
    assert.ok(evicted.length <= 3, `预算 250 / 每项 100 应最多驱逐 3 项，实得 ${evicted.length}`);
});

test("不传预算时保持旧行为（不限制），避免破坏既有调用方", () => {
    const lineage = new Lineage();
    const nodes = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, kind: "read", content: "x" }));
    const { evicted } = evictVolatile(nodes, { lineage });
    assert.equal(evicted.length, 5, "不传 budgetTokens 时应全部可驱逐");
});
