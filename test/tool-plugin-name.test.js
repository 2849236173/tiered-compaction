/**
 * 安装侧护栏测试：插件包名必须从「实际装了什么」推导，不能写死 scope。
 *
 * 背景（2026-10-30）：0.2.0 包名去掉 `@local/` scope 后，生成器仍写
 * `@local/dsh-tiered-compaction`，导致 preset 行 import 失败被吞成
 * `tiered-compaction (@local/dsh-tiered-compaction): never started`，
 * 会话 resume 直接失败，而且错误信息里看不到真因。
 * 这里把「解析 / 自愈 / 报警」三条路都钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    PluginNameError,
    assertNoStaleScopeNames,
    isPluginPackageName,
    optionValue,
    probePackageName,
    resolvePluginName,
} from "../tools/lib/plugin-name.mjs";

/**
 * 造一个最小 profile：可选地把包放进 node_modules（模拟已装/未装）。
 * @param {{pkgName?: string, manifestName?: string, bundles?: string[], dependencies?: boolean, install?: boolean}} options
 */
function makeProfile(options = {}) {
    const {
        pkgName = "dsh-tiered-compaction",
        manifestName = pkgName,
        bundles = [pkgName],
        dependencies = true,
        install = true,
    } = options;

    const dir = mkdtempSync(join(tmpdir(), "tc-plugin-name-"));
    if (install) {
        const pkgDir = join(dir, "node_modules", ...pkgName.split("/"));
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(join(pkgDir, "index.js"), "export const apply = () => {};\nexport const detach = () => {};\n");
        writeFileSync(
            join(pkgDir, "package.json"),
            JSON.stringify({ name: manifestName, version: "9.9.9", type: "module", main: "index.js" }),
        );
    }
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
            name: "profile-fixture",
            dependencies: dependencies ? { [pkgName]: "link:./nowhere" } : {},
            dsh: { profile: { bundles } },
        }),
    );
    return dir;
}

/** 用完即删，避免临时目录堆积。 */
function withProfile(options, run) {
    const dir = makeProfile(options);
    try {
        return run(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("无 scope 的包名能解析（正常装置 / 正式 github 装）", () => {
    withProfile({}, (dir) => {
        const probe = probePackageName(dir, "dsh-tiered-compaction");
        assert.equal(probe.ok, true);
        assert.equal(probe.version, "9.9.9");
        assert.equal(resolvePluginName({ profileDir: dir }), "dsh-tiered-compaction");
    });
});

test("带 scope 的包名也能解析（只有真的装了该 scope 时才可以这么写）", () => {
    withProfile({ pkgName: "@local/dsh-tiered-compaction" }, (dir) => {
        assert.equal(resolvePluginName({ profileDir: dir }), "@local/dsh-tiered-compaction");
    });
});

test("bundles 优先于 dependencies（宿主真正挂载的清单说了算）", () => {
    withProfile(
        { pkgName: "dsh-tiered-compaction", bundles: ["dsh-tiered-compaction"] },
        (dir) => {
            assert.equal(resolvePluginName({ profileDir: dir }), "dsh-tiered-compaction");
        },
    );
});

test("bundles 为空时回落到 dependencies", () => {
    withProfile({ bundles: [] }, (dir) => {
        assert.equal(resolvePluginName({ profileDir: dir }), "dsh-tiered-compaction");
    });
});

test("候选包名解析不到 → 报错，并提示包名必须与已装包 name 一致", () => {
    withProfile({ install: false }, (dir) => {
        assert.throws(
            () => resolvePluginName({ profileDir: dir }),
            (error) => {
                assert.ok(error instanceof PluginNameError);
                assert.match(error.message, /候选包名全部解析失败/);
                assert.match(error.message, /package\.json 的 name 完全一致/);
                assert.match(error.message, /add dsh-tiered-compaction/);
                return true;
            },
        );
    });
});

test("profile 里压根没登记本插件 → 报错并给出装法", () => {
    withProfile({ bundles: [], dependencies: false }, (dir) => {
        assert.throws(
            () => resolvePluginName({ profileDir: dir }),
            (error) => {
                assert.match(error.message, /没有任何指向 dsh-tiered-compaction 的包/);
                assert.match(error.message, /link:H:\/project\/dsh-plugin\/tiered-compaction/);
                return true;
            },
        );
    });
});

test("目录存在但自报 name 不符 → 判定为不可用，不静默通过", () => {
    withProfile({ pkgName: "dsh-tiered-compaction", manifestName: "someone-else" }, (dir) => {
        const probe = probePackageName(dir, "dsh-tiered-compaction");
        assert.equal(probe.ok, false);
        assert.match(probe.reason, /package\.json 的 name 不是/);
    });
});

test("--plugin-name 覆盖：能解析则采信，解析不到则报错", () => {
    withProfile({}, (dir) => {
        assert.equal(resolvePluginName({ profileDir: dir, override: "dsh-tiered-compaction" }), "dsh-tiered-compaction");
        assert.throws(
            () => resolvePluginName({ profileDir: dir, override: "@local/dsh-tiered-compaction" }),
            (error) => {
                assert.match(error.message, /--plugin-name @local\/dsh-tiered-compaction/);
                return true;
            },
        );
    });
});

test("从 dump 兜底识别包名（profile 未登记时）", () => {
    withProfile({ bundles: [], dependencies: false }, (dir) => {
        const dumpText = ["- id: tiered-compaction", "  name: 'dsh-tiered-compaction'", "  config:", "    enabled: false"].join(
            "\n",
        );
        assert.equal(resolvePluginName({ profileDir: dir, dumpText }), "dsh-tiered-compaction");
    });
});

test("产物护栏：抓到历史遗留的 @local/ 行名", () => {
    const stale = ["- id: preset-standard", "  config:", "    plugins:", "      - id: tiered-compaction", "        name: '@local/dsh-tiered-compaction'"].join("\n");
    assert.throws(
        () => assertNoStaleScopeNames(stale, "dsh-tiered-compaction"),
        (error) => {
            assert.match(error.message, /与已装包不一致/);
            assert.match(error.message, /@local\/dsh-tiered-compaction/);
            return true;
        },
    );
    const healthy = stale.replace("@local/dsh-tiered-compaction", "dsh-tiered-compaction");
    assert.doesNotThrow(() => assertNoStaleScopeNames(healthy, "dsh-tiered-compaction"));
});

test("包名判定与参数解析的边界", () => {
    assert.equal(isPluginPackageName("dsh-tiered-compaction"), true);
    assert.equal(isPluginPackageName("@local/dsh-tiered-compaction"), true);
    assert.equal(isPluginPackageName("dsh-tiered-compaction-extra"), false);
    assert.equal(isPluginPackageName(undefined), false);
    assert.equal(optionValue(["--profile-dir", "C:/x"], "--profile-dir"), "C:/x");
    assert.equal(optionValue(["--diff-only"], "--profile-dir"), "");
});
