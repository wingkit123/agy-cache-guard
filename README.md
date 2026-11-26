# cache-guard

[简体中文](README.zh-CN.md) · English

A zero-intrusion lifecycle hook plugin for **Google Antigravity** (`agy` CLI / Desktop / IDE). It reads persisted telemetry snapshots from [antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) in read-only mode to surface inline warnings when Prompt Cache TTL expires, context grows past compaction thresholds, or cache hit rate drops sharply—without touching `usage-monitor` files or injecting extra tokens into the model context.

## Features

- **Zero modification to `usage-monitor`**: Only reads `cli-status-snapshot.json` under Antigravity's persisted `sidecar_data/usage-monitor/panel/data/` directory, so `usage-monitor` updates never overwrite your setup.
- **Zero model token overhead**: Uses Antigravity `PreInvocation` `injectSteps` with `systemMessage: ""` and `metadata.user_markdown`, rendering alerts inline for the user only.
- **Fail-open safety**: Any missing file, parse failure, or I/O error outputs `{}` immediately with exit code `0`.
- **Three built-in guards (with turn-level deduplication)**:
  1. **Cache TTL Idle Alert**: Warns at the start of a new user turn when idle time since the last turn end is `>= 55s` and context is `>= 30k` tokens.
  2. **Context Threshold Alert**: Tiered warning at `120k` tokens (or `60%` window) and strong warning at `150k` tokens (or `75%` window), repeating only every `+30k` growth thereafter.
  3. **Cache Hit Drop Alert**: Warns when context is `>= 30k` tokens and the latest step cache hit rate drops below `30%` (2-turn cooldown).

## Requirements

- **Node.js >= 20**
- **Google Antigravity** with [antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) installed and running

## Installation

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/wingkit123/agy-cache-guard/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/wingkit123/agy-cache-guard/main/install.sh | sh
```

### Manual Clone

```bash
# macOS / Linux
git clone https://github.com/wingkit123/agy-cache-guard.git ~/.gemini/config/plugins/cache-guard
```

```powershell
# Windows (PowerShell)
git clone https://github.com/wingkit123/agy-cache-guard.git "$env:USERPROFILE\.gemini\config\plugins\cache-guard"
```

Open a **new session** in Antigravity (or check **Customizations -> Installed -> `cache-guard`**) to activate all hooks.

## Configuration (Optional)

Default thresholds work out of the box. To override any threshold, create `config.json` inside the plugin's `PLUGIN_DATA` directory (by default `~/.gemini/antigravity/plugin_data/cache-guard/config.json`):

```json
{
  "ttlWarnSec": 55,
  "ttlMinContextTokens": 30000,
  "contextWarnTokens": 120000,
  "contextDangerTokens": 150000,
  "contextRepeatStepTokens": 30000,
  "contextWarnPct": 60,
  "contextDangerPct": 75,
  "cacheHitLowPct": 30,
  "cacheDropMinTokens": 30000,
  "cacheDropCooldownTurns": 2
}
```

## Verification

Run the included test suite (requires Node.js >= 20):

```bash
node tests/guard.test.mjs
```

## License

[MIT](LICENSE)
