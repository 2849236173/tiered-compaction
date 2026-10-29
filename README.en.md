English | [![简体中文](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-blue)](README.md)


# tiered-compaction

**DSH tiered context compaction plugin** — replaces a single summarization with a four-tier progressive pipeline.

DSH's default compaction, once the context reaches the threshold, makes one LLM summarization call and replaces the whole history with it. Simple, but the costs are clear: every compaction is a full LLM call; the summary is constrained by the output token cap; the middle of long content is lost first.

This plugin splits compaction into four tiers. The first three tiers consume most of the volume at zero LLM cost; only when the threshold is actually reached does it spend one budget-reserved summarization.

## Four-tier pipeline

| Tier | What it does | Cost |
|---|---|---|
| **1 · Lossless folding** | Consecutive duplicate lines (≥3 times) are folded into "first line + `…[folded Nx]`", with an inverse transform record attached | Zero LLM |
| **2 · Spill to disk** | Tool output over 8KB (UTF-8 bytes) is archived in full; the context keeps only head/tail previews + path + SHA-256 | Zero LLM |
| **3 · Soft pressure** | Reminder inserted at 70% window; at 80%, replayable content is evicted by priority | Zero LLM |
| **4 · Lossy summarization** | LLM summarization only at the threshold, with budget reserved in advance and a full archive before summarizing | 1 LLM call |

There is also a **bypass**: goal-switch cleanup — when a new goal is explicitly declared, the old goal's todo/goal/plan are packed into a structured capsule and process content is archived, at zero LLM cost.

## Why lossy operations are safe here

Three constraints run through all tiers:

1. **Every tier keeps a recovery mechanism** — folding has an inverse transform record; spilling has SHA-256 and the full file; evicted items record their original location (a rerun of `read`/`grep`/`glob` restores them); a full archive is made before summarization.
2. **Superseded references are recorded in the lineage table** — whenever content is superseded, an entry "original location → new location → superseder" is registered, auditable and traceable, never silently deleted.
3. **The plugin itself has a circuit breaker and an arbiter** — a tier that fails consecutively is automatically degraded, skipped, and warned about without blocking the main flow; the arbiter guarantees each piece of content is handled by exactly one tier.

## Installation

The plugin is pure ESM + JSDoc with no build chain, shipped straight from `src/` — no compilation needed before install.

**Installing from npm is recommended** (clear version numbers, and `update` automatically upgrades to the latest stable version); use the GitHub route when npm network access is unavailable.

### First, confirm which profile you use

Each DSH runtime mode corresponds to one profile name; installing into a profile makes it take effect only in that mode. **Whichever way you normally start DSH, that is the name to use**:

| How you use DSH | Profile name | Copy this command |
|---|---|---|
| Desktop client (Windows/macOS app) | `desktop` | See desktop below |
| Web version opened in a browser | `web` | See Web below |
| Command line / script invocation (headless) | `headless` | See headless below |
| Terminal interactive interface (TUI) | `tui` | See TUI below |

Not sure which profiles you have: look at the folder names under `~/.dsh/profiles/` (on Windows, `C:\Users\<you>\.dsh\profiles\`).

> To install into several modes at once, run each of the commands below once per mode, replacing `--profile` with the corresponding name.

### Desktop (most common)

```powershell
# Install from npm (recommended): no tag specified means the latest stable version
dsh plugin --profile desktop add dsh-tiered-compaction

# Or install from GitHub
dsh plugin --profile desktop add "github:2849236173/tiered-compaction"
```

### Web

```powershell
dsh plugin --profile web add dsh-tiered-compaction

# Or install from GitHub
dsh plugin --profile web add "github:2849236173/tiered-compaction"
```

### headless (command line / scripts)

```powershell
dsh plugin --profile headless add dsh-tiered-compaction

# Or install from GitHub
dsh plugin --profile headless add "github:2849236173/tiered-compaction"
```

### TUI (terminal interface)

```powershell
dsh plugin --profile tui add dsh-tiered-compaction

# Or install from GitHub
dsh plugin --profile tui add "github:2849236173/tiered-compaction"
```

### Local development (code changes take effect immediately)

To modify the plugin source locally and have changes take effect after a restart, install via a symlink — replace the path with your repository location:

```powershell
# Desktop as an example; for other modes replace desktop with web / headless / tui
dsh plugin --profile desktop add "D:\你的路径\tiered-compaction"
```

**Just restart DSH — no configuration changes needed.**

The plugin's bundled patch does two things at mount time: disable the official `dsh-compaction-basic` (yielding the `compaction` service slot), and insert and enable this plugin. The archive directory defaults to `~/.dsh/tiered-archive` and is created automatically if it does not exist.

Signs of a successful install — these two lines appear in the startup log:

```
dsh-tiered-compaction 已接管 compaction 服务位（enabled=true，archiveDir=...）
dsh-tiered-compaction 观察者已注册（工具结果 → 第 1-2 层）
```

### Updating to a new version

After the first install, **running `add` again does not update** — `add` is not an upgrade command. pnpm writes the git dependency's commit hash into `pnpm-lock.yaml`; as long as that record exists, it considers the requirement "satisfied" and skips directly:

```
Already up to date
```

The correct upgrade command is `update`:

```powershell
# Desktop
dsh plugin --profile desktop update dsh-tiered-compaction

# Web
dsh plugin --profile web update dsh-tiered-compaction

# headless / TUI work the same way, only replace --profile
```

**Installed from npm**: `update` only upgrades to `latest` (stable version) and will not accidentally take a beta.
**Installed from GitHub**: `update` upgrades to the latest commit on main.

**After upgrading you must fully exit and restart DSH**, otherwise the old code still in memory keeps running.

If the version did not change after `update` (common when the repository was renamed or the install source was switched), force a re-resolution with "uninstall then install":

```powershell
dsh plugin --profile desktop remove dsh-tiered-compaction
dsh plugin --profile desktop add dsh-tiered-compaction
```

How to confirm the upgrade succeeded: check the version actually loaded.

```powershell
# Desktop; for other modes replace desktop with web / headless / tui
$base = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules"
foreach ($name in @("dsh-tiered-compaction", "@local\dsh-tiered-compaction")) {
    $f = Join-Path $base "$name\package.json"
    if (Test-Path $f) { "$name → $((Get-Content $f -Raw | ConvertFrom-Json).version)" }
}
```

Output like `dsh-tiered-compaction → 0.3.1` means that is the currently active version.

> **Note**: DSH does not proactively notify you of new versions. To find out whether an update exists, if you installed from npm you can run `npm view dsh-tiered-compaction version` and compare; you can also check the repository's [CHANGELOG](CHANGELOG.md).

### Uninstall

```powershell
dsh plugin --profile desktop remove dsh-tiered-compaction
```

After uninstalling, the official `dsh-compaction-basic` **is restored automatically** — the patch that disabled it belongs to this plugin package and is removed along with it. A restart returns you to the official compaction; no manual config rollback needed.

(If you only want to switch back to the official compaction temporarily while keeping the plugin: swap the two switches in the patch — though in that case uninstalling is simpler.)

## Configuration (all optional)

Works immediately after install; the fields below only need to be filled in when customization is required:

```yaml
- id: tiered-compaction
  config:
    enabled: true                        # Default true
    archiveDir: ~/.dsh/tiered-archive    # Default value, editable
    auto: true                           # Whether to trigger automatically
    summaryTarget:                       # Model used for summarization; if empty, follows the current session
      provider: deepseek-official
      model: deepseek-chat
    modelPolicies: {}                    # Per-model overrides of thresholds and retry counts
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Whether to take over the compaction service slot |
| `archiveDir` | `~/.dsh/tiered-archive` | Directory for spill and summary archives, created automatically |
| `auto` | `true` | Whether to trigger automatically (pressure / overflow) |
| `summaryTarget` | Session routing | provider/model used for summarization |
| `modelPolicies` | `{}` | Per-model overrides of thresholds, retry counts, etc. |

## Runtime status

No need to watch it day to day. To check whether it is working normally, search the host log for `tiered-compaction`:

```
tiered-compaction 健康 window=1000000 pressure=12.7% l12=107/31repl/0fail l3=0evict spill=29 status=ok
```

`status=ok` means normal; `status=warn` means the self-check found an anomaly (window reading is 0, the first two tiers have failures with zero successes, pressure ≥80% with zero action, or `summaryTarget` configured only halfway).

At around 82% pressure a summary compaction is triggered, and a `compaction/summary` record appears in the log.

## Development

```bash
node --test test/*.test.js              # Full test suite
node scripts/verify-e2e.mjs <会话文件>    # End-to-end pipeline (requires a real session; verifies KV prefix equivalence)
```

The end-to-end script verifies "whether the summary request is a strict prefix of a normal conversation request" — if identical, it is guaranteed to hit the provider's KV cache. Session files are at `~/.dsh/sessions/<workspace>/<sessionID>/session.v4.jsonl.zstd`.

## Known limitations

- **Host version binding**: the contract layer aligns with DSH 0.2.x's `CompactionEngine` interface; after a host major version upgrade, the method surface must be re-verified.
- **Handles plain-text tool results only**: rich blocks containing images or attachments are always skipped, to avoid breaking structure.
- **Pressure reading depends on the `request/context` event**: some providers do not emit this event; when missing, pressure determination falls back to a conservative path.
- **The spill preview has a fixed budget**: the preview is 5120 characters (head/tail 4:1). Very large output necessarily loses information — the original is fully preserved in the archive, with its path and SHA-256 given alongside the context, so it can be read back at any time.

## Documentation

| Document | Content |
|---|---|
| [docs/架构与设计理念.md](architecture.md) | Architecture overview, design trade-offs, degradation design, known boundaries |
| [架构图](docs/架构图.html) | Interactive diagram of the four-tier pipeline (open in a browser) |
| [docs/第1层-无损折叠.md](docs/第1层-无损折叠.md) | Folding algorithm, inverse transform, reversibility guarantee |
| [docs/第2层-落盘.md](docs/第2层-落盘.md) | Archiving, preview budget, SHA-256 verification |
| [docs/第3层-软压力.md](docs/第3层-软压力.md) | Priority rules for reminders and eviction |
| [docs/第4层-有损摘要.md](docs/第4层-有损摘要.md) | Summary input structure, KV cache reuse, budget reservation |
| [docs/数据结构.md](data-structures.md) | Events, lineage table, archive records |

## License

MIT, see [LICENSE](LICENSE).
