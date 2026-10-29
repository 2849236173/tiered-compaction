English | [![简体中文](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue)](第3层-软压力.md)


# Tier 3 · Soft Pressure

**Goal**: when window pressure rises, free up space with zero-cost means first. Zero LLM cost.

## Two Thresholds

```
Pressure < 70%        do nothing
        ≥ 70%        insert a reminder (history unchanged)
        ≥ 80%        start eviction
```

**70% reminds only**: write a log entry prompting the model to wrap up its tasks, **do not push a message into the session** — inserting a reminder itself costs tokens, and doing it when pressure has already risen is a counterproductive move.

**80% starts eviction**: remove replayable content by priority, lowest first.

## Eviction Priority

| Priority | Type | Reason |
|---|---|---|
| 1 | `bash` `pwsh` `edit` `write` | Execution-type; results can be recovered by re-running or reading files |
| 2 | `read` `grep` `glob` | Read-type; a re-run recovers the content |
| 3 | `system-reminder` | System prompt; can be rebuilt |
| Never | `todo` `goal` `plan` `user-message` `summary` | User intent and task state; once lost they cannot be rebuilt |

## Evict Only What Is Recoverable

Eviction is a **narrow path**:

- **Replayable** (`read` / `grep` / `glob`) → evict directly; the model recovers the content by re-running
- **Not replayable but archived** (`bash` / `edit` / `write`, with the original already in the archive) → evict, attaching the archive path
- **Not replayable and not archived** → **never evict**

An early implementation evicted unconditionally by the priority table, and `bash` output was deleted with no archive at all — permanent loss. This was a P0 that got fixed.

## Net-Gain Criterion

Eviction also produces markers and lineage records. If the evicted content is shorter than its own marker, eviction makes the context bigger.

So compute the net gain before evicting: **the bytes saved must be greater than the bytes added by the new marker**, otherwise skip.

## Deduplication with Tiers 1–2

Eviction records must be kept **separately** from the processing records of Tiers 1–2.

An early implementation shared one `done` set, causing Tier 3 to skip content it considered "already processed", or conversely to treat Tier 1–2 records as already evicted — two events appended per step, and the session log grows without bound.

## Cross-Session Isolation

Deduplication sets must be **isolated per session** (`WeakMap<session, {done, evicted}>`).

`seq` is a **per-session** sequence number; every session starts from 0. Bookkeeping with a process-level `Set` results in: the first session works normally, and all subsequent new sessions have every `seq` hit an old record → nothing gets processed → compaction silently fails, with zero errors reported.

## Related Code

`src/soft-pressure.js` —— `pressureAction` / `evictVolatile` / `EVICTION_PRIORITY`

## Acceptance Criteria

| Item | Standard |
|---|---|
| Threshold behavior | <70% do nothing, 70-80% remind only, ≥80% evict |
| Never evict | todo/goal/plan/user-message/summary with zero loss |
| No eviction without archive | Not-replayable and not-archived content must be kept |
| Net gain | Skip when eviction makes the context bigger |
| Cross-session | A new session's seq does not inherit the old session's dedup records |
| Dedup with Tiers 1–2 | Eviction records kept separate from folding/spill records |
