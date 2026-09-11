/**
 * modelHealthTracker.ts — Self-healing circuit breaker for LLM model pools.
 *
 * Free/preview model tiers (OpenRouter, NVIDIA NIM) go end-of-life or start
 * returning garbage with no warning — confirmed live 2026-08-27 when NVIDIA's
 * pinned model died overnight (HTTP 410, every key, no notice). Nobody caught
 * it until it was manually probed. This tracker makes callLLM() catch that
 * itself: a model that keeps failing gets quarantined out of rotation
 * automatically, and un-quarantined after a cooldown in case it comes back.
 *
 * Persists to .sessions/model-health.json so state survives process restarts.
 */
import fs from 'fs';
import path from 'path';

const HEALTH_FILE = path.resolve('.sessions/model-health.json');

// After this many consecutive bad outcomes, stop sending traffic to the
// model until the cooldown passes. 5 is high enough that a couple of
// unlucky trash responses (models are non-deterministic) won't trip it, but
// low enough to react within one batch run once a model is actually dead.
const FAILURE_THRESHOLD = 5;
const QUARANTINE_MS = 6 * 60 * 60 * 1000; // 6 hours — long enough to skip a dead model for the rest of a batch day, short enough to self-heal if it was transient

interface ModelHealth {
  consecutiveFailures: number;
  quarantinedUntil: number | null; // epoch ms
  lastReason: string | null;
}

type HealthState = Record<string, ModelHealth>;

function loadState(): HealthState {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state: HealthState): void {
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2));
  } catch { /* non-critical — worst case health tracking resets */ }
}

/**
 * True if this model is currently quarantined and should be skipped without
 * even attempting a request. Quarantine auto-expires after QUARANTINE_MS —
 * callers don't need to clear it manually.
 */
export function isModelQuarantined(model: string): boolean {
  const state = loadState();
  const entry = state[model];
  if (!entry?.quarantinedUntil) return false;
  return Date.now() < entry.quarantinedUntil;
}

/**
 * Record a real generation outcome for a model. Only call this for outcomes
 * that reflect the MODEL's health (clean text vs. trash/dead-endpoint) — not
 * transient per-key issues like rate limits or network blips, which say
 * nothing about whether the model itself is broken.
 */
export function recordModelOutcome(model: string, outcome: 'ok' | 'bad', reason?: string): void {
  const state = loadState();
  const entry: ModelHealth = state[model] ?? { consecutiveFailures: 0, quarantinedUntil: null, lastReason: null };

  if (outcome === 'ok') {
    if (entry.consecutiveFailures > 0 || entry.quarantinedUntil) {
      console.log(`   ✅ Model health: ${model} recovered — clearing quarantine/failure count`);
    }
    entry.consecutiveFailures = 0;
    entry.quarantinedUntil = null;
    entry.lastReason = null;
  } else {
    entry.consecutiveFailures += 1;
    entry.lastReason = reason ?? 'unknown';
    if (entry.consecutiveFailures >= FAILURE_THRESHOLD && !entry.quarantinedUntil) {
      entry.quarantinedUntil = Date.now() + QUARANTINE_MS;
      console.warn(
        `   🚨 Model health: ${model} failed ${entry.consecutiveFailures} times in a row (${entry.lastReason}) — ` +
        `quarantining for ${QUARANTINE_MS / 3600000}h. Check debug-scratch/probeFreeModels.mjs to confirm it's actually dead.`
      );
    }
  }

  state[model] = entry;
  saveState(state);
}
