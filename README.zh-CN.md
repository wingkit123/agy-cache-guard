# cache-guard

简体中文 · [English](README.md)

面向 **Google Antigravity**（`agy` CLI / Desktop / IDE）的零侵入生命周期 Hook 外挂插件。它以**纯只读**方式复用 [antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor) 落盘的实时遥测快照，在 **Prompt Cache TTL 空闲过期、上下文膨胀到拐点、缓存命中率骤降** 时直接在聊天界面给出内联提醒——**不修改 `usage-monitor` 任何源码（不惧插件更新），也不向模型上下文注入额外 Token**。

## 核心特性

- **对 `usage-monitor` 零侵入**：仅只读读取 `sidecar_data/usage-monitor/panel/data/cli-status-snapshot.json`，`usage-monitor` 自动更新不会覆盖任何配置或代码。
- **对模型零 Token 消耗**：通过 Antigravity `PreInvocation` 的 `injectSteps`（`systemMessage: ""` + `metadata.user_markdown`）仅向用户内联展示提醒，模型不可见。
- **Fail-open 安全兜底**：任何文件缺失、JSON 损坏或 I/O 异常都会立即返回 `{}`（退出码 `0`），绝不阻塞正常对话。
- **三项内置提醒与防刷屏控制**：
  1. **Cache TTL 空闲提示**：当上下文 `>= 30k` 且距离上一轮结束间隔 `>= 55 秒` 时，在下一轮用户新消息开始时提示缓存可能已冷。
  2. **上下文拐点预警**：在 `120k`（或 `60%` 窗口）给出轻提醒，在 `150k`（或 `75%` 窗口）给出强提醒并建议整理 `HANDOFF.md` 后 `/compact` 或新开会话，之后每增长 `30k` 才递增提醒一次。
  3. **缓存命中率骤降提示**：当上下文 `>= 30k` 且最近一步缓存命中率低于 `30%` 时提醒排查（带 2 轮冷却，避免连续刷屏）。

## 环境要求

- **Node.js >= 20**
- **Google Antigravity**（需已安装并启用 [antigravity-usage-monitor](https://github.com/yuhuan-dev/antigravity-usage-monitor)）

## 安装方式

### Windows（PowerShell）

```powershell
irm https://raw.githubusercontent.com/wingkit123/agy-cache-guard/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/wingkit123/agy-cache-guard/main/install.sh | sh
```

### 手动克隆安装

```bash
# macOS / Linux
git clone https://github.com/wingkit123/agy-cache-guard.git ~/.gemini/config/plugins/cache-guard
```

```powershell
# Windows (PowerShell)
git clone https://github.com/wingkit123/agy-cache-guard.git "$env:USERPROFILE\.gemini\config\plugins\cache-guard"
```

安装完成后，在 Antigravity 中开启一个**新会话**即可激活全部 Hook（也可在 **Customizations -> 已安装 -> `cache-guard`** 中查看或开关）。

## 自定义阈值（可选）

插件开箱即用。如需微调触发阈值，可在 `PLUGIN_DATA` 目录（默认 `~/.gemini/antigravity/plugin_data/cache-guard/config.json`）新建 `config.json` 覆盖对应字段：

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

## 自检测试

```bash
node tests/guard.test.mjs
```

## 开源协议

[MIT](LICENSE)
