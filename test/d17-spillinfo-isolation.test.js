/**
 * spillInfo 必须按会话隔离（交叉审计，2026-10-27）。
 *
 * 缺陷：`engine.spillInfo` 的键原本只是裸 seq，而 seq 是**会话内**序号。
 * 两个会话都落盘 seq=1 时，后一个会覆盖前一个：
 *   · 文件名本身带会话标识，磁盘内容不会串
 *   · 但**读到的元数据会是别人的**——预览里显示错误的路径/哈希/大小
 *
 * 后果比"串内容"轻，但同样是静默错误：用户看到的存档指引指向另一个会话的文件。
 *
 * 运行：node --test test/d17-spillinfo-isolation.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TieredCompactionEngine } from "../src/engine.js";

const quietLogger = { info() {}, warn() {} };

test("两个会话的 seq 相同时，spillInfo 不得互相覆盖", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "spi-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    const big = "内容".repeat(5000);

    await engine.processToolOutput(big, { seq: 1, sessionId: "AAAA1111" });
    const beforeB = engine.lastSpillInfo(1, "AAAA1111");
    assert.ok(beforeB, "会话 A 落盘后必须能取到元数据");

    await engine.processToolOutput(big, { seq: 1, sessionId: "BBBB2222" });
    const afterB = engine.lastSpillInfo(1, "AAAA1111");
    const bInfo = engine.lastSpillInfo(1, "BBBB2222");

    assert.ok(bInfo, "会话 B 必须能取到自己的元数据");
    assert.equal(
        afterB?.path,
        beforeB.path,
        "会话 A 的元数据不得被 B 覆盖——seq 是会话内序号，键必须带会话维度",
    );
    assert.notEqual(afterB?.path, bInfo.path, "两个会话的存档路径必须不同");
});

test("不带 sessionId 时保持向后兼容（按后缀匹配）", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "spi2-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const engine = new TieredCompactionEngine({ archiveDir: dir, logger: quietLogger });
    await engine.processToolOutput("内容".repeat(5000), { seq: 42, sessionId: "X" });

    const legacy = engine.lastSpillInfo(42);
    assert.ok(legacy, "旧调用方式（只传 seq）必须仍能取到值");
    assert.match(legacy.path, /\.txt$/);
});
