English | [简体中文](CHANGELOG.md)

# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versioning follows [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-10-28

**Self-audit fixes**: while doing a source-level comparison against 22 similar plugins, three "looks like it's running but actually does nothing" silent failures of this plugin itself were uncovered, plus one piece of dead code that only tests were calling.

### Fixed

- **`restoreSpilled()` was dead code → wired up as the `tiered_restore` tool.**
  Before this, there were zero call sites across the codebase; only tests called it. That means the claim "original text is 100% spilled to disk and readable back" actually relied on the model reading the file directly with the generic `read` tool, and the SHA-256 verification never ran. Now the model can read back the original text by archive path + digest, and any failed verification throws an error instead of returning content (reading corrupted content is more dangerous than reading nothing).

- **Silent threshold clamping → clamping is now logged.** Plugins such as `dsh-session-manager` write `engine.config.thresholdRatio` directly (slider range 17%–90%), while this plugin clamps the value to `[0.82, 0.95]`, which turned 65% of the slider travel into a dead zone with zero feedback. Now clamping emits a deduplicated warning stating the original value, the effective value, and why this range exists.

- **Silent summary redirection → redirection is now logged.** Summary requests carry `purpose: "compaction"`, and `dsh-auxiliary` / `dsh-compact-selected-model` re-route the request to a different model based on it. The redirection itself is not a bug, but now the actual target provider/model is recorded — otherwise "why did the summary quality change this time" is impossible to troubleshoot.

### Added

- **Preset coexistence detection.** Under the preset architecture (web / desktop), each session's agent runs in the preset's own `isolate` realm, and the realm has its own independent `compaction` service. The plugin's built-in cordis patch **can only disable the root-plane** `compaction-basic` — because the host `buildMap` only recurses into `group && Array.isArray(config)`, while the preset's plugin list sits in the object field `agentPreset.config.plugins`. Now, at load time, presets are enumerated and any preset that ships its own `compaction` group triggers a warning stating clearly that "if your sessions use these presets, actual compaction is performed by the engine inside the preset". This detection does not attempt automatic repair (rewriting another preset's config is high-risk); it only makes the silent behavior visible.

## [0.3.0] - 2026-10-28

**Works immediately after install**: no longer requires manually editing configuration after installation.

### Changed

- **Takes over compaction by default**: the default value of `enabled` changed from `false` to `true`. The plugin is enabled as soon as it is installed; you only need to explicitly disable it when coexisting with the official basic engine.
- **The patch auto-disables basic**: the plugin's built-in `cordis.patch.yml` now does two things at once — disables `dsh-compaction-basic` (yielding the `compaction` service slot) and enables itself. Previously it only inserted a disabled copy of itself, and the user had to edit two places by hand to use it.
- **Default archive directory**: `archiveDir` now defaults to `~/.dsh/tiered-archive` and is created automatically. Previously, without configuration, tiers 1 and 2 were silently skipped entirely.

### Fixed

- **Critical: written session files were corrupted, and the next load reported `compaction turn must be a non-negative safe integer`.**
  The `data` of `compaction/start` and `compaction/end` was missing the `turn` field. The host v4 session format requires this field to be a non-negative safe integer equal to the currently open turn (`Relationships.compact` in `dsh-session-format-v3-to-v4`). When missing, writing raised no error — **only reading judged the session corrupted**, so the entire history of the group/session failed to load.
  Fix: added `openTurnOf(session)` — scans backward from the tail of the event stream for the most recent `turn/start` and takes its `turn` value, writing it into the `data` of both compaction events. Old sessions already hit by this issue need a repair script to backfill the field (see the notes in `docs/`).
- The spill-to-disk preview budget is now aligned with the official pruner: the cap was raised from 1500 to 5120 characters, and the head-to-tail ratio changed from 1:2 to 4:1 (matching `headChars 4096` / `tailChars 1024`). The previous 1500 offered 3.4× less visible context than the official one.
- Summaries consisting of whitespace only are rejected and not committed (`summary.trim()` check; previously `"   "` was accepted and overwrote the original text).
- Selections containing system header nodes are no longer double-projected (duplication breaks prefix order and invalidates the KV cache).
- Summary token estimation now skips only the first system header of the message list; system nodes inside the selection count toward the denominator (previously skipping all of them caused valid summaries to be wrongly rejected).

### Documentation

- README rewritten from the user's perspective: purpose → four tiers → install → configuration → status.
- Added an architecture diagram (interactive) plus per-tier documents and a data-structure document.

## [0.2.0] - 2026-10-28

First public release.

### Added

- **Four-tier progressive compaction pipeline**: lossless folding → spill to disk → soft pressure → lossy summarization. The first three tiers cost zero LLM tokens; only when the threshold is truly reached does it spend one summarization call with a reserved budget.
- **Three fidelity principles**: every tier keeps a recovery mechanism, superseded references record their lineage, and the compaction system ships its own circuit breaker and arbiter.
- **Host contract layer**: `TieredCompactionEngineService extends CompactionEngine`, implementing the three entry points `compactNow` / `compactIfNeeded` / `compactRegion` plus the `summarize` override, with return shapes aligned field-by-field with the official basic engine.
- **Tool result observer**: hooks tiers 1–3 into the real host via the `session/event` hook, implemented following the official pruner's two-step paradigm of "shadow pricing → surfaceOp replace".
- **Target-switch bypass**: when a new target is explicitly declared, it packs a todo/goal/plan capsule and archives in-progress content — zero LLM usage throughout.
- **Slot probing and fallback**: construction-catch probes the `compaction` service slot; when occupied, it automatically falls back to a "tiers 1–2 only" bypass mode.
- **Lineage table**: any supersession relationship can be looked up as the triple "original location → new location → superseder".
- **Circuit breaker + arbiter**: consecutive failures in a single tier automatically degrade and skip that tier, and the main flow is never blocked; each piece of content is handled by exactly one tier.

### Fixed

- The spill-to-disk threshold is now judged by UTF-8 byte count (previously by JS character count, which missed spilling in Chinese-heavy scenarios).
- Pressure readings now take the window from `request/context` events (the real `TokenMeter` has no `contextWindow()` method).
- Summarization now goes through `ctx.llm.stream()` (the real llm service has no `summarize` method).
- The deduplication set is now isolated per session (the old implementation was a process-level Set, so compaction silently stopped working after the first session).
- The observer's deduplication marker is now placed before the `await`, eliminating a race that caused concurrent duplicate replacements.
- Replacement events written back by itself are now excluded, preventing infinite recursion from causing an OOM.

### Known Limitations

- The contract layer aligns with the `CompactionEngine` interface of DSH 0.2.x; after a host major-version upgrade, the method surface must be re-verified.
- Only plain-text tool results are processed; rich blocks containing images/attachments are always skipped.
- Pressure readings depend on `request/context` events; when missing, a conservative path is used as a fallback.

[0.3.0]: https://github.com/2849236173/tiered-compaction/releases/tag/v0.3.0
[0.2.0]: https://github.com/2849236173/tiered-compaction/releases/tag/v0.2.0
