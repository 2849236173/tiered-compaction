[简体中文](README.md) | **English**

# tiered-compaction

A tiered context compaction plugin for DSH. The first three tiers make no LLM calls; a summary runs only when pressure actually reaches the threshold.

![HUD preview](https://raw.githubusercontent.com/2849236173/tiered-compaction/main/docs/images/hud.png)

Current stable release: **0.4.1**

## What it does

| Tier | How | Cost |
|---|---|---|
| 1 · Fold | Lines repeated 3 or more times in a row collapse into one | No LLM |
| 2 · Spill | Tool output over 8 KB goes to disk; the context keeps a preview and the path | No LLM |
| 3 · Evict | At 70% pressure, a reminder; at 80%, old re-runnable tool results are removed | No LLM |
| 4 · Summarize | At the threshold (about 82%), the LLM summarizes older history | 1 LLM call |

Nothing is lost for good: spilled output and pre-summary history are archived in `~/.dsh/tiered-archive` and can be read back with the `tiered_restore` tool. Evicted tool results come back by re-running the original command.

## Install

The plugin ships in two tiers. Pick one:

| Tier | Meaning | npm tag |
|---|---|---|
| Stable | Fully tested; recommended for most people | `latest` |
| Beta | New fixes or features, **not fully tested** | `beta` |

**Install stable:**

```powershell
dsh plugin --profile desktop add dsh-tiered-compaction@latest
```

**Install beta:**

```powershell
dsh plugin --profile desktop add dsh-tiered-compaction@beta
```

The command may end with `ERR_PNPM_IGNORED_BUILDS`. pnpm skipped an install script that only prints a message; the plugin is installed and you can ignore it.

Fully quit and reopen DSH. No configuration needed. For the web app, CLI, or TUI, replace `desktop` with `web`, `headless`, or `tui`.

Beta is not always newer than stable. After a stable release, the beta tag may still point to an older version. Check both tags first:

```powershell
npm view dsh-tiered-compaction dist-tags
```

## Enable all four tiers

Each DSH session binds to a preset when it is created and keeps it. With the plugin alone, every session gets tiers 1 and 2, while tiers 3 and 4 stay with the official compaction. To get all four, switch the preset to this plugin's version:

| Preset | How |
|---|---|
| `cordis` (desktop default) | Install the `tiered-cordis-preset` bundle |
| `ptc-tc` | `tools/gen-ptc-tc.ps1 -Apply` |
| `standard` (used by Bots and group chats) | `tools/gen-standard-tc.ps1 -Apply` |
| Official `ptc`, `minimal` | `tools/gen-standard-tc.ps1 -Preset ptc -Apply`, same for `minimal` |

Only **new sessions** pick up the change; existing sessions keep their preset. Re-run the generators after upgrading DSH.

## HUD

- The large percentage is how much of the window the context uses. Top right shows the actual token count and how far the next summary is.
- The three cards count fold/spill, eviction, and summary runs, with the tokens each saved.
- While a summary runs, the HUD shows "Summarizing… Ns".
- When the session is idle, compaction waits for your next message, and the HUD says so.

The settings page shows the same information plus per-tier statistics.

## Update, switch, uninstall

Updating and switching tiers both use `add` with a tag. Just run it again:

| Goal | Command |
|---|---|
| Stable → newest stable | `dsh plugin --profile desktop add dsh-tiered-compaction@latest` |
| Beta → newest beta | `dsh plugin --profile desktop add dsh-tiered-compaction@beta` |
| Stable → beta | `dsh plugin --profile desktop add dsh-tiered-compaction@beta` |
| Beta → stable | `dsh plugin --profile desktop add dsh-tiered-compaction@latest` |
| Uninstall (official compaction comes back) | `dsh plugin --profile desktop remove dsh-tiered-compaction` |

Don't use `update`: the install records an exact version, and `update` neither moves past it nor switches tiers.

Fully quit and reopen DSH afterwards. To see which version is installed:

```powershell
dsh plugin --profile desktop list dsh-tiered-compaction
```

## Configuration

All optional.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Take over compaction |
| `auto` | `true` | Compact automatically; with `false`, only manual `/compact` |
| `archiveDir` | `~/.dsh/tiered-archive` | Archive directory |
| `summaryTarget` | Session's model | `provider` and `model` used for summaries |
| `modelPolicies` | none | Per-model threshold and retry overrides |
| `scopeId` | unset | Used when mounted inside a preset; the generators fill it in |

## Check that it works

Search the host log for `tiered-compaction 健康`:

```
tiered-compaction 健康 window=262144 pressure=57.3% ... status=ok
```

`status=ok` means healthy. `status=warn` is followed by what went wrong.

## Known limits

- Tool results containing images or attachments are left alone.
- Spill previews are fixed at 5120 characters; the full text is in the archive.
- Built against the DSH 0.2.x compaction interface; recheck after a major DSH upgrade.

## More

- [Architecture](docs/architecture.md)
- Tier details: [1](docs/tier1-lossless-folding.md), [2](docs/tier2-spill-to-disk.md), [3](docs/tier3-soft-pressure.md), [4](docs/tier4-lossy-summarization.md)
- [Changelog](CHANGELOG.en.md)

## License

MIT
