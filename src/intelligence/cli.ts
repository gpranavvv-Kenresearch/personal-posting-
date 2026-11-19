/**
 * cli.ts — the human interface to the distribution-intelligence layer.
 *
 * Everything else in src/intelligence/ is a library. This file is the only
 * place a person actually types a command and reads an answer.
 *
 * Design rules, in priority order:
 *
 *  1. NOTHING here touches live external content unless a human typed an
 *     explicit flag AND the feature flags allow it. `apply` is a dry run by
 *     default and says so in a banner.
 *  2. Every command works against an EMPTY database. "No data yet" is a normal
 *     answer, printed as a sentence, never as a stack trace.
 *  3. Secrets are never printed. Tokens, keys and spreadsheet ids go through
 *     maskSecret()/maskId() without exception.
 *  4. The most valuable command is `status`: it tells a human which features
 *     CANNOT work yet and exactly which credential is missing. Most of this
 *     system's real-world failure mode is "nobody granted access", and that is
 *     invisible unless something says it out loud.
 *
 * Exit codes: 0 success, 1 error.
 *
 * Usage:  npm run intel -- status
 */

// MUST be first: ESM imports are hoisted and evaluated before any statement
// in this module body, and sheetIds.ts resolves the spreadsheet ids AT IMPORT
// TIME. Loading dotenv later (inside main) was too late — the .env never
// reached the resolver, so a configured development run failed to start.
import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import {
  openDb, dbPath, closeDb, currentVersion, migrate, nowIso, isoDate, daysAgo,
  type DB,
} from './db.js';
import { MAIN_SHEET_ID } from '../config/sheetIds.js';
import { LATEST_VERSION } from './schema.js';
import { FLAGS, enabled, mayMutateExternally } from './flags.js';
import {
  DEFAULT_INTERLINK_LIMITS, loadInterlinkLimits, loadWeights, WEIGHTS_VERSION,
  DEFAULT_THRESHOLDS,
} from './weights.js';
import { editablePlatforms } from './platforms.js';
import { scoreReports, type ScoreResult } from './scoring.js';
import { analysePlatforms, formatPlatformReport, computePlatformStats, matchPlatformsForReport, formatPlatformMatchReport } from './platformIntelligence.js';
import { analyseContent, formatContentReport } from './contentIntelligence.js';
import { checkIndexation } from './indexation.js';
import { ingestFromSheet, mappingCoverage } from './urlMapping.js';
import { collectGsc } from './collectors/gsc.js';
import { collectGa4 } from './collectors/ga4.js';
import { collectPipedrive } from './collectors/pipedrive.js';
import { importV02Indexation } from './collectors/v02Indexation.js';
import { looksLikeSourceExport, importSourceExport } from './collectors/sourceImport.js';
import { importManualExportFile, type ManualImportSource } from './collectors/manualImport.js';
import { buildDashboardData, writeDashboard } from './dashboard.js';
import { describeSheetConfig, KEN_ENV } from '../config/sheetIds.js';

// ── Output seam ──────────────────────────────────────────────────────────────

export interface Out {
  log(line: string): void;
  error(line: string): void;
}

export const consoleOut: Out = {
  log: (l: string) => console.log(l),
  error: (l: string) => console.error(l),
};

/** Collects output instead of printing it. Used by the tests. */
export function bufferOut(): Out & { lines: string[]; errors: string[]; text(): string } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    log: (l: string) => { lines.push(l); },
    error: (l: string) => { errors.push(l); },
    text: () => [...lines, ...errors].join('\n'),
  };
}

// ── Argument parsing ─────────────────────────────────────────────────────────

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that consume the following token when not written as --name=value. */
export const VALUE_FLAGS = new Set(['v02-db', 
  'db', 'days', 'limit', 'tab', 'by', 'start', 'end', 'platform', 'site', 'reason',
  'file', 'source', 'date', 'domain', 'out', 'inbox',
]);

/**
 * Deliberately tiny argv parser — no dependency, no surprises.
 *
 *   intel score --days=30 --limit 20
 *   intel approve 17 --by alice
 *   intel apply --apply
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') { positionals.push(...argv.slice(i + 1)); break; }

    if (tok === '-h' || tok === '--help') { flags.help = true; continue; }

    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[++i];
        continue;
      }
      flags[body] = true;
      continue;
    }
    positionals.push(tok);
  }

  const command = positionals.length ? positionals[0] : (flags.help ? 'help' : 'status');
  return { command, positionals: positionals.slice(1), flags };
}

export function flagStr(a: ParsedArgs, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagNum(a: ParsedArgs, name: string, def: number): number {
  const v = flagStr(a, name);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function flagBool(a: ParsedArgs, name: string): boolean {
  return a.flags[name] === true || a.flags[name] === 'true' || a.flags[name] === '1';
}

/** Nobody has a legitimate reason to ask one command for more than this. */
export const MAX_LIMIT = 10_000;
/** Ten years. Anything larger is a typo, not a window. */
export const MAX_DAYS = 3650;

/**
 * An integer flag, clamped. Three real failures this prevents:
 *
 *  - `--limit 2.7` — node:sqlite binds integers only, so a fractional LIMIT
 *    crashed the command with the opaque message "datatype mismatch".
 *  - `--limit -1`  — in SQLite a NEGATIVE limit means "no limit at all", so
 *    `index-check --limit -1` would have sent every post we know to a paid
 *    SERP provider. The opposite of what the operator typed.
 *  - `--days 1e400` — Infinity, which then propagates into date arithmetic.
 *
 * A non-numeric value falls back to the default rather than failing: the
 * command still does something sensible and says what it did.
 */
export function flagInt(
  a: ParsedArgs, name: string, def: number, min: number, max: number,
): number {
  const raw = flagStr(a, name);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Row limits: non-negative integers, capped. `def` is used when unset. */
export function flagLimit(a: ParsedArgs, def: number): number {
  return flagInt(a, 'limit', def, 0, MAX_LIMIT);
}

/** Window sizes: at least one day, at most ten years. */
export function flagDays(a: ParsedArgs, def: number): number {
  return flagInt(a, 'days', def, 1, MAX_DAYS);
}

// ── Masking ──────────────────────────────────────────────────────────────────

/**
 * Safe rendering of anything secret-ish. Never returns enough of the value to
 * be useful to someone reading a log, but returns enough to answer "is the
 * thing I pasted the thing that is loaded?".
 *
 * maskSecret/maskEmail/CredentialCheck/checkCredentials/formatCredentials
 * moved to reporting.ts so dashboard.ts can reuse them without importing
 * this file (which would create a cycle, since this file imports
 * dashboard.ts for the `dashboard` command). Re-exported below so every
 * existing import of these from cli.ts keeps working unchanged.
 */
export {
  maskSecret, maskEmail, SERVICE_ACCOUNT_FILE, checkCredentials, formatCredentials,
  tableCounts, formatTableCounts, knownReportUrls, recentPublishedPosts,
  selectUrlsForIndexCheck, proposalsByStatus, formatProposals,
} from './reporting.js';
export type { CredentialCheck, ProposalRow } from './reporting.js';
import {
  maskSecret, maskEmail, checkCredentials, formatCredentials,
  tableCounts, formatTableCounts, knownReportUrls,
  selectUrlsForIndexCheck, proposalsByStatus, formatProposals,
} from './reporting.js';

// ── Flag rendering ───────────────────────────────────────────────────────────

export function formatFlags(): string {
  const keys = Object.keys(FLAGS) as Array<keyof typeof FLAGS>;
  const w = Math.max(...keys.map(k => String(k).length));
  const lines = keys.map(k => {
    const raw = Boolean(FLAGS[k]);
    const eff = k === 'SHADOW_MODE' ? raw : enabled(k);
    const note = raw && !eff && k !== 'SHADOW_MODE' ? '  (inert: FEATURE_INTELLIGENCE is off)' : '';
    return `  ${(raw ? 'ON ' : 'off')}  ${String(k).padEnd(w)}${note}`;
  });
  if (!FLAGS.INTELLIGENCE_ENABLED) {
    lines.push('');
    lines.push('  FEATURE_INTELLIGENCE is off — the master switch. Every other flag is ignored,');
    lines.push('  collection is a no-op, and the existing automation behaves exactly as before.');
  }
  if (FLAGS.SHADOW_MODE) {
    lines.push('');
    lines.push('  SHADOW_MODE is on — everything is computed and recorded, nothing is acted on.');
  }
  return lines.join('\n');
}

// ── Database helpers ─────────────────────────────────────────────────────────

interface Handle { db: DB; file: string; existedBefore: boolean; owned: boolean }

function openHandle(args: ParsedArgs, override?: string): Handle {
  const explicit = override ?? flagStr(args, 'db');
  const file = explicit ? path.resolve(explicit) : dbPath();
  const existedBefore = fs.existsSync(file);
  const db = openDb(file);
  return { db, file, existedBefore, owned: file !== dbPath() };
}

function release(h: Handle): void {
  if (h.owned) { try { h.db.close(); } catch { /* already closed */ } }
}

// ── Banners ──────────────────────────────────────────────────────────────────

export function banner(title: string, lines: string[] = []): string {
  const bar = '='.repeat(Math.max(title.length, 60));
  return [bar, title, bar, ...lines].join('\n');
}

export const LIVE_WARNING = banner('!! LIVE MODE — THIS WILL EDIT PUBLISHED PAGES !!', [
  'Approved interlink proposals will be written to real, public posts.',
  'Stop now (Ctrl-C) if that is not what you meant.',
  '',
]);

export const DRY_RUN_BANNER = banner('DRY RUN — nothing outside this machine will change', [
  'Showing what WOULD be applied. Re-run with --apply to make real changes.',
  '',
]);

// ── Optional modules (built later; absence is normal, not an error) ──────────

async function optionalModule(spec: string): Promise<any | null> {
  try {
    return await import(spec);
  } catch (err: any) {
    const code = String(err?.code ?? '');
    if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module|Failed to load url/i.test(String(err?.message))) {
      return null;
    }
    throw err;
  }
}

const NOT_INSTALLED = (what: string, file: string) =>
  `${what} is not installed yet (${file} does not exist). ` +
  `Nothing was changed. This command becomes useful once that module lands.`;

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdStatus(args: ParsedArgs, out: Out, env: NodeJS.ProcessEnv): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('INTELLIGENCE STATUS'));
    out.log('');
    out.log(`Environment : ${KEN_ENV}`);
    out.log(`Sheets      : ${describeSheetConfig()}`);
    out.log(`Database    : ${h.file}`);
    out.log(`              ${h.existedBefore ? 'existed already' : 'did not exist — created now'}`);
    out.log(`Schema      : v${currentVersion(h.db)} (code understands v${LATEST_VERSION})`);
    out.log(`Weights     : ${WEIGHTS_VERSION}`);
    out.log('');
    out.log('FEATURE FLAGS');
    out.log(formatFlags());
    out.log('');
    out.log('CREDENTIALS');
    out.log(formatCredentials(checkCredentials(env)));
    out.log('');
    out.log('TABLES');
    out.log(formatTableCounts(tableCounts(h.db)));

    const coverage = mappingCoverage(h.db);
    const coverageKeys = Object.keys(coverage);
    out.log('');
    out.log('URL MAPPING COVERAGE');
    out.log(coverageKeys.length
      ? coverageKeys.map(k => `  ${k.padEnd(8)} ${coverage[k]}`).join('\n')
      : '  none yet — run "ingest" to map report URLs to published posts');
    return 0;
  } finally {
    release(h);
  }
}

async function cmdMigrate(args: ParsedArgs, out: Out): Promise<number> {
  const file = flagStr(args, 'db') ? path.resolve(flagStr(args, 'db')!) : dbPath();
  const existedBefore = fs.existsSync(file);
  // openDb() migrates on open, so read the version from a pre-open probe.
  const h = openHandle(args);
  try {
    const after = currentVersion(h.db);
    out.log(`Database  : ${h.file}`);
    out.log(`Before    : ${existedBefore ? 'existing database' : 'new database (version 0)'}`);
    out.log(`After     : v${after} of v${LATEST_VERSION}`);
    const applied = migrate(h.db);
    out.log(applied
      ? `Applied ${applied} further migration(s); now at v${currentVersion(h.db)}.`
      : 'No pending migrations.');
    return 0;
  } finally {
    release(h);
  }
}

async function cmdCollect(args: ParsedArgs, out: Out, env: NodeJS.ProcessEnv): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('COLLECT', [
      'Reads external analytics APIs and writes to the LOCAL database only.',
      'No published content is touched by this command.',
      '',
    ]));

    const creds = checkCredentials(env);
    const credFor = (name: string) => creds.find(c => c.feature === name)!;
    const days = flagDays(args, 7);
    let ran = 0;
    let skipped = 0;

    // GSC
    const gscCred = credFor('Google Search Console');
    if (!enabled('GSC_COLLECTION')) {
      out.log('  SKIP  gsc       — FEATURE_GSC_COLLECTION (or FEATURE_INTELLIGENCE) is off');
      skipped++;
    } else if (!gscCred.ok) {
      out.log(`  SKIP  gsc       — missing credential: ${gscCred.missing.join(', ')}`);
      skipped++;
    } else {
      const end = flagStr(args, 'end') ?? daysAgo(3);
      const start = flagStr(args, 'start') ?? daysAgo(days + 3);
      const r = await collectGsc({ db: h.db, startDate: start, endDate: end, log: () => {} });
      out.log(`  ${r.status === 'ok' ? 'OK  ' : 'WARN'}  gsc       — ${r.status}, ${r.rowsWritten} rows${r.reason ? ` (${r.reason})` : ''}`);
      ran++;
    }

    // GA4
    const ga4Cred = credFor('Google Analytics 4');
    if (!enabled('GA4_COLLECTION')) {
      out.log('  SKIP  ga4       — FEATURE_GA4_COLLECTION (or FEATURE_INTELLIGENCE) is off');
      skipped++;
    } else if (!ga4Cred.ok) {
      out.log(`  SKIP  ga4       — missing credential: ${ga4Cred.missing.join(', ')}`);
      skipped++;
    } else {
      const r = await collectGa4({
        db: h.db,
        startDate: flagStr(args, 'start') ?? daysAgo(days),
        endDate: flagStr(args, 'end') ?? isoDate(),
      });
      out.log(`  ${r.status === 'ok' ? 'OK  ' : 'WARN'}  ga4       — ${r.status}, ${r.rowsWritten} rows${r.errors.length ? ` (${r.errors.length} error(s))` : ''}`);
      ran++;
    }

    // Pipedrive
    const pdCred = credFor('Pipedrive (leads)');
    if (!enabled('PIPEDRIVE_COLLECTION')) {
      out.log('  SKIP  pipedrive — FEATURE_PIPEDRIVE_COLLECTION (or FEATURE_INTELLIGENCE) is off');
      skipped++;
    } else if (!pdCred.ok) {
      out.log(`  SKIP  pipedrive — missing credential: ${pdCred.missing.join(', ')}`);
      skipped++;
    } else {
      const r = await collectPipedrive({ db: h.db, since: daysAgo(days) });
      out.log(`  ${r.status === 'ok' ? 'OK  ' : 'WARN'}  pipedrive — ${r.status}, ${r.rows} rows${r.error ? ` (${r.error})` : ''}`);
      ran++;
    }

    out.log('');
    out.log(`${ran} collector(s) ran, ${skipped} skipped.`);
    if (skipped) out.log('Run "intel status" for exactly what each skipped collector needs.');
    return 0;
  } finally {
    release(h);
  }
}

/**
 * import-performance — read a GA4 or Search Console CSV export the operator
 * downloaded themselves (no API credentials, no service-account access
 * granted to anyone). Writes into the SAME url_performance table the live
 * ga4/gsc collectors would write to, so scoring/platform/interlink code
 * cannot tell the difference.
 */
async function cmdImportPerformance(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('IMPORT-PERFORMANCE — load a GA4/GSC export file', [
      'Reads a CSV you exported yourself from the GA4 or Search Console UI.',
      'No credentials are read or required. Writes to the local database only.',
      '',
    ]));

    const file = flagStr(args, 'file');
    const sourceFlag = flagStr(args, 'source');
    const date = flagStr(args, 'date');

    if (!file || !sourceFlag || !date) {
      out.log('Usage: intel import-performance --file <path.csv> --source ga4|gsc --date YYYY-MM-DD [--domain https://www.kenresearch.com]');
      out.log('');
      out.log('  --file    Path to the CSV you exported from the GA4 or Search Console UI.');
      out.log('  --source  "ga4" or "gsc" — which report this export came from.');
      out.log('  --date    YYYY-MM-DD. GA4/GSC exports carry one aggregate number per URL');
      out.log('            for whichever date range you picked on screen, not a date per');
      out.log('            row — give the date the export represents (e.g. the day you ran it,');
      out.log('            or the last day of the range). Re-running with the SAME date');
      out.log('            updates that row instead of duplicating it.');
      return 1;
    }
    if (sourceFlag !== 'ga4' && sourceFlag !== 'gsc') {
      out.log(`--source must be "ga4" or "gsc", got ${JSON.stringify(sourceFlag)}.`);
      return 1;
    }
    if (!fs.existsSync(file)) {
      out.log(`File not found: ${file}`);
      return 1;
    }

    const source: ManualImportSource = sourceFlag === 'ga4' ? 'ga4-manual' : 'gsc-manual';
    const domain = flagStr(args, 'domain');
    if (sourceFlag === 'ga4') {
      const text = fs.readFileSync(file, 'utf8');
      if (looksLikeSourceExport(text)) {
        const r = importSourceExport(h.db, text, date);
        out.log('Detected a GA4 "Session source" export (per-platform traffic).');
        out.log(`Parsed ${r.rowsParsed} source row(s), wrote ${r.rowsWritten} distinct source(s).`);
        out.log('Sessions matched to platforms:');
        for (const [k, v] of Object.entries(r.matchedPlatforms).sort((a, b) => b[1] - a[1])) out.log(`  ${k.padEnd(16)} ${v}`);
        out.log(`Sessions from sources that match no platform (direct, google, etc.): ${r.unmatchedSessions}`);
        return 0;
      }
    }
    const result = importManualExportFile(h.db, file, { source, metricDate: date, ...(domain ? { domain } : {}) });

    out.log(`Matched columns: ${JSON.stringify(result.matchedColumns)}`);
    out.log(`Parsed ${result.rowsParsed} row(s), skipped ${result.rowsSkipped}, wrote ${result.rowsWritten}.`);
    if (result.skippedReasons.length) {
      out.log('');
      out.log('Skipped rows / notes:');
      for (const reason of result.skippedReasons.slice(0, 20)) out.log(`  - ${reason}`);
      if (result.skippedReasons.length > 20) out.log(`  ... and ${result.skippedReasons.length - 20} more`);
    }
    return result.rowsWritten > 0 || result.rowsParsed === 0 ? 0 : 1;
  } finally {
    release(h);
  }
}

/** import-v02-indexation: reuse V0.2's Google URL Inspection verdicts (read-only, no quota). */
async function cmdImportV02Indexation(args: ParsedArgs, out: Out): Promise<number> {
  const dbPath = flagStr(args, 'v02-db');
  if (!dbPath) { out.log('Usage: intel import-v02-indexation --v02-db <path to V0.2 state.db>'); return 1; }
  if (!fs.existsSync(dbPath)) { out.log(`File not found: ${dbPath}`); return 1; }
  const h = openHandle(args);
  try {
    const r = importV02Indexation(h.db, dbPath);
    out.log(`Tracked reports: ${r.trackedReports}; matched in V0.2: ${r.matched}.`);
    out.log(`Recorded: ${r.recorded.indexed} indexed, ${r.recorded.not_indexed} not indexed. Skipped (no verdict yet): ${r.skipped}.`);
    out.log('V0.2 state.db was opened read-only; no inspection quota was used.');
    return 0;
  } finally {
    release(h);
  }
}

async function cmdIngest(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    // 'Blogs' was Pranav's old name for this tab; it was renamed to 'New
    // Logic' and no longer exists under the old name (confirmed 2026-11-16).
    const tabs = (flagStr(args, 'tab') ?? 'Social Media,New Logic').split(',').map(t => t.trim()).filter(Boolean);
    const limit = flagLimit(args, Infinity);
    const force = flagBool(args, 'force');

    out.log(banner('INGEST — sheet to local database', [
      'Reads the distribution sheet READ-ONLY and populates published_posts / url_mapping.',
      '',
    ]));

    // --live reads the REAL tabs through the read-only exception
    // (config/readOnlySheets.ts). That client is created with Google's
    // spreadsheets.readonly scope, so Google itself rejects any write with 403
    // — verified. Without --live the tab lock applies and reads land on the
    // empty test tab, which is the safe default.
    const live = flagBool(args, 'live');
    let readOnly: any = null;
    if (live) {
      const { createReadOnlySheets, readOnlyAvailable } = await import('../config/readOnlySheets.js');
      if (!readOnlyAvailable()) {
        out.error('  --live needs a Google service account; none found. Run "intel status".');
        return 1;
      }
      out.log('  READ-ONLY LIVE MODE — reading the real tabs. This client cannot write (403 by scope).');
      out.log('');
      readOnly = await createReadOnlySheets({ log: () => {} });
    }

    for (const tab of tabs) {
      const readRows = readOnly
        ? async () => await readOnly.getValues(MAIN_SHEET_ID, `'${tab.replace(/'/g, "''")}'!A:BZ`)
        : undefined;
      const r = await ingestFromSheet({ db: h.db, tab, limit, force, readRows });
      if (r.reason && r.rowsRead === 0) {
        out.log(`  SKIP  ${tab} — ${r.reason}`);
        continue;
      }
      out.log(
        `  ${r.ok ? 'OK  ' : 'FAIL'}  ${tab} — ${r.rowsRead} rows read, ` +
        `${r.postsUpserted} posts, ${r.mappingsUpserted} mappings, ${r.skippedRows} skipped`,
      );
      for (const w of (r.warnings ?? []).slice(0, 5)) out.log(`         warn: ${w}`);
    }

    const cov = mappingCoverage(h.db);
    const keys = Object.keys(cov);
    out.log('');
    out.log(keys.length
      ? `Mapping coverage: ${keys.map(k => `${k}=${cov[k]}`).join(', ')}`
      : 'No mappings yet. If this surprised you, check credentials with "intel status".');
    return 0;
  } finally {
    release(h);
  }
}

async function cmdIndexCheck(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('INDEXATION CHECK', [
      'Asks a SERP provider whether published posts are visible in search.',
      'A negative result is EVIDENCE, not proof — see indexation.ts.',
      '',
    ]));

    if (!enabled('INDEXATION_CHECKS')) {
      out.log('FEATURE_INDEXATION_CHECKS (or FEATURE_INTELLIGENCE) is off — nothing checked.');
      return 0;
    }

    // Daily call budget. 43k+ URLs and ~free-tier SERP capacity cannot both
    // be satisfied by "check everything" — see docs/INTELLIGENCE-RUNBOOK.md,
    // "Sizing the indexation check budget". Default of 100 is a placeholder;
    // set INDEX_CHECK_DAILY_BUDGET to whatever the provisioned keys can
    // actually sustain per day.
    const envBudget = Number(process.env.INDEX_CHECK_DAILY_BUDGET);
    const defaultBudget = Number.isFinite(envBudget) && envBudget > 0 ? envBudget : 100;
    const budget = flagLimit(args, defaultBudget);
    const newBudget = Math.ceil(budget * 0.7);
    const backlogBudget = budget - newBudget;

    const posts = selectUrlsForIndexCheck(h.db, { newBudget, backlogBudget });
    if (!posts.length) {
      out.log('No published posts in the database yet — run "ingest" first.');
      return 0;
    }

    out.log(`Budget ${budget}/run (${newBudget} newest posts, ${backlogBudget} oldest-checked backlog).`);
    const s = await checkIndexation({ db: h.db, urls: posts, limit: budget });
    out.log(`Considered ${s.considered}, skipped ${s.skippedRecent} as recently checked, checked ${s.checked}.`);
    out.log(`  indexed ${s.indexed}   not indexed ${s.notIndexed}   unknown ${s.unknown}`);
    if (s.unknown) out.log('  "unknown" usually means the provider throttled us, not that the page is missing.');
    return 0;
  } finally {
    release(h);
  }
}

export function formatScoreTable(results: ScoreResult[]): string {
  if (!results.length) {
    return 'No scores. Either no reports are known (run "ingest") or FEATURE_OPPORTUNITY_SCORING is off.';
  }
  const lines: string[] = [
    `${'#'.padStart(3)}  ${'SCORE'.padStart(6)}  ${'COVER'.padStart(5)}  REPORT`,
    `${'-'.repeat(3)}  ${'-'.repeat(6)}  ${'-'.repeat(5)}  ${'-'.repeat(40)}`,
  ];
  results.forEach((r, i) => {
    lines.push(`${String(i + 1).padStart(3)}  ${r.score.toFixed(3).padStart(6)}  ${(r.coverage * 100).toFixed(0).padStart(4)}%  ${r.reportUrl}`);
    lines.push(`     ${r.explanation}`);
  });
  lines.push('');
  lines.push('COVER is how much of the weighted signal was actually available. A high score');
  lines.push('on low coverage is a guess, not a finding.');
  return lines.join('\n');
}

async function cmdScore(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('OPPORTUNITY SCORES'));
    out.log('');
    if (!enabled('OPPORTUNITY_SCORING')) {
      out.log('FEATURE_OPPORTUNITY_SCORING (or FEATURE_INTELLIGENCE) is off — nothing scored.');
      out.log(`Weights in use when enabled: ${WEIGHTS_VERSION}`);
      return 0;
    }
    const urls = knownReportUrls(h.db, flagLimit(args, 50));
    if (!urls.length) {
      out.log('No report URLs known yet — run "ingest" first.');
      return 0;
    }
    const results = scoreReports(h.db, urls, { windowDays: flagDays(args, 90) });
    out.log(formatScoreTable(results));
    if (!enabled('SCORING_INFLUENCES_ORDER') || FLAGS.SHADOW_MODE) {
      out.log('');
      out.log('These scores are OBSERVED ONLY — posting order is unchanged.');
    }
    return 0;
  } finally {
    release(h);
  }
}

async function cmdPlatforms(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('PLATFORM REPORT — which platforms actually work'));
    out.log('');
    if (!enabled('PLATFORM_INTELLIGENCE')) {
      out.log('FEATURE_PLATFORM_INTELLIGENCE (or FEATURE_INTELLIGENCE) is off — nothing computed.');
      return 0;
    }
    const verdicts = analysePlatforms({ db: h.db, windowDays: flagDays(args, 90) });
    out.log(formatPlatformReport(verdicts));
    return 0;
  } finally {
    release(h);
  }
}

/**
 * match <reportUrl> — "which platform should THIS report go on?"
 *
 * The narrower question platforms/cmdPlatforms doesn't answer: that command
 * says whether a platform is worth posting to AT ALL; this ranks every
 * platform for ONE specific report, direct evidence first, falling back to
 * the platform's general track record. Feeds scoring.ts's platformSuitability
 * signal; this command is the human-readable form of the same computation.
 */
async function cmdMatch(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('PLATFORM MATCH — which platform this report should go on'));
    out.log('');
    if (!enabled('PLATFORM_INTELLIGENCE')) {
      out.log('FEATURE_PLATFORM_INTELLIGENCE (or FEATURE_INTELLIGENCE) is off — nothing computed.');
      return 0;
    }
    const reportUrl = args.positionals[0];
    if (!reportUrl) {
      out.error('A report URL is required: intel match <reportUrl>');
      return 1;
    }
    const stats = computePlatformStats({ db: h.db, windowDays: flagDays(args, 90) });
    const result = matchPlatformsForReport(h.db, reportUrl, stats);
    out.log(formatPlatformMatchReport(result));
    return 0;
  } finally {
    release(h);
  }
}

async function cmdContent(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('CONTENT CORRELATION REPORT'));
    out.log('');
    if (!enabled('CONTENT_INTELLIGENCE')) {
      out.log('FEATURE_CONTENT_INTELLIGENCE (or FEATURE_INTELLIGENCE) is off — nothing computed.');
      return 0;
    }
    out.log(formatContentReport(analyseContent(h.db, flagLimit(args, 10))));
    return 0;
  } finally {
    release(h);
  }
}

// ── Interlinking ─────────────────────────────────────────────────────────────

async function cmdPropose(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('INTERLINK PROPOSALS', [
      'Proposals are written to the local database only. Nothing is published.',
      '',
    ]));
    if (!enabled('INTERLINKING_PROPOSALS')) {
      out.log('FEATURE_INTERLINKING_PROPOSALS (or FEATURE_INTELLIGENCE) is off — nothing proposed.');
      return 0;
    }
    const limits = loadInterlinkLimits();
    out.log(`Limits: max ${limits.maxNewLinksPerSourcePage}/page, ${limits.maxLinksAddedPerRun}/run, ` +
            `min relevance ${limits.minRelevanceToPropose}, cooldown ${limits.cooldownHours}h.`);
    out.log(`Editable platforms: ${editablePlatforms().map(p => p.key).join(', ') || '(none)'}`);
    out.log('');

    const mod = await optionalModule('./interlink/propose.js');
    if (!mod || typeof mod.generateProposals !== 'function') {
      out.log(NOT_INSTALLED('The interlink proposal generator', 'src/intelligence/interlink/propose.ts'));
      out.log('');
      out.log(formatProposals(proposalsByStatus(h.db, 'proposed'), 'No existing proposals in the database.'));
      return 0;
    }

    const res = await mod.generateProposals({
      db: h.db,
      limit: flagLimit(args, limits.maxLinksAddedPerRun),
      fetchSourceText: await buildSourceTextFetcher(out),
    });
    out.log(typeof mod.formatProposalRun === 'function'
      ? mod.formatProposalRun(res)
      : `Generated ${res?.created ?? 0} new proposal(s).`);
    out.log('');
    out.log(formatProposals(proposalsByStatus(h.db, 'proposed'), 'No proposals are waiting.'));
    return 0;
  } finally {
    release(h);
  }
}

/**
 * Supplies a source page's current body to the proposer.
 *
 * READ-ONLY: it fetches an already-published post through the same adapter
 * that would later edit it, so a platform with no adapter (or no API key)
 * simply yields null and that source is skipped. The proposer itself never
 * performs network I/O — that is why this is injected.
 */
async function buildSourceTextFetcher(out: Out): Promise<(s: any) => Promise<string | null>> {
  const adapters = await optionalModule('./interlink/adapters.js');
  if (!adapters || typeof adapters.defaultAdapters !== 'function') {
    out.log('No platform edit adapters available — no source page bodies can be read.');
    return async () => null;
  }
  return async (source: any): Promise<string | null> => {
    try {
      const adapter = adapters.defaultAdapters(source?.platform);
      if (!adapter || !adapter.canEdit) return null;
      const id = adapter.idFromUrl(String(source?.sourceUrl ?? ''));
      if (!id) return null;
      return await adapter.fetchContent(id);
    } catch {
      return null; // an unreadable source is a skipped source, never a crash
    }
  };
}

async function cmdQueue(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('PROPOSALS AWAITING HUMAN APPROVAL'));
    out.log('');
    const rows = proposalsByStatus(h.db, 'proposed', flagLimit(args, 50));
    out.log(formatProposals(rows, 'Nothing is waiting for approval — run "propose" first.'));
    if (rows.length) {
      out.log('');
      out.log('Approve with:  npm run intel -- approve <id> --by "your name"');
      out.log('Reject with :  npm run intel -- reject <id> --reason "why"');
    }
    return 0;
  } finally {
    release(h);
  }
}

async function decide(
  args: ParsedArgs, out: Out, to: 'approved' | 'rejected',
): Promise<number> {
  const idRaw = args.positionals[0];
  const id = Number(idRaw);
  if (!idRaw || !Number.isInteger(id) || id <= 0) {
    out.error(`A proposal id is required: intel ${to === 'approved' ? 'approve' : 'reject'} <id>`);
    return 1;
  }
  const h = openHandle(args);
  try {
    const row = h.db.prepare('SELECT id, status, source_url FROM interlink_proposals WHERE id = ?').get(id) as any;
    if (!row) { out.error(`No proposal #${id}. Run "queue" to see what exists.`); return 1; }
    if (row.status !== 'proposed') {
      out.error(`Proposal #${id} is "${row.status}", not "proposed" — refusing to change it.`);
      return 1;
    }
    const by = flagStr(args, 'by') ?? process.env.INTEL_OPERATOR ?? safeUsername();

    // Prefer the applier's own state machine when it is available: it owns the
    // legal status transitions. Fall back to a direct, equally strict update.
    const mod = await optionalModule('./interlink/apply.js');
    const fn = to === 'approved' ? mod?.approveProposal : mod?.rejectProposal;
    if (typeof fn === 'function') {
      fn(h.db, id, by, flagStr(args, 'reason'));
    } else {
      h.db.prepare('UPDATE interlink_proposals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
        .run(to, nowIso(), by, id);
    }
    out.log(`Proposal #${id} ${to} by ${by}.`);
    if (to === 'approved') {
      out.log('Nothing is published yet. Run "apply" (dry run) and then "apply --apply".');
    }
    return 0;
  } finally {
    release(h);
  }
}

function safeUsername(): string {
  try { return os.userInfo().username || 'unknown'; } catch { return 'unknown'; }
}

async function cmdApply(args: ParsedArgs, out: Out): Promise<number> {
  const live = flagBool(args, 'apply');
  const h = openHandle(args);
  try {
    out.log(live ? LIVE_WARNING : DRY_RUN_BANNER);

    const approved = proposalsByStatus(h.db, 'approved', flagLimit(args, 50));
    if (!approved.length) {
      out.log('No approved proposals. Run "queue" and approve something first.');
      return 0;
    }
    out.log(formatProposals(approved, ''));

    if (!live) {
      out.log('');
      const dry = await optionalModule('./interlink/apply.js');
      if (dry && typeof dry.applyApproved === 'function') {
        const res = await dry.applyApproved({ db: h.db, dryRun: true });
        out.log(typeof dry.formatApplySummary === 'function'
          ? dry.formatApplySummary(res)
          : JSON.stringify(res));
      }
      out.log('');
      out.log(`DRY RUN: ${approved.length} approved proposal(s) considered. Nothing was changed.`);
      out.log('Re-run with --apply to edit the real posts.');
      return 0;
    }

    if (!mayMutateExternally('INTERLINKING_APPLY')) {
      out.error('');
      out.error('Refusing to apply: FEATURE_INTERLINKING_APPLY is off, FEATURE_INTELLIGENCE is off,');
      out.error('or FEATURE_SHADOW_MODE is on. Nothing was changed.');
      return 1;
    }

    const mod = await optionalModule('./interlink/apply.js');
    if (!mod || typeof mod.applyApproved !== 'function') {
      out.error(NOT_INSTALLED('The interlink applier', 'src/intelligence/interlink/apply.ts'));
      return 1;
    }
    const res = await mod.applyApproved({ db: h.db, dryRun: false });
    out.log(typeof mod.formatApplySummary === 'function'
      ? mod.formatApplySummary(res)
      : `Applied ${res?.applied ?? 0}, failed ${res?.failed ?? 0}.`);
    // The cap the applier ACTUALLY enforced, not the compiled-in default —
    // an operator who configured INTERLINK_LIMITS_JSON was being told the
    // wrong number by the only line that reports it.
    const effectiveCap = loadInterlinkLimits().maxLinksAddedPerRun;
    out.log(`Per-run cap: ${effectiveCap} link(s)` +
      (effectiveCap === DEFAULT_INTERLINK_LIMITS.maxLinksAddedPerRun ? '.' : ' (configured).'));
    return (res?.failed ?? 0) > 0 ? 1 : 0;
  } finally {
    release(h);
  }
}

async function cmdCalibrate(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('CALIBRATION', [
      'Compares what the scorer predicted against what actually happened.',
      'Weights are never changed without an explicit --apply.',
      '',
    ]));
    out.log(`Current weights: ${WEIGHTS_VERSION}`);
    out.log(`  ${JSON.stringify(loadWeights())}`);
    out.log(`Minimum sample before any change: ${DEFAULT_THRESHOLDS.calibrationMinimumSample}`);
    out.log('');

    const mod = await optionalModule('./calibration.js');
    if (!mod || typeof mod.runCalibration !== 'function') {
      out.log(NOT_INSTALLED('The calibration module', 'src/intelligence/calibration.ts'));
      out.log('');
      out.log(formatCalibrationHistory(h.db));
      return 0;
    }
    const res = mod.runCalibration(h.db, { windowDays: flagDays(args, 30) });
    if (!res) {
      out.log('FEATURE_OPPORTUNITY_SCORING (or FEATURE_INTELLIGENCE) is off — nothing to calibrate.');
      out.log('');
      out.log(formatCalibrationHistory(h.db));
      return 0;
    }
    out.log(typeof mod.formatCalibrationReport === 'function'
      ? mod.formatCalibrationReport(res)
      : JSON.stringify(res, null, 2));
    out.log('');
    out.log('A proposed weight set is never adopted automatically. Set SCORING_WEIGHTS_JSON');
    out.log('deliberately, after reading the sample size above.');
    return 0;
  } finally {
    release(h);
  }
}

export function formatCalibrationHistory(db: DB, limit = 5): string {
  const rows = db.prepare(
    'SELECT run_at, sample_size, applied, notes FROM calibration_runs ORDER BY id DESC LIMIT ?',
  ).all(limit) as any[];
  if (!rows.length) return 'No calibration has ever run — there is nothing to compare against yet.';
  return rows
    .map(r => `  ${r.run_at}  n=${r.sample_size}  ${r.applied ? 'APPLIED' : 'observed only'}  ${r.notes ?? ''}`)
    .join('\n');
}


async function cmdExport(args: ParsedArgs, out: Out): Promise<number> {
  const h = openHandle(args);
  try {
    const { exportToSheet, formatExportResult, EXPORT_TABS } = await import('./sheetExport.js');
    const dryRun = flagBool(args, 'dry-run');

    out.log(banner('EXPORT — write a dated snapshot into the spreadsheet', [
      'Results are appended to Test_ tabs so they can be tracked from the sheet:',
      ...Object.values(EXPORT_TABS).map(t => `  ${t}`),
      '',
      'Snapshots APPEND rather than overwrite, so repeated exports show the',
      'difference over time. The tab lock permits these tabs because they are',
      'Test_-prefixed; the live tabs cannot be written by this or anything else.',
      '',
    ]));

    const result = await exportToSheet({ db: h.db, dryRun, log: m => out.log(m) });
    out.log('');
    out.log(formatExportResult(result));
    return 0;
  } catch (err: any) {
    out.error(`Export failed: ${err?.message ?? err}`);
    return 1;
  } finally {
    release(h);
  }
}

/**
 * dashboard — the same facts every other command prints, rendered as one
 * static HTML page instead of terminal text. Built for someone who wants to
 * glance at a browser tab rather than run commands: no credentials are read
 * beyond what `status` already reads, nothing here can approve or apply
 * anything, and it refreshes by being re-run (by hand, or on a schedule —
 * see docs/MANAGER-DASHBOARD.md).
 */
async function cmdDashboard(args: ParsedArgs, out: Out, env: NodeJS.ProcessEnv): Promise<number> {
  const h = openHandle(args);
  try {
    out.log(banner('DASHBOARD — building a static page from local data', [
      'Reads the local database only. No published content is touched.',
      '',
    ]));
    const outFile = path.resolve(flagStr(args, 'out') ?? path.join('dashboard', 'latest.html'));
    const inboxDir = flagStr(args, 'inbox') ? path.resolve(flagStr(args, 'inbox')!) : undefined;
    const data = buildDashboardData({
      db: h.db,
      windowDays: flagDays(args, 90),
      reportLimit: flagLimit(args, 25),
      ...(inboxDir ? { inboxDir } : {}),
      ...(flagStr(args, 'domain') ? { domain: flagStr(args, 'domain') } : {}),
      env,
    });
    writeDashboard(data, outFile);
    out.log(`Wrote ${outFile}`);
    out.log(`Inbox: ${data.inbox.imported} imported, ${data.inbox.skipped} skipped.`);
    out.log('Open that file in a browser to view it.');
    return 0;
  } finally {
    release(h);
  }
}

async function cmdReport(args: ParsedArgs, out: Out, env: NodeJS.ProcessEnv): Promise<number> {
  await cmdStatus(args, out, env);
  out.log('');
  await cmdPlatforms(args, out);
  out.log('');
  await cmdContent(args, out);
  out.log('');
  await cmdScore(args, out);
  out.log('');
  await cmdQueue(args, out);
  out.log('');
  out.log('End of report. Nothing above changed anything.');
  return 0;
}

// ── Help ─────────────────────────────────────────────────────────────────────

export const COMMANDS = [
  ['status', 'Flags, database, schema version, row counts, and MISSING credentials'],
  ['migrate', 'Apply pending database migrations'],
  ['collect', 'Run the collectors that have credentials; say why the others were skipped'],
  ['import-v02-indexation', 'Reuse the V0.2 project Google URL Inspection verdicts for tracked reports (read-only, no quota)'],
  ['import-performance', 'Load a GA4/GSC CSV export you downloaded yourself — no credentials needed'],
  ['ingest', 'Read the distribution sheet (--live reads the REAL tabs read-only)'],
  ['export', 'Append a dated snapshot into the Test_ tracking tabs in the sheet'],
  ['index-check', 'Check whether recent published posts are visible in search'],
  ['score', 'Score report URLs and explain every score'],
  ['platforms', 'Which of the platforms actually work'],
  ['match <reportUrl>', 'Which platform THIS report should go on, ranked, direct evidence first'],
  ['content', 'Which content characteristics correlate with outcomes'],
  ['propose', 'Generate interlink proposals (local only, never published)'],
  ['queue', 'List proposals awaiting human approval'],
  ['approve <id>', 'Approve one proposal, recording who approved it'],
  ['reject <id>', 'Reject one proposal'],
  ['apply', 'Apply approved proposals. DRY RUN unless --apply is given'],
  ['calibrate', 'Compare predictions against outcomes'],
  ['report', 'Everything known, in one readable page'],
  ['dashboard', 'Everything known, as a static HTML page (--out <path>)'],
  ['help', 'This text'],
] as const;

export function formatHelp(): string {
  const w = Math.max(...COMMANDS.map(c => c[0].length));
  return [
    'Ken Research distribution intelligence',
    '',
    'Usage: npm run intel -- <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map(([name, desc]) => `  ${name.padEnd(w)}  ${desc}`),
    '',
    'Options:',
    '  --db <path>     Use a specific database file (default: data/intelligence.db)',
    '  --days <n>      Window size for collection / scoring',
    '  --limit <n>     Maximum rows to process or print; for "index-check" this is',
    '                  the daily SERP call budget (default 100, or env',
    '                  INDEX_CHECK_DAILY_BUDGET): 70% newest posts, 30% oldest-',
    '                  checked backlog rotation',
    '  --tab <names>   Comma-separated sheet tabs for "ingest"',
    '  --by <name>     Who is approving/rejecting',
    '  --apply         Make real changes. Without it, "apply" is a dry run',
    '  --force         Run ingest even when FEATURE_INTELLIGENCE is off',
    '  --out <path>    Where "dashboard" writes its HTML (default: dashboard/latest.html)',
    '  --inbox <path>  Folder "dashboard" scans for dropped GA4/GSC CSVs',
    '',
    'Every feature is off by default. "status" tells you what is missing.',
  ].join('\n');
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export interface RunOptions {
  out?: Out;
  env?: NodeJS.ProcessEnv;
  /** Overrides --db. Used by tests so they never touch the real database. */
  dbFile?: string;
}

export async function runCli(argv: string[], options: RunOptions = {}): Promise<number> {
  const out = options.out ?? consoleOut;
  const env = options.env ?? process.env;
  const args = parseArgs(argv);
  if (options.dbFile) args.flags.db = options.dbFile;

  if (args.flags.help && args.command !== 'help') {
    out.log(formatHelp());
    return 0;
  }

  try {
    switch (args.command) {
      case 'status': return await cmdStatus(args, out, env);
      case 'migrate': return await cmdMigrate(args, out);
      case 'collect': return await cmdCollect(args, out, env);
      case 'import-performance': return await cmdImportPerformance(args, out);
      case 'import-v02-indexation': return await cmdImportV02Indexation(args, out);
      case 'ingest': return await cmdIngest(args, out);
      case 'index-check':
      case 'index': return await cmdIndexCheck(args, out);
      case 'score': return await cmdScore(args, out);
      case 'platforms': return await cmdPlatforms(args, out);
      case 'match': return await cmdMatch(args, out);
      case 'content': return await cmdContent(args, out);
      case 'propose': return await cmdPropose(args, out);
      case 'queue': return await cmdQueue(args, out);
      case 'approve': return decide(args, out, 'approved');
      case 'reject': return decide(args, out, 'rejected');
      case 'apply': return await cmdApply(args, out);
      case 'calibrate': return await cmdCalibrate(args, out);
      case 'export': return await cmdExport(args, out);
      case 'report': return await cmdReport(args, out, env);
      case 'dashboard': return await cmdDashboard(args, out, env);
      case 'help': out.log(formatHelp()); return 0;
      default:
        out.error(`Unknown command: ${args.command}`);
        out.error('');
        out.error(formatHelp());
        return 1;
    }
  } catch (err: any) {
    // Never let a stack trace be the whole answer, and never print a secret
    // that might have ended up inside an error message.
    out.error(`[intel] ${args.command} failed: ${redactMessage(String(err?.message ?? err))}`);
    if (process.env.INTEL_DEBUG) out.error(String(err?.stack ?? ''));
    return 1;
  }
}

/**
 * Strip anything that looks like a credential out of an error message.
 *
 * The keyword rule allows word characters BETWEEN the keyword and the
 * separator, because the real-world shape is `"private_key_id": "0123..."`,
 * not `key: 0123...`. The earlier pattern stopped at the `_` and printed the
 * value in full. `Bearer <token>` has no keyword at all and needs its own rule.
 */
export function redactMessage(msg: string): string {
  return msg
    .replace(/api_token=[^&\s]+/gi, 'api_token=***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 ***')
    // The value may not START with "-", so "bad credentials: -----BEGIN ..."
    // is left intact for the PEM rule below to swallow whole.
    .replace(
      /\b([A-Za-z0-9_]*(?:key|token|secret|password|credential)[A-Za-z0-9_]*)["'\s:=]+([A-Za-z0-9._+/][A-Za-z0-9._\-+/]{7,})/gi,
      '$1=***',
    )
    // Last: this replacement text contains the word "key", so running it
    // before the keyword rule would let that rule chew on its own output.
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[private key redacted]');
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * True only when THIS file is the process entry point.
 *
 * Compares the resolved entry against this module's own path. The earlier
 * version matched any entry file merely NAMED cli.ts/cli.js, so a second,
 * unrelated CLI anywhere in the repo would have made importing this module
 * run the whole command dispatcher and then call process.exit().
 */
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    if (!entry) return false;
    const self = path.resolve(fileURLToPath(import.meta.url));
    const strip = (p: string) => p.replace(/\.(ts|js|mts|mjs|cts|cjs)$/i, '');
    return strip(entry).toLowerCase() === strip(self).toLowerCase();
  } catch { return false; }
})();

if (invokedDirectly) {
  (async () => {
    // dotenv is already loaded at the top of this file (it must be, see note
    // there). This re-load is a no-op kept only for callers that import main()
    // directly in an environment where the top-level import was tree-shaken.
    try { (await import('dotenv')).default.config(); } catch { /* optional */ }
    const code = await runCli(process.argv.slice(2));
    closeDb();
    process.exit(code);
  })();
}
