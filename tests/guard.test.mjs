import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePreInvocation } from '../scripts/guard.mjs';

const ROOT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_CONFIG = {
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
};

function runUnitTests() {
  const state = { conversations: {} };
  const base = 1_700_000_000_000;

  // 1. Healthy initial turn -> silent
  let res = evaluatePreInvocation({
    payload: { conversationId: 'c1', invocationNum: 1 },
    state,
    metrics: { promptTokens: 40_000, usedPct: 10, cacheHitPct: 90, ttftSec: 5, sessionCostUsd: 0.2 },
    config: DEFAULT_CONFIG,
    nowMs: base,
  });
  assert.deepEqual(res.output, {});

  // 2. Idle >= 55s with >= 30k tokens -> TTL alert with zero model token pollution
  state.conversations.c1.lastTurnEndAtMs = base;
  res = evaluatePreInvocation({
    payload: { conversationId: 'c1', invocationNum: 1 },
    state,
    metrics: { promptTokens: 40_000, usedPct: 10, cacheHitPct: 90, ttftSec: 5, sessionCostUsd: 0.2 },
    config: DEFAULT_CONFIG,
    nowMs: base + 60_000,
  });
  assert.equal(res.output.injectSteps[0].systemMessage.systemMessage, '');
  assert.match(res.output.injectSteps[0].systemMessage.metadata.user_markdown, /Cache TTL/);

  // 3. Tool-loop invocationNum > 1 below 150k -> suppressed (no mid-turn spam)
  res = evaluatePreInvocation({
    payload: { conversationId: 'c1', invocationNum: 2 },
    state,
    metrics: { promptTokens: 125_000, usedPct: 50, cacheHitPct: 90, ttftSec: 5, sessionCostUsd: 0.5 },
    config: DEFAULT_CONFIG,
    nowMs: base + 120_000,
  });
  assert.deepEqual(res.output, {});

  // 4. Turn start at 125k + 20% cache hit + 22s TTFT -> combined alert
  res = evaluatePreInvocation({
    payload: { conversationId: 'c1', invocationNum: 1 },
    state,
    metrics: { promptTokens: 125_000, usedPct: 50, cacheHitPct: 20, ttftSec: 22, sessionCostUsd: 0.6 },
    config: DEFAULT_CONFIG,
    nowMs: base + 125_000,
  });
  const md = res.output.injectSteps[0].systemMessage.metadata.user_markdown;
  assert.match(md, /125\.0k/);
  assert.match(md, /20%/);
  assert.match(md, /TTFT 22\.0s/);

  // 5. Next turn at 130k + 25% cache hit -> deduplicated (context tier unchanged, cache drop on cooldown)
  res = evaluatePreInvocation({
    payload: { conversationId: 'c1', invocationNum: 1 },
    state,
    metrics: { promptTokens: 130_000, usedPct: 52, cacheHitPct: 25, ttftSec: 5, sessionCostUsd: 0.7 },
    config: DEFAULT_CONFIG,
    nowMs: base + 130_000,
  });
  assert.deepEqual(res.output, {});

  // 6. Escalation past 150k -> danger alert fires immediately
  res = evaluatePreInvocation({
    payload: { conversationId: 'c1', invocationNum: 2 },
    state,
    metrics: { promptTokens: 155_000, usedPct: 62, cacheHitPct: 90, ttftSec: 5, sessionCostUsd: 0.8 },
    config: DEFAULT_CONFIG,
    nowMs: base + 135_000,
  });
  assert.match(res.output.injectSteps[0].systemMessage.metadata.user_markdown, /155\.0k/);
}

function runCliTests() {
  const dir = mkdtempSync(join(tmpdir(), 'cache-guard-test-'));
  try {
    const snapPath = join(dir, 'cli-status-snapshot.json');
    writeFileSync(
      snapPath,
      JSON.stringify({
        updatedAtMs: Date.now(),
        activeConversation: {
          cascadeId: 'sub1',
          latestPromptTokens: 130_000,
          usedPct: 65,
          latestCacheHitPct: 22,
          latestTtftSec: 19,
          sessionCostUsd: 0.42,
        },
      })
    );

    const env = {
      ...process.env,
      PLUGIN_DATA: dir,
      USAGE_MONITOR_SNAPSHOT_PATH: snapPath,
    };

    const execHook = (eventName, inputText) =>
      spawnSync('node', [resolve(ROOT_DIR, 'scripts', 'guard.mjs'), eventName], {
        cwd: ROOT_DIR,
        env,
        input: inputText,
        encoding: 'utf8',
      });

    assert.equal(execHook('SessionStart', JSON.stringify({ conversationId: 'sub1' })).stdout, '{}');
    assert.equal(execHook('Stop', JSON.stringify({ conversationId: 'sub1' })).stdout, '{}');

    const preRes = execHook('PreInvocation', JSON.stringify({ conversationId: 'sub1', invocationNum: 1 }));
    assert.equal(preRes.status, 0);
    const parsed = JSON.parse(preRes.stdout);
    assert.match(parsed.injectSteps[0].systemMessage.metadata.user_markdown, /130\.0k/);

    // Fail-open on malformed stdin
    const badRes = execHook('PreInvocation', '{invalid-json');
    assert.equal(badRes.status, 0);
    assert.equal(badRes.stdout, '{}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

runUnitTests();
runCliTests();
console.log('cache-guard tests passed.');
