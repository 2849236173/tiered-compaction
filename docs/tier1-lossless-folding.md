[English](tier1-lossless-folding.md) | [简体中文](第1层-无损折叠.md)

# Tier 1 · Lossless Folding

**Goal**: compress repetitive content, and **restore it byte-exact**. Zero LLM cost.

## Problem

Heavy repetition in tool output is the norm — heartbeats in build logs, polling output, the results of running the same command again and again. They occupy the context but carry almost no information.

Naive "deduplication" loses information. The constraint of this layer is: **folding must be reversible**.

## Algorithm

```
Input: raw text
  │
  ├─ Scan line by line, find blocks repeated consecutively ≥3 times
  │
  ├─ Replace each block with: first line + one folding marker line
  │     …[folded Nx]
  │
  ├─ Generate the inverse-transform record runs:
  │     each entry records "original line number → repeat count → first line content"
  │
  └─ Net-gain criterion: the folded byte count must be smaller than the original, otherwise give up this fold
```

## Net-Gain Criterion

Folding itself also costs bytes (markers, records). If the savings do not offset the marker overhead, the fold is a wasted effort.

The criterion uses **bytes**, not character count: a Chinese character has UTF-16 length 1 but 3 UTF-8 bytes; judging by character count underestimates the real size of Chinese content by a factor of three, causing content that should be folded to be left alone, or content that should not be folded to grow after folding.

## Reversibility

Each entry in the inverse-transform record `runs` records three fields:

| Field | Meaning |
|---|---|
| `start` | The **real line number in the original text** of that repeated block |
| `count` | The repeat count |
| `lines` | The actual folded content |

Restoration rebuilds block by block along `runs` and **verifies that `start` matches the rebuilt position** — when a record has been tampered with, verification fails instead of silently restoring the wrong content.

This verification blocks four kinds of tampering: modifying `runs`, modifying `count`, modifying `start`, and forging an entire record.

## Folded Originals Must Be Spilled to Disk

Fold records live only in memory and are gone when the process restarts. So **when a fold happens, the original is written to the archive at the same time**, and the lineage table records "original location → archive path + digest".

This way the original can still be restored even after a process restart. An early implementation wrote only a `fold:1` string into the lineage instead of a file path, meaning the original was permanently lost after folding — this was a P0 that got fixed.

## Relationship with Tier 2

If the folded text **still** exceeds the spill threshold (8KB), what gets spilled is the **folded text**, but the archive must contain the **pre-fold** original.

Otherwise Tier 2's SHA-256 verification would put its stamp on Tier 1's information loss — verification passes, content already gone.

## Related Code

`src/lossless-fold.js` —— `foldRepeatedLines` / `unfold` / `foldRatio`

## Acceptance Criteria

| Item | Standard |
|---|---|
| Reversible | Restore after folding matches the original byte-exact |
| Tamper detection | Modifying `runs` / `count` / `start` anywhere makes restoration fail |
| Net gain | Folded byte count < original, otherwise do not fold |
| Original spilled | Fold record carries the archive path and digest |
| Chinese-safe | Chinese repeated lines remain byte-exact restorable after folding |
