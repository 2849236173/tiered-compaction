[English](README.en.md) | [简体中文](README.md)

# Fix: session reports `compaction turn must be a non-negative safe integer`

## Symptom

A group chat or session in DSH cannot be opened, with the message:

```
stored session "session-xxx" is corrupt: stored log is corrupt:
SessionFormatError: compaction turn must be a non-negative safe integer
raw log: C:\Users\<你>\.dsh\sessions\<工作区>\session-xxx\session.v4.jsonl.zstd
```

## Cause

Versions before 0.3.0 wrote `compaction/start` and `compaction/end` events with only `compactionId` in `data`, missing `turn`.

The host's v4 session format has a hard requirement for this field:

```
Compaction events must have data.turn as a non-negative safe integer, equal to the currently open turn
(see Relationships.compact of dsh-session-format-v3-to-v4)
```

The key point: **it does not error at write time; corruption is only judged at read time**. So the corruption accumulates silently and only explodes the next time the session is loaded.

## Fix

### Step 1: upgrade the plugin

Fixed since 0.3.0 (`openTurnOf()` in `src/contract.js`); newly written sessions will no longer have this problem.

### Step 2: repair existing corrupted sessions

Already-corrupted sessions need the field filled in. Use the script in this directory:

```powershell
# Back up first
Copy-Item "<会话目录>\session.v4.jsonl.zstd" "<会话目录>\session.v4.jsonl.zstd.bak"

# Dry run (writes no files), confirming how many lines change and to what
node docs\修复\fix-compaction-turn.mjs "<会话目录>\session.v4.jsonl.zstd" "$env:TEMP\fixed.zstd"

# After confirming, apply
node docs\修复\fix-compaction-turn.mjs "<会话目录>\session.v4.jsonl.zstd" "$env:TEMP\fixed.zstd" --apply

# Overwrite back with the fixed file (the original is already backed up)
Copy-Item "$env:TEMP\fixed.zstd" "<会话目录>\session.v4.jsonl.zstd" -Force
```

Then restart DSH.

## What the script does

1. Decompresses zstd frame by frame and assembles the full text
2. Scans all `compaction/*` events, finding those whose `data.turn` is missing or invalid
3. For each, walks the event stream backwards to find the nearest `turn/start` and fills in its `turn` value
4. Changes only those lines, leaving every other character untouched (the script's self-check compares consistency)
5. Recompresses and writes back

## How to verify

The script has triple self-verification:

- After the fix, decompress again and confirm the `turn` of all `compaction` events is valid
- The text matches the expectation character by character
- The output line count matches the original file

If you want an even stricter confirmation, you can validate with the host's own validator (the script already compared against it at runtime using the `restoreReleasedV4Artifact` logic):

```js
const { restoreReleasedV4Artifact } = await import(
  'file:///G:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js'
);
// Pass the header (with the outer type field removed) together with the events; passing means it loads normally
```

## Notes

- **Back up first**. The script only adds (fills in fields) and does not change existing content, but keeping a backup is still recommended.
- This script fixes only this one kind of corruption (missing `turn`). If the session is corrupt for another reason (for example, a broken multi-frame structure), it will not fix it and will error out during its self-check.
- Close DSH during the repair to avoid write conflicts.
