/**
 * ga4.ts — Google Analytics 4 collector.
 *
 * PURPOSE
 *   Answer two questions with real numbers instead of guesses:
 *     1. Which kenresearch.com landing pages actually receive traffic?
 *        → report (a): landingPagePlusQueryString × date
 *     2. Which of the 34 distribution platforms sends that traffic?
 *        → report (b): sessionSource × sessionCampaign × date
 *        This works because src/utils/utm.ts already tags every outbound link
 *        with utm_source=<platform>&utm_campaign=automation, and GA4 maps
 *        utm_source → sessionSource, utm_campaign → sessionCampaign.
 *
 *   Both shapes land in url_performance with source='ga4'.
 *
 * STORAGE CONVENTION (url_performance has UNIQUE(url, source, metric_date,
 * metric_scope, dimension_value); SQLite treats NULL as distinct from NULL, so
 * dimension_value is NEVER null here — '' is used instead, which keeps
 * ON CONFLICT ... DO UPDATE genuinely idempotent):
 *
 *   landing-page rows : metric_scope='url'
 *                       url             = the landing page path+query
 *                       dimension_value = ''
 *   platform rows     : metric_scope='utm_source'
 *                       url             = PROPERTY_SCOPE_URL sentinel
 *                       dimension_value = '<sessionSource>|<sessionCampaign>'
 *
 * CREDENTIALS — what a human must grant (nothing here works until they do):
 *   1. Service account: the SAME one the sheets integration already uses —
 *      the client_email inside .accounts/google-service-account.json (or the
 *      GOOGLE_SERVICE_ACCOUNT_JSON env var). Run `npm run ga4:whoami`-style
 *      inspection locally; never paste the key anywhere.
 *   2. In Google Cloud for that service account's project: enable the
 *      "Google Analytics Data API" (analyticsdata.googleapis.com).
 *   3. In GA4 Admin → Property Access Management for the kenresearch.com
 *      property: add that client_email with the role **Viewer** (read-only;
 *      Analyst/Editor are NOT required and should not be granted).
 *   4. Set env GA4_PROPERTY_ID to the numeric property id, either as
 *      '123456789' or 'properties/123456789' (Admin → Property Settings).
 *   5. Enable the feature: FEATURE_INTELLIGENCE=1 and FEATURE_GA4_COLLECTION=1.
 *
 * DEGRADATION — no credential, no crash:
 *   - flag off            → immediate no-op, nothing written, no run recorded.
 *   - GA4_PROPERTY_ID unset / malformed → 'failed' run with a clear message.
 *   - service account missing / API disabled / 403 from GA4 → 'failed' run.
 *   - one of the two reports fails after the other succeeded → 'partial' run,
 *     the good rows are kept. A batch is never lost to a single bad report.
 */

import { google } from 'googleapis';
import {
  type DB,
  tx,
  nowIso,
  isoDate,
  daysAgo,
  startRun,
  finishRun,
} from '../db.js';
import { enabled } from '../flags.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** A url_performance-shaped row produced by this collector. */
export interface PerformanceRow {
  url: string;
  source: 'ga4';
  metric_date: string;        // YYYY-MM-DD
  metric_scope: 'url' | 'utm_source';
  dimension_value: string;    // '' for landing-page scope, never null
  sessions: number;
  users: number;
  engaged_sessions: number;
  conversions: number;
}

/** Minimal structural view of an analyticsdata v1beta runReport response. */
export interface Ga4Report {
  dimensionHeaders?: Array<{ name?: string | null } | null> | null;
  metricHeaders?: Array<{ name?: string | null } | null> | null;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string | null } | null> | null;
    metricValues?: Array<{ value?: string | null } | null> | null;
  } | null> | null;
  rowCount?: number | null;
}

export interface CollectGa4Options {
  db: DB;
  /** YYYY-MM-DD, inclusive. Defaults to 7 days ago. */
  startDate?: string;
  /** YYYY-MM-DD, inclusive. Defaults to today (UTC). */
  endDate?: string;
  /** Test/DI seam: anything with runReport({ property, requestBody }). */
  client?: Ga4Client;
  /** Rows requested per page. GA4 caps at 250000. */
  pageSize?: number;
}

export interface Ga4Client {
  properties: {
    runReport(args: { property: string; requestBody: any }): Promise<{ data: Ga4Report }>;
  };
}

export interface CollectGa4Result {
  status: 'skipped' | 'ok' | 'partial' | 'failed';
  rowsWritten: number;
  landingPageRows: number;
  sourceRows: number;
  errors: string[];
  runId?: number;
}

/** Sentinel url for property-wide (non-page) rows. */
export const PROPERTY_SCOPE_URL = '(property)';

/** Dimension values GA4 emits that cannot be attributed to a real page. */
const UNUSABLE_PAGE_VALUES = new Set(['(not set)', '(other)', '', '(none)']);

const MAX_PAGES = 100; // hard stop; 100 × pageSize rows is far beyond any real day

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** GA4 returns dates as YYYYMMDD. Convert to YYYY-MM-DD; '' when unparseable. */
export function parseGa4Date(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;          // already normalised
  if (!/^\d{8}$/.test(v)) return '';                     // '(other)', 'YYYYMM', junk
  const y = v.slice(0, 4), m = v.slice(4, 6), d = v.slice(6, 8);
  const mi = Number(m), di = Number(d);
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return '';
  return `${y}-${m}-${d}`;
}

/** GA4 metric values are strings and may be absent, empty or fractional. */
export function parseMetric(raw: string | null | undefined): number {
  const v = (raw ?? '').trim();
  if (!v) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** Normalise 'properties/123' | '123' → 'properties/123'. null when invalid. */
export function normalisePropertyId(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const m = /^(?:properties\/)?(\d+)$/.exec(v);
  return m ? `properties/${m[1]}` : null;
}

/** Index a report's dimension/metric headers by name → column position. */
function headerIndex(headers: Array<{ name?: string | null } | null> | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  (headers ?? []).forEach((h, i) => {
    const name = h?.name?.trim();
    if (name && !out.has(name)) out.set(name, i);
  });
  return out;
}

function cell(values: Array<{ value?: string | null } | null> | null | undefined, idx: number | undefined): string {
  if (idx === undefined || idx < 0) return '';
  return (values?.[idx]?.value ?? '') as string;
}

function metricsOf(
  mIdx: Map<string, number>,
  values: Array<{ value?: string | null } | null> | null | undefined,
) {
  // GA4 renamed `conversions` to `keyEvents`; a property may report either,
  // and a degraded run may carry neither. Read whichever header is present.
  const convIdx = mIdx.get('conversions') ?? mIdx.get('keyEvents');
  return {
    sessions: parseMetric(cell(values, mIdx.get('sessions'))),
    users: parseMetric(cell(values, mIdx.get('totalUsers'))),
    engaged_sessions: parseMetric(cell(values, mIdx.get('engagedSessions'))),
    conversions: parseMetric(cell(values, convIdx)),
  };
}

/**
 * Report (a): dimensions ['landingPagePlusQueryString','date'].
 * Rows whose landing page is unusable ('(not set)', '(other)', empty) or
 * whose date will not parse are dropped — they cannot key a url_performance
 * row and silently storing them under a bogus key is worse than losing them.
 */
export function transformLandingPageReport(resp: Ga4Report | null | undefined): PerformanceRow[] {
  const rows = resp?.rows ?? [];
  if (!rows.length) return [];

  const dIdx = headerIndex(resp?.dimensionHeaders);
  const mIdx = headerIndex(resp?.metricHeaders);
  const pageIdx = dIdx.get('landingPagePlusQueryString');
  const dateIdx = dIdx.get('date');
  // collected_at is stamped at write time, not here — this stays pure.

  const out: PerformanceRow[] = [];
  for (const row of rows) {
    if (!row) continue;
    const page = cell(row.dimensionValues, pageIdx).trim();
    if (UNUSABLE_PAGE_VALUES.has(page)) continue;
    const metric_date = parseGa4Date(cell(row.dimensionValues, dateIdx));
    if (!metric_date) continue;

    out.push({
      url: page,
      source: 'ga4',
      metric_date,
      metric_scope: 'url',
      dimension_value: '',
      ...metricsOf(mIdx, row.metricValues),
    });
  }
  return out;
}

/**
 * Report (b): dimensions ['sessionSource','sessionCampaign','date'].
 * The source value is preserved verbatim — '(direct)' and '(not set)' are
 * real, meaningful answers ("this traffic was not attributable"), unlike an
 * unusable landing page, so they are kept rather than dropped.
 */
export function transformSourceReport(resp: Ga4Report | null | undefined): PerformanceRow[] {
  const rows = resp?.rows ?? [];
  if (!rows.length) return [];

  const dIdx = headerIndex(resp?.dimensionHeaders);
  const mIdx = headerIndex(resp?.metricHeaders);
  const srcIdx = dIdx.get('sessionSource');
  const campIdx = dIdx.get('sessionCampaign');
  const dateIdx = dIdx.get('date');

  const out: PerformanceRow[] = [];
  for (const row of rows) {
    if (!row) continue;
    const metric_date = parseGa4Date(cell(row.dimensionValues, dateIdx));
    if (!metric_date) continue;

    const src = (cell(row.dimensionValues, srcIdx).trim() || '(not set)').toLowerCase();
    const camp = (cell(row.dimensionValues, campIdx).trim() || '(not set)').toLowerCase();

    out.push({
      url: PROPERTY_SCOPE_URL,
      source: 'ga4',
      metric_date,
      metric_scope: 'utm_source',
      dimension_value: `${src}|${camp}`,
      ...metricsOf(mIdx, row.metricValues),
    });
  }
  return out;
}

/** Split a stored platform dimension_value back into its parts. */
export function parseSourceDimension(value: string): { source: string; campaign: string } {
  const i = (value ?? '').indexOf('|');
  if (i < 0) return { source: value ?? '', campaign: '' };
  return { source: value.slice(0, i), campaign: value.slice(i + 1) };
}

// ── Persistence ──────────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO url_performance
    (url, source, metric_date, metric_scope, dimension_value,
     sessions, users, engaged_sessions, conversions, collected_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(url, source, metric_date, metric_scope, dimension_value)
  DO UPDATE SET
    sessions         = excluded.sessions,
    users            = excluded.users,
    engaged_sessions = excluded.engaged_sessions,
    conversions      = excluded.conversions,
    collected_at     = excluded.collected_at
`;

/**
 * Idempotent write. Re-running a day UPDATES the existing row rather than
 * duplicating it (natural key = the table's UNIQUE constraint).
 */
export function upsertPerformanceRows(db: DB, rows: PerformanceRow[], collectedAt = nowIso()): number {
  if (!rows.length) return 0;
  return tx(db, () => {
    const stmt = db.prepare(UPSERT_SQL);
    let n = 0;
    for (const r of rows) {
      stmt.run(
        r.url, r.source, r.metric_date, r.metric_scope, r.dimension_value,
        r.sessions, r.users, r.engaged_sessions, r.conversions, collectedAt,
      );
      n++;
    }
    return n;
  });
}

// ── Auth / client ────────────────────────────────────────────────────────────

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

/** Resolved exactly like src/sheets/sheets.ts: env var first, then the file. */
async function loadServiceAccountCredentials(): Promise<object> {
  const inline = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.');
    }
  }
  const fs = (await import('fs')).default;
  const file = '.accounts/google-service-account.json';
  if (!fs.existsSync(file)) {
    throw new Error(
      `No Google service-account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON or place ${file}.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} exists but is not valid JSON.`);
  }
}

/** Build a live analyticsdata v1beta client. Never called from tests. */
export async function getGa4Client(): Promise<Ga4Client> {
  const credentials = await loadServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [GA4_SCOPE] });
  return google.analyticsdata({ version: 'v1beta', auth }) as unknown as Ga4Client;
}

// ── Paging ───────────────────────────────────────────────────────────────────

const CORE_METRICS = ['sessions', 'totalUsers', 'engagedSessions'];

/**
 * Metric sets tried in order.
 *
 * GA4 is mid-rename: `conversions` is deprecated in favour of `keyEvents`, and
 * which of the two a property accepts depends on when it was migrated. Asking
 * for the wrong one returns 400 INVALID_ARGUMENT for the WHOLE report — which
 * would throw away sessions and users as well, over a secondary metric. So the
 * request is retried down the list, and the last entry asks for neither.
 */
export const METRIC_SETS: string[][] = [
  [...CORE_METRICS, 'conversions'],
  [...CORE_METRICS, 'keyEvents'],
  [...CORE_METRICS],
];

/** True when an error reads like "GA4 rejected a metric name", not "no access". */
export function isMetricRejection(err: any): boolean {
  const msg = String(err?.message ?? err ?? '');
  if (/permission|forbidden|unauthor|401|403|quota|exhausted/i.test(msg)) return false;
  return /metric|invalid[_ ]?argument|\b400\b|did not match|not (?:a )?valid/i.test(msg);
}

/**
 * Run one report shape to completion, following GA4's limit/offset paging
 * using the rowCount field. Returns every page's response.
 */
export async function runPagedReport(
  client: Ga4Client,
  property: string,
  dimensions: string[],
  startDate: string,
  endDate: string,
  pageSize: number,
  metrics: string[] = METRIC_SETS[0],
): Promise<Ga4Report[]> {
  const pages: Ga4Report[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await client.properties.runReport({
      property,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: dimensions.map(name => ({ name })),
        metrics: metrics.map(name => ({ name })),
        limit: String(pageSize),
        offset: String(offset),
        keepEmptyRows: false,
      },
    });

    const data = res?.data ?? {};
    pages.push(data);

    const got = (data.rows ?? []).length;
    offset += got;
    const total = Number(data.rowCount ?? 0);
    if (got === 0 || !Number.isFinite(total) || offset >= total) break;
  }

  return pages;
}

/**
 * runPagedReport, retried down METRIC_SETS when — and only when — GA4 rejects
 * a metric name. A permission or quota failure is rethrown on the first try:
 * retrying it twice more would just burn quota and muddy the error message.
 */
export async function runReportWithMetricFallback(
  client: Ga4Client,
  property: string,
  dimensions: string[],
  startDate: string,
  endDate: string,
  pageSize: number,
): Promise<Ga4Report[]> {
  let lastErr: any;
  for (let i = 0; i < METRIC_SETS.length; i++) {
    try {
      return await runPagedReport(client, property, dimensions, startDate, endDate, pageSize, METRIC_SETS[i]);
    } catch (err: any) {
      lastErr = err;
      if (!isMetricRejection(err)) throw err;
    }
  }
  throw lastErr;
}

// ── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect GA4 landing-page and platform-attribution data into url_performance.
 * Gated by FEATURE_GA4_COLLECTION (plus the master FEATURE_INTELLIGENCE).
 * Never throws: every failure path is recorded on the collection run.
 */
export async function collectGa4(opts: CollectGa4Options): Promise<CollectGa4Result> {
  const { db } = opts;

  if (!enabled('GA4_COLLECTION')) {
    return { status: 'skipped', rowsWritten: 0, landingPageRows: 0, sourceRows: 0, errors: [] };
  }

  const startDate = opts.startDate ?? daysAgo(7);
  const endDate = opts.endDate ?? isoDate();
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 10000, 250000));

  const runId = startRun(db, 'ga4', startDate, endDate);
  const errors: string[] = [];

  const property = normalisePropertyId(process.env.GA4_PROPERTY_ID);
  if (!property) {
    const msg =
      'GA4_PROPERTY_ID is not set or malformed. Expected "123456789" or ' +
      '"properties/123456789" (GA4 Admin → Property Settings).';
    finishRun(db, runId, 'failed', 0, msg);
    return { status: 'failed', rowsWritten: 0, landingPageRows: 0, sourceRows: 0, errors: [msg], runId };
  }

  let client: Ga4Client;
  try {
    client = opts.client ?? (await getGa4Client());
  } catch (err: any) {
    const msg = `GA4 auth unavailable: ${err?.message ?? String(err)}`;
    finishRun(db, runId, 'failed', 0, msg);
    return { status: 'failed', rowsWritten: 0, landingPageRows: 0, sourceRows: 0, errors: [msg], runId };
  }

  const collectedAt = nowIso();

  const shapes: Array<{
    label: string;
    dimensions: string[];
    transform: (r: Ga4Report) => PerformanceRow[];
  }> = [
    {
      label: 'landingPage',
      dimensions: ['landingPagePlusQueryString', 'date'],
      transform: transformLandingPageReport,
    },
    {
      label: 'source',
      dimensions: ['sessionSource', 'sessionCampaign', 'date'],
      transform: transformSourceReport,
    },
  ];

  let landingPageRows = 0;
  let sourceRows = 0;
  let succeeded = 0;

  for (const shape of shapes) {
    try {
      const pages = await runReportWithMetricFallback(client, property, shape.dimensions, startDate, endDate, pageSize);
      let written = 0;
      for (const page of pages) {
        written += upsertPerformanceRows(db, shape.transform(page), collectedAt);
      }
      if (shape.label === 'landingPage') landingPageRows = written;
      else sourceRows = written;
      succeeded++;
    } catch (err: any) {
      // Defensive: one bad report must not lose the other report's rows.
      errors.push(`${shape.label} report failed: ${err?.message ?? String(err)}`);
    }
  }

  const rowsWritten = landingPageRows + sourceRows;
  const status: 'ok' | 'partial' | 'failed' =
    succeeded === shapes.length ? 'ok' : succeeded > 0 ? 'partial' : 'failed';

  finishRun(db, runId, status, rowsWritten, errors.length ? errors.join(' | ') : undefined);
  return { status, rowsWritten, landingPageRows, sourceRows, errors, runId };
}

/**
 * Convenience read: sessions per platform (utm_source) over a window.
 * This is the query that answers "which of the 34 platforms drives traffic".
 */
export function sessionsByPlatform(
  db: DB,
  startDate: string,
  endDate: string,
): Array<{ platform: string; campaign: string; sessions: number; users: number; conversions: number }> {
  const rows = db.prepare(
    `SELECT dimension_value AS dv,
            SUM(sessions)    AS sessions,
            SUM(users)       AS users,
            SUM(conversions) AS conversions
       FROM url_performance
      WHERE source = 'ga4' AND metric_scope = 'utm_source'
        AND metric_date BETWEEN ? AND ?
      GROUP BY dimension_value
      ORDER BY sessions DESC`,
  ).all(startDate, endDate) as any[];

  return rows.map(r => {
    const { source, campaign } = parseSourceDimension(String(r.dv ?? ''));
    return {
      platform: source,
      campaign,
      sessions: Number(r.sessions ?? 0),
      users: Number(r.users ?? 0),
      conversions: Number(r.conversions ?? 0),
    };
  });
}
