/**
 * D21 安装即生效验证。
 *
 * 用户的原话是「不应该安装完还让用户去做改配置操作，就应该启动」。
 * 这条测试守住三件事，任何一件回退都会让「装了但没生效」重现：
 *
 *   1. 插件自带的 patch 同时做两件事：停用 basic + 插入并启用自己
 *   2. 不传任何配置时，插件默认 enabled=true 且带可用存档目录
 *   3. 默认存档目录是绝对路径，不依赖调用方 cwd
 *
 * 为什么单独建文件而不是塞进 index.test.js：这三条验的是「安装体验」，
 * 与内部实现无关。它们该在有人改动默认值或 patch 文件时立刻变红。
 *
 * 运行：node --test test/d21-install-ready.test.js
 */
import "./reset-writer.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import { apply } from "../src/index.js";

/** 读取仓库自带的 patch 文件内容。 */
function readPatch() {
    return readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
}

/**
 * 造一个能满足契约层 static inject 的最小 ctx。
 *
 * 契约层注入 llm / tokenMeter / sessions 三个服务，缺任一则服务不构造。
 */
async function makeCtx() {
    const ctx = new Context();
    ctx.provide("llm", {
        stream: async function* () {
            yield { type: "finish", reason: { kind: "stop" } };
        },
    });
    ctx.provide("tokenMeter", {
        measure: () => ({ totalTokens: 0 }),
        estimateMessage: () => 0,
    });
    ctx.provide("sessions", { flush: async () => {} });
    ctx.logger = { info() {}, warn() {}, error() {} };
    return ctx;
}

test("D21-1 patch 同时停用 basic 并启用自己——用户无需改配置", () => {
    const patch = readPatch();

    assert.match(
        patch,
        /id:\s*compaction-basic[\s\S]{0,80}?disabled:\s*true/,
        "patch 必须停用 compaction-basic，否则同一服务位双注册会降级为旁路模式（装了但没生效）",
    );
    assert.match(
        patch,
        /id:\s*tiered-compaction[\s\S]{0,200}?enabled:\s*true/,
        "patch 必须直接启用本插件",
    );
});

test("D21-2 零配置启动：默认接管服务位，不需要任何配置项", async () => {
    const ctx = await makeCtx();

    // 关键：传空对象——模拟用户装完直接启动，什么都不配
    await apply(ctx, {});

    const service = ctx.get("compaction");
    assert.ok(service !== undefined, "必须已接管 ctx.compaction 服务位");
    assert.equal(typeof service.compactRegion, "function", "三入口之一必须可用");
    assert.equal(typeof service.compactIfNeeded, "function");
    assert.equal(typeof service.compactNow, "function");
});

test("D21-3 默认存档目录是绝对路径，不依赖调用方 cwd", async () => {
    const ctx = await makeCtx();
    let capturedArchiveDir;
    const originalInfo = ctx.logger.info;
    ctx.logger.info = (message) => {
        const match = /archiveDir=([^，)]+)/.exec(String(message));
        if (match !== null) capturedArchiveDir = match[1];
        originalInfo(message);
    };

    await apply(ctx, {});

    assert.ok(capturedArchiveDir !== undefined, "启动日志里必须能看到实际使用的存档目录");
    assert.equal(
        isAbsolute(capturedArchiveDir),
        true,
        `存档目录必须是绝对路径（实得 ${capturedArchiveDir}）——相对路径会随 cwd 漂移`,
    );
});

test("D21-4 显式 enabled=false 仍可退回与 basic 并存", async () => {
    const ctx = await makeCtx();

    await apply(ctx, { enabled: false });

    assert.equal(ctx.get("compaction"), undefined, "关闭时绝不占用 compaction 服务位");
    assert.ok(ctx.tieredCompaction !== undefined, "关闭时仍注册只读自检服务");
});
