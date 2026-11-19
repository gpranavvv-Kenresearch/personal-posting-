/**
 * sheetExport.ts — publish intelligence results back into the spreadsheet.
 *
 * WHY
 * ---
 * The analysis lives in a local SQLite file, which is useless for someone who
 * tracks this work from the spreadsheet. This module writes the results into
 * tabs alongside the distribution data, where they can be read, filtered,
 * charted and compared without touching any code.
 *
 * TRACKING THE DIFFERENCE
 * -----------------------
 * Every export APPENDS a dated snapshot rather than overwriting. That is the
 * whole point: one snapshot tells you the current state, a sequence of them
 * tells you whether anything is changing, which is the actual question.
 * Each row carries its snapshot date and the weights version that produced it,
 * so a change in the numbers can always be separated from a change in how the
 * numbers were calculated.
 *
 * SAFETY
 * ------
 * Every tab written here is prefixed `Test_`, which means the tab lock permits
 * it. The existing live tabs cannot be written, renamed or deleted — not by
 * this module and not by anything else in a development run. Writes go through
 * the GUARDED client, never the read-only exception.
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import type { DB } from './db.js';
import { nowIso, isoDate } from './db.js';
import { guardSheetsClient } from '../config/tabGuard.js';
import { MAIN_SHEET_ID } from '../config/sheetIds.js';
import { WEIGHTS_VERSION } from './weights.js';

/** All export tabs are Test_-prefixed so the tab lock permits them. */
export const EXPORT_TABS = {
  platforms: 'Test_Platform_Tracking',
  scores: 'Test_Opportunity_Scores',
  interlinks: 'Test_Interlink_Queue',
  summary: 'Test_Tracking_Summary',
} as const;

export type ExportTabKey = keyof typeof EXPORT_TABS;

export const HEADERS: Record<ExportTabKey, string[]> = {
  platforms: [
    'Snapshot Date', 'Platform', 'Posts', 'Indexed', 'Not Indexed', 'Unknown',
    'Indexation Rate', 'Sessions', 'Sessions/Post', 'Leads', 'Leads/Post',
    'Data Coverage', 'Recommendation', 'Confidence', 'Reasons',
  ],
  scores: [
    'Snapshot Date', 'Report URL', 'Score', 'Coverage', 'Recency Multiplier',
    'Top Signals', 'Missing Signals', 'Weights Version', 'Shadow',
  ],
  interlinks: [
    'Snapshot Date', 'ID', 'Status', 'Source URL', 'Source Platform',
    'Destination URL', 'Anchor Text', 'Relevance', 'Created', 'Decided By', 'Applied',
  ],
  summary: [
    'Snapshot Date', 'Metric', 'Value', 'Notes',
  ],
};

function resolveCredentials(): Record<string, unknown> {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (raw) return JSON.parse(raw);
  const file = path.join(process.cwd(), '.accounts', 'google-service-account.json');
  if (!fs.existsSync(file)) {
    throw new Error('[sheetExport] No Google service account found.');
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: resolveCredentials(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  // GUARDED on purpose: this confines every write to Test_* tabs.
  return guardSheetsClient(google.sheets({ version: 'v4', auth }));
}

function quoteTab(tab: string): string {
  return /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
}

/** Create the tab if absent and write its header row. Idempotent. */
export async function ensureTab(api: any, spreadsheetId: string, tab: string, headers: string[]): Promise<void> {
  let exists = false;
  try {
    const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title))' });
    exists = (meta.data.sheets ?? []).some((s: any) => s.properties?.title === tab);
  } catch { /* fall through and attempt creation */ }

  if (!exists) {
    // Permitted only because `tab` is Test_-prefixed; the guard refuses any
    // other name, so this can never shadow or collide with a live tab.
    await api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
  }

  const first = await api.spreadsheets.values.get({
    spreadsheetId, range: `${quoteTab(tab)}!1:1`,
  });
  const existing = (first.data.values ?? [[]])[0] ?? [];
  if (existing.length === 0) {
    await api.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteTab(tab)}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

export async function appendRows(api: any, spreadsheetId: string, tab: string, rows: (string | number)[][]): Promise<number> {
  if (!rows.length) return 0;
  await api.spreadsheets.values.append({
    spreadsheetId,
    range: `${quoteTab(tab)}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
  return rows.length;
}

// ── Row builders (pure, so they can be tested without the network) ───────────

const pct = (n: number | null) => (n === null || n === undefined ? '' : `${Math.round(n * 100)}%`);
const num = (n: number | null | undefined, dp = 2) =>
  (n === null || n === undefined ? '' : Number(n).toFixed(dp));

export function platformRows(verdicts: any[], snapshotDate: string): (string | number)[][] {
  return verdicts.map(v => {
    const s = v.stats;
    return [
      snapshotDate, v.platform, s.posts, s.postsIndexed, s.postsNotIndexed, s.postsUnknown,
      pct(s.indexationRate), s.sessions, num(s.sessionsPerPost), s.leads, num(s.leadsPerPost, 3),
      pct(s.dataCoverage), v.recommendation, v.confidence, (v.reasons ?? []).join('; '),
    ];
  });
}

export function scoreRows(scores: any[], snapshotDate: string, shadow: boolean): (string | number)[][] {
  return scores.map(r => {
    const present = (r.components ?? []).filter((c: any) => !c.missing)
      .sort((a: any, b: any) => b.contribution - a.contribution);
    const missing = (r.components ?? []).filter((c: any) => c.missing).map((c: any) => c.signal);
    return [
      snapshotDate, r.reportUrl, num(r.score, 4), pct(r.coverage),
      num(r.recencyMultiplier), present.slice(0, 3).map((c: any) => `${c.signal}=${num(c.raw)}`).join(', '),
      missing.join(', '), r.weightsVersion ?? WEIGHTS_VERSION, shadow ? 'YES' : 'no',
    ];
  });
}

export function interlinkRows(proposals: any[], snapshotDate: string): (string | number)[][] {
  return proposals.map(p => [
    snapshotDate, p.id, p.status, p.source_url, p.source_platform ?? '',
    p.destination_url, p.anchor_text, num(p.relevance),
    p.created_at ?? '', p.decided_by ?? '', p.applied_at ?? '',
  ]);
}

export function summaryRows(db: DB, snapshotDate: string): (string | number)[][] {
  const count = (sql: string, ...args: any[]) =>
    Number((db.prepare(sql).get(...args) as any)?.c ?? 0);

  const rows: (string | number)[][] = [
    ['Published posts tracked', count('SELECT COUNT(*) c FROM published_posts'), 'rows in published_posts'],
    ['Report URLs mapped', count('SELECT COUNT(DISTINCT report_url) c FROM url_mapping'), 'distinct reports with a known post'],
    ['Indexation checks', count('SELECT COUNT(*) c FROM indexation_checks'), 'evidence records, not proof'],
    ['  of which indexed', count("SELECT COUNT(*) c FROM indexation_checks WHERE status='indexed'"), ''],
    ['  of which unknown', count("SELECT COUNT(*) c FROM indexation_checks WHERE status='unknown'"), 'provider failures, excluded from rates'],
    ['Performance rows (GSC)', count("SELECT COUNT(*) c FROM url_performance WHERE source='gsc'"), 'needs Search Console access'],
    ['Performance rows (GA4)', count("SELECT COUNT(*) c FROM url_performance WHERE source='ga4'"), 'needs GA4 access'],
    ['Leads recorded', count('SELECT COUNT(*) c FROM leads'), 'needs Pipedrive access'],
    ['Opportunity scores', count('SELECT COUNT(*) c FROM opportunity_scores'), ''],
    ['Interlink proposals', count('SELECT COUNT(*) c FROM interlink_proposals'), ''],
    ['  awaiting approval', count("SELECT COUNT(*) c FROM interlink_proposals WHERE status='proposed'"), 'nothing applies without a human'],
    ['  applied', count("SELECT COUNT(*) c FROM interlink_proposals WHERE status='applied'"), ''],
    ['Weights version', WEIGHTS_VERSION, 'uncalibrated until calibration says otherwise'],
  ];
  return rows.map(r => [snapshotDate, r[0], r[1], r[2]]);
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface ExportOptions {
  db: DB;
  spreadsheetId?: string;
  snapshotDate?: string;
  /** Preview without writing. Default false — export is a safe, additive write. */
  dryRun?: boolean;
  log?: (m: string) => void;
}

export interface ExportResult {
  snapshotDate: string;
  written: Record<string, number>;
  skipped: string[];
  dryRun: boolean;
}

/**
 * Write a dated snapshot of everything known into the Test_ tracking tabs.
 *
 * Appends; never overwrites. Re-running on the same day adds a second snapshot
 * for that date, which is visible rather than silently merged.
 */
export async function exportToSheet(opts: ExportOptions): Promise<ExportResult> {
  const { db } = opts;
  const spreadsheetId = opts.spreadsheetId ?? MAIN_SHEET_ID;
  const snapshotDate = opts.snapshotDate ?? isoDate();
  const log = opts.log ?? ((m: string) => console.log(m));
  const dryRun = opts.dryRun === true;

  const written: Record<string, number> = {};
  const skipped: string[] = [];

  const { analysePlatforms, computePlatformStats, recommend } = await import('./platformIntelligence.js');
  let verdicts: any[] = analysePlatforms({ db });
  if (!verdicts.length) {
    // Platform intelligence may be flag-gated off; the snapshot is still useful.
    verdicts = computePlatformStats({ db }).map(s => recommend(s));
  }
  const pRows = platformRows(verdicts.filter(v => v.stats.posts > 0), snapshotDate);
  if (!pRows.length) skipped.push('platforms (no posts tracked yet)');

  const scoreRowsRaw = db.prepare(
    `SELECT report_url, score, components, weights_version, shadow
       FROM opportunity_scores WHERE scored_at >= ? ORDER BY score DESC LIMIT 500`
  ).all(`${snapshotDate}T00:00:00.000Z`) as any[];
  const sRows = scoreRows(
    scoreRowsRaw.map(r => {
      let parsed: any = {};
      try { parsed = JSON.parse(String(r.components ?? '{}')); } catch { /* keep empty */ }
      return {
        reportUrl: r.report_url, score: r.score,
        coverage: parsed.coverage ?? null,
        recencyMultiplier: parsed.recencyMultiplier ?? null,
        components: parsed.components ?? [],
        weightsVersion: r.weights_version,
      };
    }),
    snapshotDate,
    scoreRowsRaw.some(r => Number(r.shadow) === 1),
  );
  if (!sRows.length) skipped.push('scores (none computed today)');

  const proposals = db.prepare(
    `SELECT id, status, source_url, source_platform, destination_url, anchor_text,
            relevance, created_at, decided_by, applied_at
       FROM interlink_proposals ORDER BY id DESC LIMIT 500`
  ).all() as any[];
  const iRows = interlinkRows(proposals, snapshotDate);
  if (!iRows.length) skipped.push('interlinks (no proposals yet)');

  const sumRows = summaryRows(db, snapshotDate);

  if (dryRun) {
    log(`[export] DRY RUN — would write ${pRows.length} platform, ${sRows.length} score, ` +
        `${iRows.length} interlink and ${sumRows.length} summary rows.`);
    return { snapshotDate, written: {}, skipped, dryRun: true };
  }

  const api = await sheetsClient();

  const jobs: Array<[ExportTabKey, (string | number)[][]]> = [
    ['platforms', pRows], ['scores', sRows], ['interlinks', iRows], ['summary', sumRows],
  ];

  for (const [key, rows] of jobs) {
    if (!rows.length) continue;
    const tab = EXPORT_TABS[key];
    await ensureTab(api, spreadsheetId, tab, HEADERS[key]);
    written[tab] = await appendRows(api, spreadsheetId, tab, rows);
    log(`   wrote ${written[tab]} row(s) to ${tab}`);
  }

  return { snapshotDate, written, skipped, dryRun: false };
}

export function formatExportResult(r: ExportResult): string {
  const lines: string[] = [];
  lines.push(`Snapshot ${r.snapshotDate}${r.dryRun ? ' (DRY RUN — nothing written)' : ''}`);
  const total = Object.values(r.written).reduce((a, b) => a + b, 0);
  if (total) {
    for (const [tab, n] of Object.entries(r.written)) lines.push(`  ${tab}: ${n} rows`);
  } else if (!r.dryRun) {
    lines.push('  nothing written — no data to export yet');
  }
  for (const s of r.skipped) lines.push(`  skipped: ${s}`);
  lines.push('');
  lines.push('Snapshots APPEND, so repeated exports let you compare dates and see the difference.');
  return lines.join('\n');
}
