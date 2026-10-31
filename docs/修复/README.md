**简体中文** | [![English](https://img.shields.io/badge/docs-English-blue)](README.en.md)


# 修复：会话报 `compaction turn must be a non-negative safe integer`

## 症状

DSH 里某个群聊或会话打不开，提示：

```
stored session "session-xxx" is corrupt: stored log is corrupt:
SessionFormatError: compaction turn must be a non-negative safe integer
raw log: C:\Users\<你>\.dsh\sessions\<工作区>\session-xxx\session.v4.jsonl.zstd
```

## 原因

0.3.0 之前的版本写 `compaction/start`、`compaction/end` 事件时，`data` 里只写了 `compactionId`，漏了 `turn`。

宿主 v4 会话格式对这个字段是硬性要求：

```
压缩事件 data.turn 必须是非负安全整数，且等于当前打开的 turn
（见 dsh-session-format-v3-to-v4 的 Relationships.compact）
```

关键在于：**写入时不报错，读取时才判定损坏**。所以损坏会静默积累，直到下次加载会话才炸。

## 修复

### 第一步：升级插件

0.3.0 起已修复（`src/contract.js` 的 `openTurnOf()`），新写入的会话不会再有问题。

### 第二步：修既有损坏会话

已损坏的会话需要补字段。用本目录的脚本：

```powershell
# 先备份
Copy-Item "<会话目录>\session.v4.jsonl.zstd" "<会话目录>\session.v4.jsonl.zstd.bak"

# 演练（不写文件），确认要改几行、改成什么
node docs\修复\fix-compaction-turn.mjs "<会话目录>\session.v4.jsonl.zstd" "$env:TEMP\fixed.zstd"

# 确认无误后应用
node docs\修复\fix-compaction-turn.mjs "<会话目录>\session.v4.jsonl.zstd" "$env:TEMP\fixed.zstd" --apply

# 把修好的文件覆盖回去（原文件已有备份）
Copy-Item "$env:TEMP\fixed.zstd" "<会话目录>\session.v4.jsonl.zstd" -Force
```

然后重启 DSH。

## 脚本做了什么

1. 逐帧解压 zstd，拼出完整文本
2. 扫描所有 `compaction/*` 事件，找出 `data.turn` 缺失或非法的
3. 对每条，从事件流反向找最近的 `turn/start`，取它的 `turn` 值补上
4. 只改这几行，其余逐字符不动（脚本自校验会比对一致性）
5. 重新压缩写回

## 验证方法

脚本自带三重复核：

- 修完后重新解压，确认 `compaction` 事件的 `turn` 全部合法
- 文本与预期逐字符一致
- 输出行数与原文件一致

如果还想做更严格的确认，可以用宿主自己的校验器验证（脚本运行时已按 `restoreReleasedV4Artifact` 的逻辑对照过）：

```js
const { restoreReleasedV4Artifact } = await import(
  'file:///G:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js'
);
// header 去掉外层 type 字段后连同 events 传入，能过即代表可正常加载
```

## 注意事项

- **先备份**。脚本只做加法（补字段），不改已有内容，但仍建议留备份。
- 这个脚本只修 `turn` 缺失这一种损坏。如果会话是别的原因损坏（例如多帧结构被破坏），它不会修，会在自校验阶段报错退出。
- 修复期间请关闭 DSH，避免写入冲突。

---

# 另外两种损坏（0.4.0-beta.4 起提供脚本）

先用宿主自己的校验器确认是哪一种：

```powershell
node docs\修复\host-validate.mjs "<会话目录>\session.v4.jsonl.zstd"
```

输出 `HOST_VALIDATE OK` 表示宿主能正常加载；输出 `FAIL` 时看后面的错误信息。

## `compaction/prune shadowedSeqs do not name an exact current surface span`

- **原因**：0.4.0-beta.3 之前多个 preset 挂载时 observer 会重复处理同一条工具结果，写出「prune(X) → 替换 X → 又一次 prune(X)」。第二条 prune 指向已经不在表面上的 X。
- **修法**：`fix-duplicate-prune.mjs` 删掉第二条重复 prune，后面事件的 seq 重新压实，并改写所有 seq 引用。它只认这一种模式，遇到不认识的情况会直接退出、不写文件。

```powershell
node docs\修复\fix-duplicate-prune.mjs "<会话目录>\session.v4.jsonl.zstd" "$env:TEMP\fixed.zstd"           # 演练
node docs\修复\fix-duplicate-prune.mjs "<会话目录>\session.v4.jsonl.zstd" "$env:TEMP\fixed.zstd" --apply   # 写出
node docs\修复\host-validate.mjs "$env:TEMP\fixed.zstd"                                                   # 必须 OK 再覆盖
```

## `compaction/summary has no matching compaction/start`

- **原因**：0.4.0-beta.3 及之前手动 `/compact` 写的 `compaction/summary` 漏了 `sourceCommandId`。
- **修法**：`fix-summary-cmd.mjs` 从配对的 `compaction/start` 把它补回来，其余行逐字不动。

```powershell
node docs\修复\fix-summary-cmd.mjs "<会话目录>\session.v4.jsonl.zstd" "$env:TEMP\fixed.zstd"
node docs\修复\host-validate.mjs "$env:TEMP\fixed.zstd"
```

两种都一样：**先备份、关掉 DSH、校验 OK 后再覆盖**。
