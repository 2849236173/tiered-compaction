English | [![简体中文](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue)](架构与设计理念.md)


# Architecture and Design Philosophy

> This document explains the overall architecture, core design trade-offs, and key mechanisms of dsh-tiered-compaction.
> It is aimed at readers who want to understand why it is designed this way, or who want to build on top of it.

**Companion documents**: [architecture diagram](架构图.html) (interactive, open in a browser) ·
[Tier 1](第1层-无损折叠.md) · [Tier 2](第2层-落盘.md) · [Tier 3](第3层-软压力.md) · [Tier 4](第4层-有损摘要.md) ·
[Data structures](data-structures.md)

---

## 1. The problem being solved

The context of a long LLM session is a ledger that only grows and never shrinks. DSH's default compaction strategy is **one shot**: when pressure reaches 80%, it makes one LLM summarization call and replaces the whole history with a summary node.

This path has three inherent costs:

| Problem | Cause | Measured behavior |
|---|---|---|
| **Expensive** | Every compaction is a full LLM call | Latency and cost become significant under frequent compaction |
| **Information loss** | Summary output has a token cap, so long content is truncated | 2,462 of 22,690 summarization calls were truncated by more than half |
| **Losing the middle** | Truncate first, then summarize — facts in the middle of long messages are lost first | And that is often the most critical part |

This plugin's judgment: **most context slimming does not need a model at all.**

Large parts of tool output are repeated logs, over-long file contents, and command results that can be rerun at any time — deterministic rules can compress these, with a guarantee of lossless reversibility. Content that truly needs "understanding and summarizing" is far less than intuition suggests.

Hence the four-tier progression: **pushing the LLM from the first line of defense to the last.**

---

## 2. Four-tier pipeline architecture

```
                         Tool output produced
                              │
                              ▼
    ┌─────────────────────────────────────────────────┐
    │  Tier 1 · Lossless folding  (lossless-fold)      │
    │  ─────────────────────────────────────           │
    │  Consecutive duplicate lines ≥3 → "first line + …[folded Nx]" │
    │  Each fold generates an inverse transform record │
    │  Restoration verifies byte by byte; mismatch throws │
    │                                                   │
    │  Cost: zero LLM       Reversibility: fully reversible │
    └────────────────────┬────────────────────────────┘
                         │  Still over threshold after folding
                         ▼
    ┌─────────────────────────────────────────────────┐
    │  Tier 2 · Spill to disk  (spill-to-disk)         │
    │  ─────────────────────────────────────           │
    │  >8 KB (UTF-8 bytes) → full text written to disk + SHA-256 │
    │  Context keeps only head/tail previews (5120 chars, 4:1) + archive path │
    │                                                   │
    │  Cost: zero LLM       Reversibility: full text on disk, readable back │
    └────────────────────┬────────────────────────────┘
                         │
                         ▼
    ┌─────────────────────────────────────────────────┐
    │  Tier 3 · Soft pressure  (soft-pressure)         │
    │  ─────────────────────────────────────           │
    │  70% window → insert reminder (history unchanged)│
    │  80% window → evict volatile content by priority │
    │                                                   │
    │  Eviction priority:                              │
    │    1. Large bash/pwsh/edit/write output (not replayable) │
    │    2. read/grep/glob results (rerun to restore)  │
    │    3. System reminders / temporary injections    │
    │    Never evicted: todo/goal/plan/user messages/summary nodes │
    │                                                   │
    │  Cost: zero LLM       Reversibility: replayable items restored by rerun │
    └────────────────────┬────────────────────────────┘
                         │  Pressure reaches threshold
                         ▼
    ┌─────────────────────────────────────────────────┐
    │  Tier 4 · Lossy summarization  (lossy-summarize) │
    │  ─────────────────────────────────────           │
    │  Threshold = window − max(16k, 5% window) − summary reserve (20k) │
    │  Summary budget reserved in advance, preventing the truncation loop │
    │  Full archive before summarizing; lineage registered after │
    │  Input is not truncated first (avoids losing the middle) │
    │                                                   │
    │  Cost: one LLM call   Reversibility: full archive before summarizing │
    └─────────────────────────────────────────────────┘
```

### Why "progressive" rather than "parallel"

The four tiers are a **serial short-circuit** relationship, not a pick-one-of-four:

- If the output is already small enough after Tier 1 folding, Tier 2 does not spill (avoiding the same content being processed redundantly by two tiers)
- No matter how the first three tiers process content, Tier 4 does not start unless pressure reaches the threshold
- The arbiter guarantees **each piece of content is handled by exactly one tier**, preventing semantic corruption from multi-tier stacking

This "short-circuit" is adjudicated uniformly by the arbiter in `circuit-breaker.js`, not by each tier itself — centralized adjudication is what guarantees no overlap and no gaps.

---

## 3. Three fidelity principles

Two of the four tiers are lossy (eviction, summarization). The premise for daring to do lossy operations is that **every loss is traceable and recoverable**. These three principles run through all tiers and are this project's most core design constraint.

### Principle 1: every tier keeps a recovery mechanism

| Tier | Recovery mechanism |
|---|---|
| 1 Lossless folding | Inverse transform record + byte-by-byte verification on restoration |
| 2 Spill to disk | SHA-256 verification + full file kept in the archive directory |
| 3 Soft pressure | Evicted items record their original location; read/grep/glob rerun to restore |
| 4 Lossy summarization | A full archive is made before summarizing; the original is never lost |

Key point: **the recovery mechanism is not "best effort" — it is verified.** Tier 1's inverse transform throws directly on a mismatch, rather than silently returning wrong content.

### Principle 2: superseded references go into the lineage table, never silently deleted

Whenever content is superseded by folding/spilling/eviction/summarization, a triple is registered in the lineage table:

```
Original location  →  New location  →  Superseder
node#42 →  archive/xxx.txt  →  spill-to-disk
```

This makes "where did this piece of information go" answerable forever. A compaction system without a lineage table can only guess once something goes wrong.

### Principle 3: the compaction system itself has a circuit breaker and an arbiter

**The compaction layer must not become a new source of failure.** Therefore:

- A single tier failing consecutively up to the threshold → trip the circuit on that tier, automatically degrade, skip, and warn; the main flow continues with the original content
- After the cooling period, one probe call is allowed; success restores the tier
- The arbiter decides which tier content belongs to, avoiding redundant multi-tier processing

This principle comes from a concrete lesson: compaction is a bypass that exists "to help" — its failure must never drag down the main session.

---

## 4. Bypass pipeline: goal-switch cleanup

Besides the four-tier main pipeline, there is a **deterministic bypass** (`goal-switch.js`) that handles "what happens to old context when the task switches".

```
New goal explicitly declared (structured event)
        │
        ▼
Pack old goal state → structured capsule (todo / goal / plan)
        │
        ▼
Process content (large outputs, intermediate artifacts) → archived to the session directory
        │
        ▼
Zero LLM calls
```

By design it deliberately **only recognizes explicit signals** and does no semantic auto-detection. The reason: automatically deciding "whether the user has changed topics" has too high a misjudgment rate, and the cost of wrongly cleaning up far exceeds the benefit.

---

## 5. Relationship with the host: service slot competition

DSH's `compaction` service slot is **single-slot** — the official basic, glm, kiro, and other implementations all mount onto this one slot. This is the core constraint this plugin must handle.

```
                    ctx.compaction (single slot)
                            │
              ┌─────────────┴─────────────┐
              │                           │
        enabled = false            enabled = true
              │                           │
              ▼                           ▼
    Register read-only self-check    construction-catch probe
    service only (tieredCompaction)        │
              │                  ┌──────┴──────┐
              │                  │             │
              │              Slot free      Slot taken
              │                  │             │
              │                  ▼             ▼
              │            Take over service   Degrade to "tiers 1-2 bypass mode"
              │            slot (all four tiers) (folding + spilling keep running,
              │                            tiers 3-4 suspended)
              ▼
        Fully coexists with basic
        Zero behavior change
```

### Why construction-catch instead of `ctx.get`

There are two ways to probe slot occupancy; only one is safe:

| Approach | Result |
|---|---|
| `ctx.get('compaction')` | ❌ **Force-instantiates** a lazily declared engine, occupying the slot against yourself |
| Construct the service class directly and catch the registration conflict | ✅ Throws on conflict; catch it, resolve the holder, then degrade |

This is a pitfall learned from real testing in the headless environment. `ctx.get` looks like a "query" but is actually a "create" — using it to probe means occupying the slot yourself, then concluding "the slot is taken".

### Why degradation is "tiers 1-2 bypass"

Tiers 1-2 (folding, spilling) conflict with no compaction mode — they only shrink the volume of tool output and do not touch session structure. So when the slot is taken:

- Tiers 1-2 **keep working** (still saving tokens)
- Tiers 3-4 are **suspended** (these two tiers modify the session surface and would clash with another engine)

This is the practical meaning of "don't fight, don't crash".

---

## 6. Integrating with the host: observer pattern

The host produces tool results as a `session/event` stream. This plugin integrates through an observer rather than modifying the tool layer.

```
Host appends tool/result event
        │
        ▼
 session/event hook (synchronous dispatch, no await)
        │
        ▼
 ToolResultObserver.handleEvent
        │
        ├── Exclude replacement events written back by itself (prevent recursion)
        ├── Per-session isolated deduplication (prevent duplicate processing)
        ├── Claim the slot before any await (prevent concurrency races)
        │
        ▼
 Tiers 1-2 processing (fold → spill)
        │
        ├── No benefit → return directly
        └── Benefit → write back to the session surface
                        │
                        ▼
              ① append compaction/prune (shadow pricing)
              ② append tool/result + surfaceOp:replace (replacement)
```

### Two host conventions that must be obeyed

**1. Shadow pricing must precede replace, with no other event in between**

The host's `token-meter` performs strict validation: the replace event's range must exactly match the immediately adjacent shadow pricing claim, otherwise it throws `has no adjacent shadow price`.

Since `session/event` listeners are **dispatched synchronously with no awaited return value**, any gap crossing an await can be interleaved by another event. So the "shadow pricing + replace" two steps must be written tightly together.

**2. Only replace tool/result, never touch assistant tool-call**

Replacing a tool result itself does not break tool-pairing (call/result pairing); but once an assistant message is replaced, the pairing may break, causing the host to judge the session corrupt.

---

## 7. Key design trade-offs

| Trade-off | Choice | Rationale |
|---|---|---|
| Summary trigger point | window − 16k/5% guard − 20k reserve | The reserve must be subtracted explicitly, otherwise the summary itself blows up the window into a loop |
| Summary input | Do not truncate first | Truncating before summarizing loses facts in the middle of long messages, and that is where information density is highest |
| Spill threshold | UTF-8 byte count, not character count | One Chinese character = 3 bytes; counting characters lets 8,000 Chinese characters (24 KB) miss the spill |
| Preview length | Fixed 5120 characters (head/tail 4:1) | Aligns with the official pruner's convention, predictable; extreme information loss in very long texts is backstopped by "full text in the archive" |
| Dedup set | Isolated per session (WeakMap) | A process-level Set keyed by seq causes "silently ineffective after the first session" |
| Pressure reading | Window taken from the `request/context` event | The real `TokenMeter` has no `contextWindow()` method; taking the wrong method makes pressure always 0 |
| Summary call | `ctx.llm.stream()` | The real llm service has no `summarize` method; and stream can reuse the server-side prefix cache |
| Slot probing | construction-catch | `ctx.get` force-instantiates and occupies the slot against yourself |

---

## 8. Failure and degradation design

Compaction is a bypass — **under no circumstances may it drag down the main session**. All failure paths converge to "degrade" rather than "throw upward":

| Failure | Handling |
|---|---|
| A single tier fails consecutively | Trip the circuit on that tier; the main flow continues with the original content |
| Observer processing error | Record a warning, no processing, session continues as usual |
| Slot taken | Degrade to tiers 1-2 bypass mode |
| Summary returns empty | Refuse to commit the transaction; pair with a `compaction/end` |
| Summary larger than the original | Refuse to commit (preventing "compacting" into something bigger) |
| Pressure reading unavailable | Fall back to the conservative path; do not force a trigger |

---

## 9. Known boundaries

- **Host version binding**: the contract layer aligns with DSH 0.2.x's `CompactionEngine` interface; after a host major version upgrade, the method surface must be re-verified.
- **Handles plain-text tool results only**: rich blocks containing images/attachments are always skipped, to avoid breaking structure.
- **Pressure reading depends on the `request/context` event**: falls back to the conservative path when the provider does not emit this event.
- **The preview is a fixed budget**: information loss on very large output is an accepted design cost — the original is always in the archive.

---

## 10. The two sources of the design ideas

- **Four-tier progression + three fidelity principles + goal-switch bypass**: borrows ideas from `pi-maestro-flow`'s compaction module (ideas only, no code — it is deeply bound to Pi's API).
- **The implementation paradigm for tool result replacement**: aligns with DSH's official `dsh-compaction-tool-result-pruner` two-step approach (shadow pricing → surfaceOp replace), guaranteeing compatibility with the host's projection and metering chains.
