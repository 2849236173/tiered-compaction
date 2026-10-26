/**
 * D17 验收 P0-1 回归：**存档绝不能被同名覆盖**。
 *
 * 缺陷（测试员在 D17 独立验收中挖出）：
 *   circuit-breaker.js 用 `arbitrated-${at.seq}` 作存档名，而 `seq` 是
 *   **会话内**序号。不同会话必然重号 → 同名文件互相覆盖 →
 *   先落盘的内容静默丢失，而谱系表仍指向该路径，回读拿到别人的内容。
 *   违反保真原则 2（任何取代关系可审计），且越用越坏。
 *
 * 实证（验收时）：arbitrated-571 的内容是某会话的 "Found 24 matches"，
 * arbitrated-21 是另一会话的 "D17-ACCEPT 行0"，两个不同会话落到不同名字，
 * 但同 seq 的两个会话就会相撞。
 *
 * 本文件两条：
 *   1. 同名两次落盘 → 第二个文件必须另起名字，第一个内容不得被改
 *   2. 文件名规则必须包含会话标识（防跨会话重号）
 *
 * 运行：node --test test/d17-archive-collision.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spillIfNeeded } from "../src/spill-to-disk.js";
import { arbitrate } from "../src/circuit-breaker.js";
import { Lineage } from "../src/lineage.js";

/** 造一段唯一行、远超 8000 字节的文本（避开第 1 层折叠）。 */
function bigText(tag, lines = 400) {
    const out = [];
    for (let i = 0; i < lines; i += 1) {
        out.push(`${tag} 行${i} 唯一内容 abcdefghijklmnop-${i}-padding`);
    }
    return out.join("\n");
}

test("P0-1 同名两次落盘：第二次必须另起文件名，第一次内容不得被覆盖", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p01-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const first = "AAA-" + bigText("FIRST");
    const second = "BBB-" + bigText("SECOND");

    const a = await spillIfNeeded(first, dir, "same-name");
    const b = await spillIfNeeded(second, dir, "same-name");

    assert.ok(a !== null && b !== null, "两段都超阈值，都必须落盘");
    assert.notEqual(a.path, b.path, "同名两次落盘必须落到不同文件");

    // 第一个文件内容必须完全没变 —— 这是「不覆盖」的核心断言
    const firstOnDisk = await readFile(a.path, "utf8");
    assert.ok(firstOnDisk.startsWith("AAA-"), "第一个存档必须仍是它自己的内容");
    assert.equal(firstOnDisk, first, "第一个存档必须逐字未变");

    const secondOnDisk = await readFile(b.path, "utf8");
    assert.ok(secondOnDisk.startsWith("BBB-"), "第二个存档必须是它自己的内容");

    const files = await readdir(dir);
    assert.equal(files.length, 2, "两次落盘必须产生两个文件");
});

test("P0-1 文件名规则必须带会话标识：不同会话同 seq 不得撞名", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "p01b-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const lineage = new Lineage();
    const deps = { archiveDir: dir, lineage };
    const text = bigText("COLLIDE");

    // 两个不同会话，seq 都是 42（旧实现会撞成同一个 arbitrated-42.txt）
    const r1 = await arbitrate(text, { seq: 42, sessionId: "session-aaaa1111" }, deps);
    const r2 = await arbitrate(text, { seq: 42, sessionId: "session-bbbb2222" }, deps);

    const spill1 = lineage.toArray().find((e) => e.replacedBy === "spill-to-disk");
    assert.ok(spill1 !== undefined, "第一次必须落盘");
    const paths = lineage.toArray().filter((e) => e.replacedBy === "spill-to-disk").map((e) => e.newLocation);
    assert.equal(paths.length, 2, "两次都必须登记谱系");
    assert.notEqual(paths[0], paths[1], "不同会话同 seq 必须落到不同文件");

    // 文件名里应能看到会话短标识，便于人工定位
    const names = await readdir(dir);
    assert.ok(
        names.some((n) => n.includes("aaaa1111")) && names.some((n) => n.includes("bbbb2222")),
        `文件名应含会话标识，实际：${names.join(", ")}`,
    );

    // 内容都完整
    for (const p of paths) {
        const content = await readFile(p, "utf8");
        assert.ok(content.includes("COLLIDE 行399"), `${p} 内容必须完整`);
    }
});
