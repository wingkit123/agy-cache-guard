import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  ttlWarnSec: 55,
  ttlMinContextTokens: 30_000,
  contextWarnTokens: 120_000,
  contextDangerTokens: 150_000,
  contextRepeatStepTokens: 30_000,
  contextWarnPct: 60,
  contextDangerPct: 75,
  cacheHitLowPct: 30,
  cacheDropMinTokens: 30_000,
  cacheDropCooldownTurns: 2,
  maxSnapshotAgeMs: 5 * 60_000,
  stateRetentionMs: 7 * 24 * 60 * 60_000,
};

function readJsonSafe(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, filePath);
  } catch {
    // Fail open: state persistence failure must never block the agent loop.
  }
}

function resolvePluginDataDir() {
  const envData = String(process.env.PLUGIN_DATA || '').trim();
  if (envData && !envData.includes('${')) {
    return envData;
  }
  const geminiBase = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homedir(), '.gemini');
  return join(geminiBase, 'antigravity', 'plugin_data', 'cache-guard');
}

function resolveSnapshotCandidates(transcriptPath) {
  const candidates = [];
  const explicit = String(process.env.USAGE_MONITOR_SNAPSHOT_PATH || '').trim();
  if (explicit) candidates.push(explicit);

  // Infer product root (antigravity / antigravity-cli / antigravity-ide) from transcriptPath when available.
  if (transcriptPath) {
    const match = String(transcriptPath).match(/^(.*[/\\]\.gemini[/\\][^/\\]+)/i);
    if (match) {
      candidates.push(join(match[1], 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json'));
    }
  }

  const geminiBase = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homedir(), '.gemini');
  for (const dir of ['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-idea']) {
    const p = join(geminiBase, dir, 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json');
    if (!candidates.includes(p)) candidates.push(p);
  }
  return candidates;
}

function loadActiveConversationMetrics(conversationId, transcriptPath, maxAgeMs, nowMs) {
  if (!conversationId) return null;
  for (const candidate of resolveSnapshotCandidates(transcriptPath)) {
    const snap = readJsonSafe(candidate);
    if (!snap || typeof snap !== 'object') continue;
    const updatedAtMs = Number(snap.updatedAtMs || 0);
    if (updatedAtMs > 0 && nowMs - updatedAtMs > maxAgeMs) continue;
    const active = snap.activeConversation;
    if (active && active.cascadeId === conversationId) {
      return {
        promptTokens: Number(active.latestPromptTokens ?? 0),
        usedPct: Number(active.usedPct ?? 0),
        cacheHitPct: active.latestCacheHitPct != null ? Number(active.latestCacheHitPct) : null,
        ttftSec: active.latestTtftSec != null ? Number(active.latestTtftSec) : null,
        sessionCostUsd: active.sessionCostUsd != null ? Number(active.sessionCostUsd) : null,
      };
    }
  }
  return null;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatDuration(sec) {
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)}h`;
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${Math.round(sec)}s`;
}

function pruneOldConversations(state, nowMs, retentionMs) {
  const convs = state.conversations || {};
  for (const [id, entry] of Object.entries(convs)) {
    const last = Number(entry?.lastSeenAtMs || 0);
    if (last > 0 && nowMs - last > retentionMs) {
      delete convs[id];
    }
  }
}

export function evaluatePreInvocation({
  payload,
  state,
  metrics,
  config,
  nowMs,
}) {
  const conversationId = String(payload?.conversationId || '').trim();
  if (!conversationId) return { output: {}, stateChanged: false };

  const invocationNum = Number(payload?.invocationNum ?? 1);
  const conv = state.conversations[conversationId] || {
    turnCount: 0,
    lastSeenAtMs: nowMs,
    lastTurnEndAtMs: 0,
    lastActiveAtMs: 0,
    lastContextWarnTier: 0,
    lastCacheDropTurn: -999,
  };

  if (invocationNum === 1) {
    conv.turnCount = Number(conv.turnCount || 0) + 1;
  }
  conv.lastSeenAtMs = nowMs;

  const alerts = [];
  const promptTokens = metrics ? Number(metrics.promptTokens || 0) : 0;
  const usedPct = metrics ? Number(metrics.usedPct || 0) : 0;
  const cacheHitPct = metrics?.cacheHitPct;

  // 1. Prompt Cache TTL idle gap check (only at the start of a new user turn)
  if (invocationNum === 1 && conv.lastTurnEndAtMs > 0) {
    const idleSec = (nowMs - conv.lastTurnEndAtMs) / 1000;
    conv.lastTurnEndAtMs = 0;
    if (promptTokens >= config.ttlMinContextTokens && idleSec >= config.ttlWarnSec) {
      alerts.push(
        `⏳ **Cache TTL 提示**：距离上轮结束已间隔 **${formatDuration(idleSec)}**（当前上下文 \`${formatTokens(promptTokens)}\`），Prompt Cache 可能已过期，本轮首字延迟或重算开销可能升高。`
      );
    }
  }

  // 2. Context bloat threshold check (tiered + anti-spam across turns)
  if (metrics && (promptTokens >= config.contextWarnTokens || usedPct >= config.contextWarnPct)) {
    let tier = 0;
    if (promptTokens >= config.contextDangerTokens || usedPct >= config.contextDangerPct) {
      const stepsAbove = Math.max(0, Math.floor((promptTokens - config.contextDangerTokens) / config.contextRepeatStepTokens));
      tier = 2 + stepsAbove;
    } else {
      tier = 1;
    }

    const shouldNotifyContext =
      tier > Number(conv.lastContextWarnTier || 0) &&
      (invocationNum === 1 || tier >= 2);

    if (shouldNotifyContext) {
      conv.lastContextWarnTier = tier;
      const pctText = usedPct > 0 ? ` / ${usedPct.toFixed(1)}%` : '';
      if (tier >= 2) {
        alerts.push(
          `🔴 **高上下文预警（\`${formatTokens(promptTokens)}\`${pctText}）**：已超过 \`${formatTokens(config.contextDangerTokens)}\` 警戒线，缓存失效成本极高。建议本轮收尾后整理 \`HANDOFF.md\` 并使用 \`/compact\` 或新开会话。`
        );
      } else {
        alerts.push(
          `🟡 **上下文水位提示（\`${formatTokens(promptTokens)}\`${pctText}）**：已达 \`${formatTokens(config.contextWarnTokens)}\`，可考虑在当前里程碑结束后执行 \`/compact\` 或切换新会话。`
        );
      }
    }
  }

  // 3. Sudden cache-hit drop check
  if (
    invocationNum === 1 &&
    metrics &&
    cacheHitPct !== null &&
    Number.isFinite(cacheHitPct) &&
    promptTokens >= config.cacheDropMinTokens &&
    cacheHitPct < config.cacheHitLowPct &&
    conv.turnCount - Number(conv.lastCacheDropTurn ?? -999) >= config.cacheDropCooldownTurns
  ) {
    conv.lastCacheDropTurn = conv.turnCount;
    alerts.push(
      `⚠️ **缓存命中率偏低（${cacheHitPct}%）**：上下文 \`${formatTokens(promptTokens)}\` 下命中率跌破 \`${config.cacheHitLowPct}%\`（常见于停顿过久、切换模式或主会话读入图片）。`
    );
  }

  conv.lastActiveAtMs = nowMs;
  state.conversations[conversationId] = conv;

  if (alerts.length === 0) {
    return { output: {}, stateChanged: true };
  }

  const extras = [];
  if (metrics?.ttftSec != null && Number.isFinite(metrics.ttftSec) && metrics.ttftSec >= 18) {
    extras.push(`上步 TTFT ${metrics.ttftSec.toFixed(1)}s`);
  }
  if (metrics?.sessionCostUsd != null && Number.isFinite(metrics.sessionCostUsd) && metrics.sessionCostUsd > 0) {
    extras.push(`会话累计 $${metrics.sessionCostUsd.toFixed(2)}`);
  }
  const footer = extras.length > 0 ? `\n\n<sub>${extras.join(' · ')}</sub>` : '';

  return {
    output: {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: '',
            metadata: {
              user_markdown: alerts.join('\n\n') + footer,
            },
          },
        },
      ],
    },
    stateChanged: true,
  };
}

function main() {
  let rawInput = '';
  try {
    rawInput = readFileSync(0, 'utf8');
  } catch {
    rawInput = '';
  }

  const payload = rawInput.trim() ? JSON.parse(rawInput) : {};
  const eventName = String(payload?.hookEventName || process.argv[2] || '').trim();
  const conversationId = String(payload?.conversationId || '').trim();
  const nowMs = Date.now();

  const dataDir = resolvePluginDataDir();
  const userConfig = readJsonSafe(join(dataDir, 'config.json'));
  const config = { ...DEFAULTS, ...(userConfig && typeof userConfig === 'object' ? userConfig : {}) };

  const statePath = join(dataDir, 'state.json');
  const state = readJsonSafe(statePath) || { conversations: {} };
  if (!state.conversations || typeof state.conversations !== 'object') {
    state.conversations = {};
  }
  pruneOldConversations(state, nowMs, config.stateRetentionMs);

  if (eventName === 'SessionStart') {
    if (conversationId) {
      state.conversations[conversationId] = {
        turnCount: 0,
        lastSeenAtMs: nowMs,
        lastTurnEndAtMs: 0,
        lastActiveAtMs: nowMs,
        lastContextWarnTier: 0,
        lastCacheDropTurn: -999,
      };
      writeJsonAtomic(statePath, state);
    }
    process.stdout.write('{}');
    return;
  }

  if (eventName === 'PostInvocation' || eventName === 'Stop') {
    if (conversationId) {
      const conv = state.conversations[conversationId] || {
        turnCount: 0,
        lastSeenAtMs: nowMs,
        lastTurnEndAtMs: 0,
        lastActiveAtMs: nowMs,
        lastContextWarnTier: 0,
        lastCacheDropTurn: -999,
      };
      conv.lastSeenAtMs = nowMs;
      conv.lastActiveAtMs = nowMs;
      conv.lastTurnEndAtMs = nowMs;
      state.conversations[conversationId] = conv;
      writeJsonAtomic(statePath, state);
    }
    process.stdout.write('{}');
    return;
  }

  if (eventName === 'PreInvocation') {
    const metrics = loadActiveConversationMetrics(
      conversationId,
      payload?.transcriptPath,
      config.maxSnapshotAgeMs,
      nowMs
    );
    const { output, stateChanged } = evaluatePreInvocation({
      payload,
      state,
      metrics,
      config,
      nowMs,
    });
    if (stateChanged) {
      writeJsonAtomic(statePath, state);
    }
    process.stdout.write(JSON.stringify(output));
    return;
  }

  process.stdout.write('{}');
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isEntrypoint) {
  try {
    main();
  } catch {
    process.stdout.write('{}');
  }
}
