[English](data-structures.md) | [简体中文](数据结构.md)

# Data Structures

The plugin maintains only two kinds of persistent state: **session events** (owned by the host, read and written by the plugin) and the **lineage table** (owned by the plugin). Archive files are side-mounted entities.

## Session events

The plugin does not define custom event types; it only uses the host's existing types and appends bookkeeping events.

### Events read

| Type | Purpose | Content location |
|---|---|---|
| `user/message` | Selection content, compaction boundary | `data.content` |
| `assistant/message` | Selection content | `data.message.content` |
| `tool/result` | Processing target of tiers 1-2 | `data.message.content` |
| `system/message` | Session system header (not in selection) | `data.message.content` |
| `request/context` | Reads the context window size | `data.contextWindow` |
| `turn/start` `turn/end` | Gets the currently open turn | `data.turn` |

> The inconsistent content location is the host's real shape: only `user/message` hangs content at `data.content`, while all other messages hang it at `data.message.content`. Both must be tried, otherwise assistant replies and tool results cannot be read at all.

### Events written

| Type | When | Required fields |
|---|---|---|
| `compaction/start` | Summary transaction begins | `compactionId`, `turn` |
| `compaction/summary` | Summary completed | `compactionId`, `summary`, `shadowedRange`, `shadowedSeqs`, `shadowedTokenCount`, `provider`, `model` |
| `compaction/end` | Transaction ends (success or failure) | `compactionId`, `turn`, plus `error` on failure |
| `user/message` | Checkpoint write | content in three segments + `surfaceOp: {op:"replace"}` |

`turn` is required: the host's format contract requires this field on these events; when missing it does not error at write time, but is rejected during format validation, migration, or restoration.

## The surface (surface)

The session surface is a **position-ordered** node sequence; `session.surface.nodes` is an **array of seq numbers**.

**seq is not monotonic**: a `replace` puts the new event's seq back at the position of the replaced node. Therefore:

- Selecting a compaction range must use **position slicing** (`nodes.slice(startIdx, endIdx + 1)`), not `filter(seq >= start && seq <= end)`
- Filtering by numeric range misses nodes "positioned inside the range but with seq outside it", and makes head/tail comparison necessarily fail

## Lineage table

Whenever content is superseded, an entry is registered — never silently deleted.

```js
{
  id:               "seq#2403",              // Original location
  originalLocation: "seq#2403",
  newLocation:      "/archive/xxx.txt",      // New location; "-" if not moved
  replacedBy:       "spill-to-disk",         // Superseder
  digest:           "a1b2c3…"                // SHA-256, to match against the artifact
}
```

### `replacedBy` values

| Value | Meaning |
|---|---|
| `lossless-fold` | Folded by tier 1 |
| `spill-to-disk` | Spilled to disk by tier 2 |
| `soft-pressure` | Evicted by tier 3 |
| `lossy-summarize` | Summarized by tier 4 |

## Archive record

`spillIfNeeded` returns:

```js
{
  spilled: true,
  path:    "/archive/<会话标识>-<seq>.txt",  // Absolute path
  sha256:  "…",                             // Digest of the original text
  size:    25089,                           // UTF-8 byte count
  preview: "…"                              // Head/tail preview, ≤5120 characters
}
```

The archive file name carries a **session identifier**: seq numbers collide across different sessions; using seq alone would overwrite each other.

## Tier 1 inverse transform record

```js
{
  runs: [
    { start: 42, count: 8, lines: ["…"] }   // start = real line number in the original text
  ],
  original: "…",                            // Original text before folding
  archivePath: "/archive/fold-xxx.txt",     // Original text archive (restorable after a restart)
  digest: "…"
}
```

`start` records the original text's real line number; on restoration, the rebuilt position is verified against it — preventing a tampered record from silently restoring wrong content.

## In-memory state

| State | Scope | Description |
|---|---|---|
| Dedup set | `WeakMap<session, {done, evicted}>` | Must be isolated per session: seq is a session-internal sequence number; a process-level Set makes everything from the second session onward hit the dedup and silently fail |
| Spill info | `Map<`${sessionId}#${seq}`, info>` | The key must carry the session identifier, otherwise it is mixed across sessions |
| Overflow retry count | `Map<agent, number>` | Counted per agent, preventing infinite retries on overflow failure |
| Compaction lock | Event stream scan | An unpaired `compaction/start` at the tail means locked |
