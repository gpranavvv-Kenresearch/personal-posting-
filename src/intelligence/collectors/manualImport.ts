/**
 * manualImport.ts — bring your own GA4 / Search Console export.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The live-API collectors in this folder (ga4.ts, gsc.ts) need our service
 * account added to the GA4 property and the Search Console property. That
 * access is deliberately staying with one person and is not being handed to
 * this automation. This file is the alternative: the person who DOES have
 * GA4/GSC access logs into the Google UI themselves, exports a CSV of
 * whatever report they're looking at, and this file reads that CSV into the
 * exact same `url_performance` table the live collectors would have written
 * to. Every downstream consumer (scoring.ts, platformIntelligence.ts,
 * interlink/propose.ts) reads that table and cannot tell the difference.
 *
 * No network call. No credentials. No scope decision to make — the file on
 * disk is the only input.
 *
 * SUPPORTED EXPORTS
 * ─────────────────────────────────────────────────────────────────────────────
 *   - GA4 "Pages and screens" / "Landing page" exploration export:
 *     expects a page/URL column plus any of Sessions, Users (Active users),
 *     Engaged sessions.
 *   - Search Console "Pages" performance export:
 *     expects a page/URL column plus any of Clicks, Impressions, CTR,
 *     Position (Average position).
 *
 * Column names are matched case-insensitively against a list of aliases per
 * field (see HEADER_ALIASES) because GA4 and GSC both rename these columns
 * between report types and over time. A column that matches nothing is
 * ignored, not an error — a report with only Clicks/Impressions is a valid
 * GSC export even with no Position column.
 *
 * The export itself carries no reliable per-row date (GA4/GSC UI exports
 * report one aggregate number per URL for whatever date range was selected
 * on screen), so the caller supplies --date once for the whole file. Running
 * the same file twice with the same --date UPDATES the row rather than
 * duplicating it (the underlying UNIQUE constraint on url_performance).
 */

import fs from 'node:fs';
import { tx, nowIso, type DB } from '../db.js';

export type ManualImportSource = 'ga4-manual' | 'gsc-manual';

export interface ManualImportRow {
  url: string;
  source: ManualImportSource;
  metric_date: string;
  metric_scope: 'url';
  dimension_value: string; // always '' at url scope — see idempotency note in gsc.ts
  clicks: number | null;
  impressions: number | null;
  position: number | null;
  ctr: number | null;
  sessions: number | null;
  users: number | null;
  engaged_sessions: number | null;
}

export interface ManualImportResult {
  rowsParsed: number;
  rowsSkipped: number;
  rowsWritten: number;
  skippedReasons: string[];
  matchedColumns: Record<string, string>; // field -> actual header text found
}

const URL_ALIASES = ['page path and screen class', 'page path', 'landing page', 'page', 'url', 'top pages'];
const HEADER_ALIASES: Record<string, string[]> = {
  clicks: ['clicks'],
  impressions: ['impressions'],
  ctr: ['ctr'],
  position: ['position', 'average position'],
  sessions: ['sessions'],
  users: ['users', 'active users'],
  engaged_sessions: ['engaged sessions'],
};

/**
 * Minimal CSV line parser: handles quoted fields (with embedded commas and
 * doubled "" escapes), which both GA4 and GSC exports use for any value
 * containing a comma. Deliberately not a streaming/RFC4180-complete parser —
 * this reads one export at a time, a few thousand rows at most.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Normalise line endings up front so \r\n and \r alone both work.
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += c;
  }
  // Trailing field/row (file may or may not end with a newline).
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function findColumn(headers: string[], aliases: string[]): number {
  const lower = headers.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw.trim().replace(/[,%]/g, '').replace(/^\$/, '');
  if (cleaned === '' || cleaned === '-' || cleaned.toLowerCase() === 'n/a') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * GA4/GSC exports sometimes export the bare path ("/industry-reports/foo")
 * rather than a full URL. We need the full kenresearch.com URL to join
 * against published_posts / interlink proposals. A bare path is prefixed;
 * anything already absolute (http/https) is left exactly as exported so a
 * UTM-tagged export URL is never silently altered.
 */
export function normaliseExportUrl(raw: string, domain = 'https://www.kenresearch.com'): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!trimmed.startsWith('/')) return `${domain}/${trimmed}`;
  return `${domain}${trimmed}`;
}

export interface ParseManualExportOptions {
  source: ManualImportSource;
  metricDate: string; // YYYY-MM-DD, required: the export has no per-row date
  domain?: string;
}

export function parseManualExport(csvText: string, opts: ParseManualExportOptions): ManualImportResult {
  // GA4 exports begin with a "# ----" comment preamble (property name, report
  // name, date range) and a blank line before the real header row. Drop those
  // leading lines so the header row is what the column matcher sees.
  const stripped = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .reduce<{ lines: string[]; inPreamble: boolean }>((acc, line) => {
      if (acc.inPreamble && (line.startsWith('#') || line.trim() === '')) return acc;
      acc.inPreamble = false;
      acc.lines.push(line);
      return acc;
    }, { lines: [], inPreamble: true })
    .lines.join('\n');
  const table = parseCsv(stripped);
  const result: ManualImportResult = {
    rowsParsed: 0, rowsSkipped: 0, rowsWritten: 0, skippedReasons: [], matchedColumns: {},
  };
  if (table.length === 0) {
    result.skippedReasons.push('Empty file.');
    return { ...result, rows: [] } as any;
  }

  const headers = table[0]!;
  const urlCol = findColumn(headers, URL_ALIASES);
  if (urlCol === -1) {
    result.skippedReasons.push(
      `No recognisable URL/page column in header row: ${JSON.stringify(headers)}. ` +
      `Expected one of: ${URL_ALIASES.join(', ')}.`,
    );
    return { ...result, rows: [] } as any;
  }
  result.matchedColumns.url = headers[urlCol]!;

  const metricCols: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = findColumn(headers, aliases);
    if (idx !== -1) { metricCols[field] = idx; result.matchedColumns[field] = headers[idx]!; }
  }
  if (Object.keys(metricCols).length === 0) {
    result.skippedReasons.push(
      `URL column found ("${headers[urlCol]}") but no recognisable metric column ` +
      `(clicks/impressions/ctr/position/sessions/users/engaged sessions).`,
    );
    return { ...result, rows: [] } as any;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.metricDate)) {
    throw new Error(`metricDate must be YYYY-MM-DD, got ${JSON.stringify(opts.metricDate)}.`);
  }

  const rows: ManualImportRow[] = [];
  const seen = new Set<string>();
  for (const cells of table.slice(1)) {
    result.rowsParsed++;
    const rawUrl = cells[urlCol];
    if (!rawUrl || !rawUrl.trim()) { result.rowsSkipped++; result.skippedReasons.push('Row with empty URL/page value.'); continue; }
    const url = normaliseExportUrl(rawUrl, opts.domain);
    // GA4/GSC exports are already one-row-per-URL for the selected range;
    // a repeat is almost always a report subtotal/footer row, not real data.
    if (seen.has(url)) { result.rowsSkipped++; result.skippedReasons.push(`Duplicate URL in export, kept first occurrence: ${url}`); continue; }
    seen.add(url);

    rows.push({
      url,
      source: opts.source,
      metric_date: opts.metricDate,
      metric_scope: 'url',
      dimension_value: '',
      clicks: metricCols.clicks !== undefined ? parseNumber(cells[metricCols.clicks]) : null,
      impressions: metricCols.impressions !== undefined ? parseNumber(cells[metricCols.impressions]) : null,
      position: metricCols.position !== undefined ? parseNumber(cells[metricCols.position]) : null,
      ctr: metricCols.ctr !== undefined ? parseNumber(cells[metricCols.ctr]) : null,
      sessions: metricCols.sessions !== undefined ? parseNumber(cells[metricCols.sessions]) : null,
      users: metricCols.users !== undefined ? parseNumber(cells[metricCols.users]) : null,
      engaged_sessions: metricCols.engaged_sessions !== undefined ? parseNumber(cells[metricCols.engaged_sessions]) : null,
    });
  }

  return { ...result, rows } as ManualImportResult & { rows: ManualImportRow[] };
}

const UPSERT_SQL = `
  INSERT INTO url_performance
    (url, source, metric_date, metric_scope, dimension_value,
     clicks, impressions, position, ctr, sessions, users, engaged_sessions, collected_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(url, source, metric_date, metric_scope, dimension_value) DO UPDATE SET
    clicks = excluded.clicks,
    impressions = excluded.impressions,
    position = excluded.position,
    ctr = excluded.ctr,
    sessions = excluded.sessions,
    users = excluded.users,
    engaged_sessions = excluded.engaged_sessions,
    collected_at = excluded.collected_at
`;

/** Idempotent write, same pattern as upsertUrlPerformance/upsertPerformanceRows. */
export function writeManualImportRows(db: DB, rows: ManualImportRow[], collectedAt = nowIso()): number {
  if (!rows.length) return 0;
  return tx(db, () => {
    const stmt = db.prepare(UPSERT_SQL);
    let n = 0;
    for (const r of rows) {
      stmt.run(
        r.url, r.source, r.metric_date, r.metric_scope, r.dimension_value,
        r.clicks, r.impressions, r.position, r.ctr, r.sessions, r.users, r.engaged_sessions,
        collectedAt,
      );
      n++;
    }
    return n;
  });
}

/** One-call convenience: read the file, parse it, write it, return a summary. */
export function importManualExportFile(db: DB, filePath: string, opts: ParseManualExportOptions): ManualImportResult {
  const text = fs.readFileSync(filePath, 'utf8');
  const parsed = parseManualExport(text, opts) as ManualImportResult & { rows: ManualImportRow[] };
  const rowsWritten = writeManualImportRows(db, parsed.rows);
  return { ...parsed, rowsWritten };
}
