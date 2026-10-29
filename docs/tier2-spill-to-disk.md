English | [![简体中文](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue)](第2层-落盘.md)


# Tier 2 · Spill to Disk

**Goal**: store oversized tool output entirely on disk, leaving in the context only a preview that can locate the original. Zero LLM cost.

## Problem

A single build log, a single full-repo `grep` search, a single test output — often hundreds of thousands of characters. Keeping it all in the context fills the window quickly; discarding it directly means the model can never get this information again.

Solution: **archive the original in full, leave a signpost in the context**.

## Trigger Condition

Spill only when exceeding **8192 bytes** (UTF-8).

Why by bytes and not characters: `"中文".length === 2`, but UTF-8 is 6 bytes. Judging by character count lets 8000 Chinese characters (~24KB) slip past the threshold, and the spill layer effectively fails in Chinese scenarios.

## Preview Budget

The preview left in the context is capped at **5120 characters**, with a head-to-tail ratio of **4:1**:

```
Original 10,433 characters
  ↓
┌──────────────────────────────┐
│ Head ~4096 characters (command, args, paths) │
│ …[middle omitted, 6000 characters, see archive]    │
│ Tail ~1024 characters (conclusions, error codes)   │
└──────────────────────────────┘
```

**Why 5120 / 4:1**: it aligns with the budget of the official DSH `dsh-compaction-tool-result-pruner` (`headChars 4096` + `tailChars 1024`). The official judgment is that the beginning carries more information — command, args, and paths are all at the beginning; the tail keeps conclusion lines (`exit code`, `pass/fail` counts, summary lines).

**Why keeping only 5120 is enough**: the original is 100% archived, and the model can `read` it back at any time. The official pruner is "cut and gone", so it must keep more; we store one extra layer, so we can keep less.

## Archive Format

| Item | Content |
|---|---|
| Path | `<archiveDir>/<session-id>-<seq>.txt` |
| Content | Raw text (UTF-8, byte-exact) |
| Verification | SHA-256 recorded in the lineage table |
| Anti-overwrite | If a file with the same name exists, append `-2`, `-3`; never silently overwrite |

**Why never overwrite**: the archive is the only thing from which the original can be restored after compaction. If it gets overwritten, the lineage table still points to that path, and reading back gets someone else's content with no warning at all — it gets worse the more you use it.

## Restoration

`restoreSpilled(path, expectedSha256)`:

1. Read the file
2. Compute SHA-256
3. Compare with the expected value; error out on mismatch

**UTF-8 round-trip check**: before spilling, verify `Buffer.from(text).toString() === text`. JS strings can contain lone surrogates (illegal UTF-16 sequences), which get replaced with `U+FFFD` when written to a file, causing "SHA verification passes, content has been altered". This check happens before spilling; on failure the write is refused.

## Safety Boundaries of the Preview

Slicing must not be a raw cut on UTF-16 code units:

- **Surrogate pairs**: emoji and similar characters take 2 code units; cutting in the middle produces lone surrogates → written to file as `U+FFFD`
- **CRLF**: cutting makes the head end with a lone `\r` and the tail begin with a lone `\n`

When the cut point lands inside a surrogate pair, shift by one; when the tail would begin with a lone `\n` and the previous position is `\r`, back off by one as well.

## Related Code

`src/spill-to-disk.js` —— `spillIfNeeded` / `restoreSpilled` / `headTailPreview` / `sha256` / `byteLength`

## Acceptance Criteria

| Item | Standard |
|---|---|
| Byte-exact restoration | Chinese/English, emoji, CRLF, and pure newlines all restore |
| Threshold consistency | 8k Chinese characters (~24KB) must spill |
| No overwrite | When a file with the same name exists, append a sequence number; the original file content is unchanged |
| Tamper detection | Restoration fails after the archive content is modified |
| Preview within budget | Total length including the omission marker ≤ 5120 |
| Chinese-safe | Preview slicing produces no lone surrogates or lone CRLF |
