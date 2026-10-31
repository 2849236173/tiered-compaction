/**
 * D30（beta3 审计 S1/S4）：tiered_restore 的路径约束与摘要口径。
 *
 * 运行：node --test test/d30-restore-confine.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spillIfNeeded, restoreSpilled } from "../src/spill-to-disk.js";
import { prunedContent } from "../src/tool-result-observer.js";

const UNREADABLE = /存档不可读/;
const ZERO = "0".repeat(64);

async function fixture() {
    const work = await mkdtemp(join(tmpdir(), "d30-restore-"));
    const archiveDir = join(work, "archive");
    await mkdir(archiveDir);
    const secret = join(work, "outside-secret.env");
    await writeFile(secret, "API_KEY=sk-test\n");
    const spilled = await spillIfNeeded(`${"x".repeat(9000)}\nEND`, archiveDir, "arbitrated-sess1234-1-abc");
    return { work, archiveDir, secret, spilled };
}

test("S4 预览给出的 16 位前缀与完整 64 位都能回读", async () => {
    const { archiveDir, spilled } = await fixture();
    const shown = /sha256 ([0-9a-f]+)…/.exec(prunedContent(spilled.preview, spilled)[0].text)[1];
    assert.equal(shown.length, 16);
    assert.ok((await restoreSpilled(spilled.path, shown, { archiveDir })).endsWith("END"));
    assert.ok((await restoreSpilled(spilled.path, spilled.sha256, { archiveDir })).endsWith("END"));
    assert.ok((await restoreSpilled(spilled.path, spilled.sha256.toUpperCase(), { archiveDir })).endsWith("END"));
});

test("S1/S4 摘要只收 16-64 位十六进制；校验失败不回显实际摘要", async () => {
    const { archiveDir, spilled } = await fixture();
    for (const bad of ["", "0", spilled.sha256.slice(0, 15), "z".repeat(16), `${spilled.sha256}0`, "../../etc"]) {
        await assert.rejects(() => restoreSpilled(spilled.path, bad, { archiveDir }), /16-64 位十六进制/, `应拒绝 ${bad}`);
    }
    const error = await restoreSpilled(spilled.path, ZERO, { archiveDir }).catch((e) => e);
    assert.match(error.message, /SHA-256 校验失败/);
    assert.ok(!error.message.includes(spilled.sha256), "报错不得回显文件真实摘要");
    assert.ok(!error.message.includes(spilled.sha256.slice(0, 16)));
});

test("S1 存档目录外的路径一律拒绝，且「不存在」与「越界」报错相同", async () => {
    const { archiveDir, secret } = await fixture();
    const attempts = [
        secret,
        join(archiveDir, "..", "outside-secret.env"),
        "..\\outside-secret.env",
        "../outside-secret.env",
        "C:\\Windows\\win.ini",
        "\\\\127.0.0.1\\c$\\Windows\\win.ini",
        "//127.0.0.1/c$/Windows/win.ini",
        join(archiveDir, "nope.txt"),
        archiveDir,
    ];
    const messages = new Set();
    for (const path of attempts) {
        const error = await restoreSpilled(path, ZERO, { archiveDir }).catch((e) => e);
        assert.ok(error instanceof Error, `应拒绝 ${path}`);
        assert.match(error.message, UNREADABLE, path);
        assert.equal(error.code, undefined, "不得透出 ENOENT 等 errno");
        messages.add(error.message);
    }
    assert.equal(messages.size, 1, "所有拒绝必须是同一句话，不能当文件探测 oracle");
});

test("S1 存档目录内的符号链接不跟随", async (t) => {
    const { archiveDir, secret } = await fixture();
    const link = join(archiveDir, "link.txt");
    try {
        await symlink(secret, link);
    } catch (error) {
        t.skip(`本机无法创建符号链接：${error.code}`);
        return;
    }
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update("API_KEY=sk-test\n").digest("hex");
    await assert.rejects(() => restoreSpilled(link, digest, { archiveDir }), UNREADABLE);
});

test("S1 存档目录内的相对文件名可回读（相对 archiveDir 解析）", async () => {
    const { archiveDir, spilled } = await fixture();
    const name = spilled.path.split(/[\\/]/).at(-1);
    assert.ok((await restoreSpilled(name, spilled.sha256, { archiveDir })).endsWith("END"));
});
