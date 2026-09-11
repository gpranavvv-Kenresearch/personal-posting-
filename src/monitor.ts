/**
 * monitor.ts — Claude CLI Master Brain Monitor
 *
 * Tails logs/runtime.log for new ERROR lines.
 * For each error:
 *   - Looks up error-kb.json
 *   - If auto_trusted → applyFix() is already wired in masterCoordinator (no action needed here)
 *   - If known but not trusted → applyFix() for session/config types
 *   - If unknown → calls diagnoseError() → stores diagnosis in KB → writes to human-alerts.json
 *
 * Outputs a JSON summary so Claude CLI can read and act on it.
 *
 * Usage:
 *   npm run dev -- monitor
 *
 * Run by Claude CLI /loop:
 *   /loop
 *   Monitor logs/runtime.log for new ERROR lines.
 *   When errors found: read KB, apply or escalate, verify fix on next row.
 */

import fs from 'fs';
import path from 'path';
import 'dotenv/config';

import {
  normalizeError,
  lookupError,
  getKB,
  saveKB,
  recordFixOutcome,
  type ErrorKBEntry,
} from './errorInterceptor.js';
import { applyFix } from './autoFix.js';

const RUNTIME_LOG    = path.resolve('logs/runtime.log');
const MONITOR_STATE  = path.resolve('logs/.monitor-state.json');
const HUMAN_ALERTS   = path.resolve('logs/human-alerts.json');

interface MonitorState {
  lastByteOffset: number;
  lastRunTs: string;
  runCount: number;
}

interface MonitorSummary {
  newErrors: number;
  autoFixed: number;
  humanAlerts: number;
  unknownErrors: number;
  summary: string[];
}

// ── State persistence ─────────────────────────────────────────────────────────

function loadState(): MonitorState {
  try { return JSON.parse(fs.readFileSync(MONITOR_STATE, 'utf-8')); }
  catch { return { lastByteOffset: 0, lastRunTs: new Date().toISOString(), runCount: 0 }; }
}

function saveState(state: MonitorState): void {
  try {
    fs.mkdirSync(path.dirname(MONITOR_STATE), { recursive: true });
    fs.writeFileSync(MONITOR_STATE, JSON.stringify(state, null, 2));
  } catch { /* non-critical */ }
}

// ── Read new log lines since last offset ──────────────────────────────────────

function readNewLines(state: MonitorState): string[] {
  try {
    if (!fs.existsSync(RUNTIME_LOG)) return [];
    const stat = fs.statSync(RUNTIME_LOG);
    if (stat.size <= state.lastByteOffset) return [];

    const fd = fs.openSync(RUNTIME_LOG, 'r');
    const buf = Buffer.alloc(stat.size - state.lastByteOffset);
    fs.readSync(fd, buf, 0, buf.length, state.lastByteOffset);
    fs.closeSync(fd);

    return buf.toString('utf-8').split('\n').filter(l => l.trim());
  } catch {
    return [];
  }
}

// ── Diagnose unknown error via Claude API ─────────────────────────────────────

async function diagnoseError(
  errorMessage: string,
  context: { platform?: string; stage?: string }
): Promise<string> {
  return `DIAGNOSIS: Check error manually — platform: ${context.platform ?? 'unknown'}, stage: ${context.stage ?? 'unknown'}.\nRESOLUTION: human-review-code`;
}

function parseDiagnosisResponse(raw: string): { diagnosis: string; resolutionType: string | null } {
  const diagMatch = raw.match(/DIAGNOSIS:\s*(.+?)(?:\nRESOLUTION:|$)/s);
  const resMatch  = raw.match(/RESOLUTION:\s*(\S+)/);
  return {
    diagnosis: diagMatch?.[1]?.trim() ?? raw,
    resolutionType: resMatch?.[1]?.trim() ?? null,
  };
}

// ── Process one error line ────────────────────────────────────────────────────

async function processError(
  rawMsg: string,
  summary: MonitorSummary,
): Promise<void> {
  const normalized = normalizeError(rawMsg);
  let entry: ErrorKBEntry | null = lookupError(normalized);

  if (entry) {
    if (entry.auto_trusted) {
      // Auto-fix is already applied inline by masterCoordinator — just log it
      summary.autoFixed++;
      summary.summary.push(`✅ AUTO-FIXED [${entry.id}] ${entry.resolution_type}: ${normalized.slice(0, 80)}`);
      return;
    }

    if (entry.auto_resolvable && entry.resolution_type) {
      // Known fix but not yet trusted — apply session/config fixes here too
      const fixable = ['clear-session', 'restart-browser', 'wait-and-retry', 'fatal-skip'];
      if (fixable.includes(entry.resolution_type)) {
        const result = await applyFix(entry, { platform: entry.platform });
        if (result.applied) {
          recordFixOutcome(entry.id, true);
          summary.autoFixed++;
          summary.summary.push(`🔧 FIX APPLIED [${entry.id}] ${entry.resolution_type}: ${result.description}`);
        }
      } else {
        summary.humanAlerts++;
        summary.summary.push(`⚠️ HUMAN ALERT [${entry.id}]: ${entry.diagnosis ?? 'needs review'}`);
      }
      return;
    }

    // Known but needs human review
    summary.humanAlerts++;
    summary.summary.push(`⚠️ HUMAN NEEDED [${entry.id}] ${entry.resolution_type}: ${normalized.slice(0, 80)}`);
    return;
  }

  // Unknown error — diagnose it
  summary.unknownErrors++;
  const rawDiagnosis = await diagnoseError(rawMsg, { platform: 'unknown', stage: 'unknown' });
  const { diagnosis, resolutionType } = parseDiagnosisResponse(rawDiagnosis);

  // Update KB with diagnosis
  const kb = getKB();
  const existingEntry = kb.entries.find(e => e.normalizedPattern === normalized);
  if (existingEntry) {
    existingEntry.diagnosis = diagnosis;
    if (resolutionType) {
      existingEntry.resolution_type = resolutionType as any;
      existingEntry.auto_resolvable = ['wait-and-retry', 'clear-session', 'restart-browser', 'fatal-skip']
        .includes(resolutionType);
    }
    saveKB(kb);
  }

  // Write human alert
  try {
    fs.mkdirSync(path.dirname(HUMAN_ALERTS), { recursive: true });
    let alerts: any[] = [];
    try { alerts = JSON.parse(fs.readFileSync(HUMAN_ALERTS, 'utf-8')); } catch { /* new file */ }
    alerts.unshift({
      ts: new Date().toISOString(),
      type: 'unknown-error',
      errorPattern: normalized,
      rawSample: rawMsg.slice(0, 200),
      diagnosis,
      suggestedResolution: resolutionType ?? 'unknown',
      action: 'Claude CLI: read logs/human-alerts.json, apply fix, update logs/error-kb.json resolution_type',
    });
    alerts = alerts.slice(0, 50);
    fs.writeFileSync(HUMAN_ALERTS, JSON.stringify(alerts, null, 2));
  } catch { /* non-critical */ }

  summary.summary.push(`🆕 UNKNOWN ERROR diagnosed: ${diagnosis.slice(0, 100)} | suggested: ${resolutionType ?? '?'}`);
}

// ── Main monitor cycle ────────────────────────────────────────────────────────

export async function runMonitorCycle(): Promise<MonitorSummary> {
  const state = loadState();
  const summary: MonitorSummary = {
    newErrors: 0, autoFixed: 0, humanAlerts: 0, unknownErrors: 0, summary: [],
  };

  const newLines = readNewLines(state);

  // Update byte offset
  try {
    const stat = fs.statSync(RUNTIME_LOG);
    state.lastByteOffset = stat.size;
  } catch { /* log not created yet */ }

  state.lastRunTs = new Date().toISOString();
  state.runCount++;
  saveState(state);

  // Process ERROR lines only
  for (const line of newLines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.level !== 'ERROR') continue;

      const msg: string = parsed.msg ?? '';
      if (!msg.trim()) continue;

      summary.newErrors++;
      await processError(msg, summary);
    } catch {
      // Not valid JSON or not an error line — skip
    }
  }

  if (summary.newErrors === 0) {
    summary.summary.push('✅ No new errors since last monitor cycle');
  }

  return summary;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('monitor.ts') || process.argv[1]?.endsWith('monitor.js')) {
  runMonitorCycle()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Monitor cycle failed:', err.message);
      process.exit(1);
    });
}
