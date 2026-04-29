/**
 * errorInterceptor.ts — Error Knowledge Base + Runtime Log
 *
 * - Patches console.error/warn to write JSON lines to logs/runtime.log
 * - Normalizes error messages to stable patterns for KB keying
 * - Records every error into logs/error-kb.json with classification + history
 * - Tracks fix outcomes so errors graduate to auto_trusted after 3 successes
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { classifyError, ErrorReason } from './browser/resilientBrowser.js';

const RUNTIME_LOG  = path.resolve('logs/runtime.log');
const KB_FILE      = path.resolve('logs/error-kb.json');
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB

export type ResolutionType =
  | 'wait-and-retry'
  | 'clear-session'
  | 'restart-browser'
  | 'rotate-account'
  | 'skip-row'
  | 'human-review-login'
  | 'human-review-code'
  | 'fatal-skip';

export interface ErrorKBEntry {
  id: string;                       // first 8 chars of SHA-256(normalizedPattern)
  normalizedPattern: string;
  rawSamples: string[];             // last 3 actual messages
  platform: string;
  stage: string;
  classification: ErrorReason;
  count: number;
  auto_resolvable: boolean;
  auto_trusted: boolean;            // true when worked_count >= 3
  resolution_type: ResolutionType | null;
  resolution_action: string | null;
  worked_count: number;
  failed_count: number;
  pending_verification: boolean;
  pending_since_run: number | null;
  diagnosis: string | null;         // set by monitor.ts via diagnoseError()
  last_seen: string;
  first_seen: string;
}

export interface ErrorKB {
  version: number;
  entries: ErrorKBEntry[];
  global_run_count: number;
  last_updated: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureLogsDir(): void {
  fs.mkdirSync(path.dirname(RUNTIME_LOG), { recursive: true });
}

function rotateLogIfNeeded(): void {
  try {
    const stat = fs.statSync(RUNTIME_LOG);
    if (stat.size > MAX_LOG_SIZE) {
      fs.renameSync(RUNTIME_LOG, RUNTIME_LOG + '.bak');
      // Reset monitor byte offset on rotation
      const stateFile = path.resolve('logs/.monitor-state.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        state.lastByteOffset = 0;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      }
    }
  } catch { /* non-critical */ }
}

function appendToLog(level: 'ERROR' | 'WARN' | 'INFO', msg: string): void {
  try {
    rotateLogIfNeeded();
    const line = JSON.stringify({ level, ts: new Date().toISOString(), msg }) + '\n';
    fs.appendFileSync(RUNTIME_LOG, line);
  } catch { /* non-critical */ }
}

// ── KB read / write ───────────────────────────────────────────────────────────

export function getKB(): ErrorKB {
  try {
    return JSON.parse(fs.readFileSync(KB_FILE, 'utf-8')) as ErrorKB;
  } catch {
    return { version: 2, entries: [], global_run_count: 0, last_updated: new Date().toISOString() };
  }
}

export function saveKB(kb: ErrorKB): void {
  try {
    fs.mkdirSync(path.dirname(KB_FILE), { recursive: true });
    kb.last_updated = new Date().toISOString();
    fs.writeFileSync(KB_FILE, JSON.stringify(kb, null, 2));
  } catch { /* non-critical */ }
}

// ── Normalize ─────────────────────────────────────────────────────────────────

export function normalizeError(raw: string): string {
  return raw
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, '<TIMESTAMP>')
    .replace(/[Tt]imeout\s+\d+\s*ms/g, 'Timeout <N>ms')
    .replace(/attempt\s+\d+/gi, 'attempt <N>')
    .replace(/[Rr]ow\s+\d+/g, 'Row <N>')
    .replace(/[Bb]atch\s+\d+/g, 'Batch <N>')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<EMAIL>')
    .replace(/https?:\/\/[^\s"')]+/g, '<URL>')
    .replace(/\b\d{5,}\b/g, '<ID>')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300);
}

function makeId(pattern: string): string {
  return crypto.createHash('sha256').update(pattern).digest('hex').slice(0, 8);
}

// ── Default resolution type from classification ───────────────────────────────

function defaultResolution(classification: ErrorReason, raw: string): ResolutionType {
  const e = raw.toLowerCase();

  // Account not logged in — needs manual save-*-session run
  if (e.includes('session_not_initialized') || e.includes('login_required')) return 'human-review-login';

  if (classification === 'FATAL') return 'fatal-skip';
  if (classification === 'NEEDS_HUMAN') {
    if (e.includes('otp') || e.includes('2fa') || e.includes('captcha') ||
        e.includes('verification') || e.includes('unusual activity')) return 'human-review-login';
    return 'human-review-login';
  }
  if (classification === 'RETRYABLE') {
    if (e.includes('browser') || e.includes('context') || e.includes('target page')) return 'restart-browser';
    return 'wait-and-retry';
  }
  // FIXABLE
  if (e.includes('login') || e.includes('session') || e.includes('/login page')) return 'clear-session';
  return 'human-review-code';
}

// ── Pending verification check ────────────────────────────────────────────────

function checkPendingVerifications(kb: ErrorKB): void {
  for (const entry of kb.entries) {
    if (!entry.pending_verification) continue;
    const runsSinceFix = kb.global_run_count - (entry.pending_since_run ?? 0);
    if (entry.worked_count >= 3) {
      entry.auto_trusted = true;
      entry.pending_verification = false;
    } else if (runsSinceFix > 10 && entry.worked_count === 0) {
      // Fix never worked — reset to manual review
      entry.pending_verification = false;
      entry.auto_resolvable = false;
    }
  }
}

// ── Lookup ────────────────────────────────────────────────────────────────────

export function lookupError(normalized: string): ErrorKBEntry | null {
  const kb = getKB();
  return kb.entries.find(e => e.normalizedPattern === normalized) ?? null;
}

// ── Record error ──────────────────────────────────────────────────────────────

export function recordError(params: {
  rawError: string;
  platform: string;
  stage: string;
  rowIndex?: number;
  rowTitle?: string;
  batchRun: number;
}): ErrorKBEntry {
  const normalized = normalizeError(params.rawError);
  const kb = getKB();

  // Check if pending verifications have matured
  checkPendingVerifications(kb);

  let entry = kb.entries.find(e => e.normalizedPattern === normalized);

  if (entry) {
    // Update existing
    entry.count++;
    entry.last_seen = new Date().toISOString();
    entry.rawSamples = [params.rawError, ...entry.rawSamples].slice(0, 3);

    // If same error recurs while pending_verification, the fix did NOT work
    if (entry.pending_verification) {
      entry.failed_count++;
      entry.worked_count = Math.max(0, entry.worked_count - 1);
      if (entry.failed_count >= 3) {
        entry.auto_resolvable = false;
        entry.auto_trusted = false;
        entry.pending_verification = false;
        entry.resolution_type = 'human-review-code';
      }
    }
  } else {
    // New error
    const classification = classifyError(params.rawError);
    const resType = defaultResolution(classification, params.rawError);
    entry = {
      id: makeId(normalized),
      normalizedPattern: normalized,
      rawSamples: [params.rawError],
      platform: params.platform,
      stage: params.stage,
      classification,
      count: 1,
      auto_resolvable: classification === 'RETRYABLE' || classification === 'FATAL',
      auto_trusted: false,
      resolution_type: resType,
      resolution_action: null,
      worked_count: 0,
      failed_count: 0,
      pending_verification: false,
      pending_since_run: null,
      diagnosis: null,
      last_seen: new Date().toISOString(),
      first_seen: new Date().toISOString(),
    };
    kb.entries.push(entry);
  }

  saveKB(kb);

  // Write ERROR line to runtime.log for monitor to pick up
  appendToLog('ERROR', `[${params.platform}:${params.stage}] ${params.rawError}`);

  return entry;
}

// ── Record fix outcome ────────────────────────────────────────────────────────

export function recordFixOutcome(entryId: string, worked: boolean): void {
  const kb = getKB();
  const entry = kb.entries.find(e => e.id === entryId);
  if (!entry) return;

  if (worked) {
    entry.worked_count++;
    if (entry.worked_count >= 3) {
      entry.auto_trusted = true;
      entry.pending_verification = false;
    }
  } else {
    entry.failed_count++;
    entry.worked_count = Math.max(0, entry.worked_count - 1);
  }

  saveKB(kb);
}

// ── initErrorInterceptor ──────────────────────────────────────────────────────
// Call once at process start. Patches console.error/warn to also write to
// logs/runtime.log as structured JSON lines for the monitor to tail.

export function initErrorInterceptor(): void {
  ensureLogsDir();

  const origError = console.error.bind(console);
  const origWarn  = console.warn.bind(console);

  console.error = (...args: any[]) => {
    origError(...args);
    appendToLog('ERROR', args.map(String).join(' '));
  };

  console.warn = (...args: any[]) => {
    origWarn(...args);
    appendToLog('WARN', args.map(String).join(' '));
  };
}
