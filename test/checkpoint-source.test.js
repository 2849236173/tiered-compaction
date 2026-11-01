import { test } from "node:test";
import assert from "node:assert/strict";
import { compactCheckpointSource, isCompactCheckpointSource, sessionFormatVersion } from "../src/checkpoint-source.js";

// 回归：CLI 版 dsh-compaction 0.1.x 产出 { kind: "plugin" }，被 Desktop session format v4 拒写
test("v4 session 产出 compact-checkpoint kind", () => {
    const v = sessionFormatVersion({ header: { version: 4 } });
    assert.deepEqual(compactCheckpointSource("c1", "s1", v), { kind: "compact-checkpoint", compactionId: "c1", sourceCommandId: "s1" });
});

test("v4 之前的 session 保持旧写法", () => {
    const v = sessionFormatVersion({ header: { version: 0 } });
    assert.deepEqual(compactCheckpointSource("c1", undefined, v), { kind: "plugin", plugin: "compact", compactionId: "c1" });
});

test("读不到格式版本时按当前格式处理", () => {
    assert.equal(sessionFormatVersion({}), undefined);
    assert.equal(sessionFormatVersion(undefined), undefined);
    assert.equal(compactCheckpointSource("c1", undefined, undefined).kind, "compact-checkpoint");
});

test("两代写法都识别为检查点", () => {
    assert.ok(isCompactCheckpointSource({ kind: "compact-checkpoint", compactionId: "c" }));
    assert.ok(isCompactCheckpointSource({ kind: "plugin", plugin: "compact", compactionId: "c" }));
    assert.ok(!isCompactCheckpointSource({ kind: "plugin", plugin: "other" }));
    assert.ok(!isCompactCheckpointSource(null));
});
