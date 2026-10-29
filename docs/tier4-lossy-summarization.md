English | [![简体中文](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue)](第4层-有损摘要.md)


# Tier 4 · Lossy Summarization

**Goal**: when the first three tiers cannot compress further, use a single LLM call to compress a stretch of history into a checkpoint usable for continuation. The only LLM-consuming tier.

## Trigger Threshold

```
Threshold = window − max(16k, window×5%) − summarization reserve (20k)
```

With a floor guard: not lower than **82%** of the window.

**Why a floor**: on small windows the formula computes a very low threshold (e.g. a 128k window computes 60%), causing compaction far too often; the floor guarantees compaction only starts at 82% at the earliest.

**Why reserve 20k**: summarization is a single LLM call and needs an output budget. With an insufficient budget it hits the output cap and the produced summary gets truncated — which then triggers another summarization to compress smaller, forming a dead loop. The budget is reserved in advance, eliminating this dead loop at the root.

## Summary Input Must Be a Replay of the Session Prefix

This is the most critical design of this layer.

**Wrong approach**: concatenate the selection's content into a plain text and send it to the model as one user message.

Consequence: role, content block structure, and tool definitions are all lost. To the provider this is **brand-new text**; the KV cache never hits once — every summarization recomputes the entire prefix (measured at 2.18 million characters in a real session).

**Correct approach** (aligned with the official DSH `dsh-compaction-basic`):

```js
// 1. Take out the system head separately, place it at the very front of the message list
// 2. Restore each event in the selection into a structured message via the host projection (keeping role and content blocks)
// 3. Carry the tools definition from the request header
// Returns { messages, tools? }
```

Then, at request time, append one compaction instruction:

```
messages = [...session prefix, { role: "user", content: compaction instruction }]
options  = { provider, model, messages, tools, toolHistory, sessionId, maxTokens, purpose }
```

**The criterion for doing it this way**: the summarization request's messages must be a **strict prefix** of the normal conversation request's messages.

If identical, that prefix's KV was already established during the normal conversation and the summarization call reuses it directly; if the order, count, or content differs anywhere, it never hits once.

Measured (a real session with 4591 events and 1409 surface nodes): the summarization request's 1184 messages were byte-exact identical to the normal request, zero differences.

## Checkpoint Wrapping

When the summary body is written into the session, it is wrapped in three parts:

```
[fixed preamble + <compacted-summary>]
[summary body]
[</compacted-summary>]
```

The opening and closing tags are how the projection layer recognizes the checkpoint; missing either one, the checkpoint is not treated as established background during continuation.

## Summary Body Validation

The body must be **non-blank**: `summary.trim().length === 0` is refused for submission.

Judging only `length === 0` lets pure whitespace like `"   "` or `"\n\n"` through — after submission the model sees "there is a checkpoint but it says nothing", which is worse than no checkpoint: it believes the context is established while all information is actually lost.

## Guard Rails Before Submission

| Guard | Effect |
|---|---|
| Compaction lock | Refuse to enter when the event stream tail has an unpaired `compaction/start`, preventing concurrent surface modification |
| Cancellation check | Check the signal once before and once after summarization; do not submit after user cancellation |
| Selection stability | The session may change during summarization; before submission, verify the selection is still replaceable, otherwise discard the summary |
| Smaller criterion | The summary must be smaller than the content it replaces, otherwise refuse to submit (guards against "bigger after compaction") |

**On the denominator of the smaller criterion**: count only content **inside the selection**. The session system head does not count — it is not in the selection and remains in the session after compaction; counting it inflates the denominator for nothing, loosening the criterion to hold almost always.

## Failure Handling

- `finish.kind = "error" | "aborted"` → throw the real error; do not disguise it as "empty summary"
- `finish.kind = "max-tokens"` → throw `MAX_TOKENS`, because a truncated summary is incomplete
- On any failure, append a paired `compaction/end`, otherwise the compaction lock is held forever and everything after is busy

## Related Code

`src/contract.js` —— `summarize` / `frameSummaryText` / `_runTransaction`
`src/summary-input.js` —— `buildSummaryInput`

## Acceptance Criteria

| Item | Standard |
|---|---|
| Structural equivalence | Summary messages are a strict prefix of the normal request |
| KV cache fields | `tools` / `toolHistory` / `sessionId` all present |
| Three-part wrapping | First part contains OPEN_TAG, last part is CLOSE_TAG |
| Blank refusal | Pure-whitespace summaries refuse submission |
| Cancellation | Do not submit if cancelled during summarization |
| Failure surfaced | LLM failures expose the real cause, not downgraded to "empty summary" |
| Legacy host compatibility | Fall back to text mode with a warning when projection is unavailable; do not crash |
