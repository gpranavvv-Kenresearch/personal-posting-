/**
 * gsc.ts — Google Search Console collector.
 *
 * Pulls search performance (clicks, impressions, position, ctr) for
 * kenresearch.com URLs into `url_performance` with source='gsc'.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ACCESS A HUMAN MUST GRANT BEFORE THIS CAN EVER RETURN DATA
 * ─────────────────────────────────────────────────────────────────────────────
 * There are currently NO Search Console credentials on this machine and no
 * property access. Until the two steps below are done, every call here records
 * a 'failed' collection_run with a one-line reason and returns normally — it
 * never throws into the caller and never writes partial garbage.
 *
 *   1. Service account
 *      Reuse the existing Google service account already used for Sheets. Its
 *      email is the `client_email` field inside
 *        .accounts/google-service-account.json
 *      (or the GOOGLE_SERVICE_ACCOUNT_JSON env var). It looks like
 *        <name>@<project>.iam.gserviceaccount.com
 *      Run `npx tsx -e "..."` / see describeGscAccess() below to print it
 *      safely — it is an email, not a secret, but the rest of that JSON is.
 *
 *   2. Search Console property permission
 *      In https://search.google.com/search-console, open the kenresearch.com
 *      property → Settings → Users and permissions → Add user:
 *        - User:       the service account email from step 1
 *        - Permission: **Full** is NOT required. "Restricted" is enough for
 *                      searchanalytics.query (read-only performance data).
 *      Add it to whichever property form is verified. If it is a Domain
 *      property, siteUrl must be 'sc-domain:kenresearch.com'. If it is a URL-
 *      prefix property, siteUrl must be the exact prefix including scheme and
 *      trailing slash, e.g. 'https://www.kenresearch.com/'. A mismatch here is
 *      the single most common cause of a 403 from this API.
 *
 *   3. Enable the Search Console API on the service account's Google Cloud
 *      project (APIs & Services → Enable APIs → "Google Search Console API").
 *
 * Also set, once access exists:
 *      FEATURE_INTELLIGENCE=1
 *      FEATURE_GSC_COLLECTION=1
 *      GSC_SITE_URL=sc-domain:kenresearch.com      (or the URL-prefix form)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DATA LAG
 * ─────────────────────────────────────────────────────────────────────────────
 * Search Console performance data is typically incomplete for the last 2-3
 * days. The default window therefore ENDS three days ago (DEFAULT_LAG_DAYS).
 * Collecting a more recent day is allowed but will under-report, and because
 * the upsert is keyed on (url, source, metric_date, metric_scope,
 * dimension_value) a later re-run of the same day simply overwrites it with the
 * settled numbers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENCY NOTE
 * ─────────────────────────────────────────────────────────────────────────────
 * The UNIQUE constraint includes dimension_value. In SQLite, NULL never
 * conflicts with NULL, so storing NULL there would silently duplicate rows on
 * every re-run. URL-scope rows therefore store an EMPTY STRING, not NULL.
 */

import { google } from 'googleapis';
import type { DB } from '../db.js';
import { nowIso, daysAgo, startRun, finishRun, tx } from '../db.js';
import { enabled } from '../flags.js';

export const GSC_SOURCE = 'gsc';
export const COLLECTOR_NAME = 'gsc';
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
/** GSC data is incomplete for the last ~2-3 days. */
export const DEFAULT_LAG_DAYS = 3;
/** Hard API maximum rows per searchanalytics.query call. */
export const MAX_ROW_LIMIT = 25000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface GscApiRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface GscApiResponse {
  rows?: GscApiRow[];
  responseAggregationType?: string;
}

export interface UrlPerformanceRow {
  url: string;
  source: string;
  metric_date: string;
  metric_scope: 'url' | 'query';
  /** '' for url scope (never NULL — see idempotency note above). */
  dimension_value: string;
  clicks: number;
  impressions: number;
  position: number | null;
  ctr: number | null;
}

/** Minimal shape of the searchconsole v1 client we depend on — injectable. */
export interface SearchAnalyticsClient {
  searchanalytics: {
    query(params: {
      siteUrl: string;
      requestBody: Record<string, unknown>;
    }): Promise<{ data: GscApiResponse }>;
  };
}

export interface CollectGscOptions {
  db: DB;
  /** YYYY-MM-DD inclusive. Defaults to `endDate`. */
  startDate?: string;
  /** YYYY-MM-DD inclusive. Defaults to three days ago (see DATA LAG). */
  endDate?: string;
  /** 'sc-domain:kenresearch.com' or 'https://www.kenresearch.com/'. */
  siteUrl?: string;
  /** Injected in tests. When absent, a real authenticated client is built. */
  client?: SearchAnalyticsClient;
  /** Which dimension sets to pull. Defaults to page, then page+query. */
  dimensionSets?: string[][];
  rowLimit?: number;
  log?: (msg: string) => void;
}

export interface CollectGscResult {
  status: 'skipped' | 'ok' | 'partial' | 'failed';
  rowsWritten: number;
  runId: number | null;
  reason?: string;
}

// ── Pure transform (the part that is fully tested) ───────────────────────────

function toNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function toNullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Map a searchanalytics.query response onto url_performance rows.
 *
 * Scope is inferred from the number of dimension keys unless `dimensions` is
 * given: 1 key => ['page'] => scope 'url'; 2 keys => ['page','query'] =>
 * scope 'query' with the query in dimension_value.
 *
 * Rows with no usable page key are dropped rather than written as junk.
 * Pure: no clock, no network, no database.
 */
export function transformSearchAnalyticsRows(
  apiResponse: GscApiResponse | null | undefined,
  metricDate: string,
  dimensions?: string[],
): UrlPerformanceRow[] {
  if (!apiResponse || !Array.isArray(apiResponse.rows)) return [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metricDate)) {
    throw new Error(`[gsc] metricDate must be YYYY-MM-DD, got ${JSON.stringify(metricDate)}`);
  }

  const out: UrlPerformanceRow[] = [];
  const seen = new Set<string>();

  for (const row of apiResponse.rows) {
    const keys = Array.isArray(row?.keys) ? row.keys : [];
    const url = typeof keys[0] === 'string' ? keys[0].trim() : '';
    if (!url) continue;

    const keyCount = dimensions?.length ?? keys.length;
    const scope: 'url' | 'query' = keyCount >= 2 ? 'query' : 'url';
    const dimensionValue =
      scope === 'query' ? (typeof keys[1] === 'string' ? keys[1].trim() : '') : '';

    // De-duplicate within one response: the natural key is what the UNIQUE
    // constraint uses, so a repeated key would otherwise fight itself.
    const natural = `${url}\u0000${scope}\u0000${dimensionValue}`;
    if (seen.has(natural)) continue;
    seen.add(natural);

    out.push({
      url,
      source: GSC_SOURCE,
      metric_date: metricDate,
      metric_scope: scope,
      dimension_value: dimensionValue,
      clicks: Math.round(toNumber(row.clicks)),
      impressions: Math.round(toNumber(row.impressions)),
      position: toNullableNumber(row.position),
      ctr: toNullableNumber(row.ctr),
    });
  }

  return out;
}

/** Inclusive list of YYYY-MM-DD dates from start to end. Pure. */
export function dateRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`[gsc] Invalid date range ${startDate}..${endDate}`);
  }
  if (start.getTime() > end.getTime()) return out;
  for (let d = start; d.getTime() <= end.getTime(); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ── Upsert ───────────────────────────────────────────────────────────────────

const UPSERT_SQL = `
INSERT INTO url_performance
  (url, source, metric_date, metric_scope, dimension_value,
   clicks, impressions, position, ctr, collected_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(url, source, metric_date, metric_scope, dimension_value) DO UPDATE SET
  clicks       = excluded.clicks,
  impressions  = excluded.impressions,
  position     = excluded.position,
  ctr          = excluded.ctr,
  collected_at = excluded.collected_at
`;

/** Insert-or-update rows. Re-running the same day UPDATES, never duplicates. */
export function upsertUrlPerformance(db: DB, rows: UrlPerformanceRow[], collectedAt = nowIso()): number {
  if (!rows.length) return 0;
  return tx(db, () => {
    const stmt = db.prepare(UPSERT_SQL);
    for (const r of rows) {
      stmt.run(
        r.url,
        r.source,
        r.metric_date,
        r.metric_scope,
        r.dimension_value ?? '',
        r.clicks,
        r.impressions,
        r.position,
        r.ctr,
        collectedAt,
      );
    }
    return rows.length;
  });
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface CredentialResolution {
  credentials?: Record<string, unknown>;
  clientEmail?: string;
  reason?: string;
}

/**
 * Resolve the service account credentials the same way src/sheets/sheets.ts
 * does: GOOGLE_SERVICE_ACCOUNT_JSON env first, then
 * .accounts/google-service-account.json. Never returns or logs the key itself.
 */
export async function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialResolution> {
  let raw: string | undefined;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  } else {
    try {
      const fs = (await import('fs')).default;
      raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
    } catch {
      return {
        reason:
          'no Google service account: set GOOGLE_SERVICE_ACCOUNT_JSON or place .accounts/google-service-account.json',
      };
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { reason: 'service account JSON is not valid JSON (not printing it)' };
  }
  if (typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    return { reason: 'service account JSON is missing client_email or private_key' };
  }
  return { credentials: parsed, clientEmail: parsed.client_email };
}

/** One safe line telling a human exactly what to grant. Never prints a key. */
export async function describeGscAccess(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const res = await resolveCredentials(env);
  if (!res.clientEmail) return `[gsc] access not grantable yet: ${res.reason}`;
  return (
    `[gsc] grant "Restricted" permission to ${res.clientEmail} on the ` +
    `kenresearch.com Search Console property, then set GSC_SITE_URL to that ` +
    `property's exact form (sc-domain:... or https://.../)`
  );
}

async function buildClient(env: NodeJS.ProcessEnv): Promise<{ client?: SearchAnalyticsClient; reason?: string }> {
  const res = await resolveCredentials(env);
  if (!res.credentials) return { reason: res.reason };
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: res.credentials as any,
      scopes: [GSC_SCOPE],
    });
    const sc = google.searchconsole({ version: 'v1', auth: auth as any });
    return { client: sc as unknown as SearchAnalyticsClient };
  } catch (err: any) {
    return { reason: `could not build Search Console client: ${err?.message ?? err}` };
  }
}

// ── Paging ───────────────────────────────────────────────────────────────────

/**
 * Query one day / one dimension set, following startRow paging until the API
 * returns fewer rows than the page size. Pure with respect to the database.
 */
export async function queryAllPages(
  client: SearchAnalyticsClient,
  siteUrl: string,
  date: string,
  dimensions: string[],
  rowLimit: number = MAX_ROW_LIMIT,
): Promise<GscApiRow[]> {
  const limit = Math.min(Math.max(1, rowLimit), MAX_ROW_LIMIT);
  const all: GscApiRow[] = [];
  let startRow = 0;

  // Guard against a server that never shrinks a page: cap total pages.
  for (let page = 0; page < 100; page++) {
    const res = await client.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: date,
        endDate: date,
        dimensions,
        rowLimit: limit,
        startRow,
        dataState: 'final',
      },
    });
    const rows = res?.data?.rows ?? [];
    all.push(...rows);
    if (rows.length < limit) break;
    startRow += rows.length;
  }

  return all;
}

// ── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect GSC performance into url_performance.
 *
 * No-op when FEATURE_INTELLIGENCE + FEATURE_GSC_COLLECTION are not both on.
 * Never throws: a missing credential or missing property access produces a
 * 'failed' collection_run with a one-line reason; a single bad day inside a
 * wider window produces 'partial' and keeps the days that did work.
 */
export async function collectGsc(opts: CollectGscOptions): Promise<CollectGscResult> {
  const log = opts.log ?? ((m: string) => console.log(m));

  if (!enabled('GSC_COLLECTION')) {
    return { status: 'skipped', rowsWritten: 0, runId: null, reason: 'FEATURE_GSC_COLLECTION off' };
  }

  const endDate = opts.endDate ?? daysAgo(DEFAULT_LAG_DAYS);
  const startDate = opts.startDate ?? endDate;
  const siteUrl = opts.siteUrl ?? (process.env.GSC_SITE_URL ?? '').trim();
  const dimensionSets = opts.dimensionSets ?? [['page'], ['page', 'query']];
  const rowLimit = opts.rowLimit ?? MAX_ROW_LIMIT;

  const runId = startRun(opts.db, COLLECTOR_NAME, startDate, endDate);

  if (!siteUrl) {
    const reason = 'no siteUrl: set GSC_SITE_URL (sc-domain:kenresearch.com or the URL-prefix form)';
    log(`[gsc] skipped — ${reason}`);
    finishRun(opts.db, runId, 'failed', 0, reason);
    return { status: 'failed', rowsWritten: 0, runId, reason };
  }

  let client = opts.client;
  if (!client) {
    const built = await buildClient(process.env);
    if (!built.client) {
      const reason = built.reason ?? 'unknown auth failure';
      log(`[gsc] cannot collect — ${reason}`);
      finishRun(opts.db, runId, 'failed', 0, reason);
      return { status: 'failed', rowsWritten: 0, runId, reason };
    }
    client = built.client;
  }

  let dates: string[];
  try {
    dates = dateRange(startDate, endDate);
  } catch (err: any) {
    const reason = err?.message ?? String(err);
    finishRun(opts.db, runId, 'failed', 0, reason);
    return { status: 'failed', rowsWritten: 0, runId, reason };
  }

  let rowsWritten = 0;
  const failures: string[] = [];
  let successes = 0;

  for (const date of dates) {
    for (const dimensions of dimensionSets) {
      try {
        const apiRows = await queryAllPages(client, siteUrl, date, dimensions, rowLimit);
        const rows = transformSearchAnalyticsRows({ rows: apiRows }, date, dimensions);
        rowsWritten += upsertUrlPerformance(opts.db, rows);
        successes++;
      } catch (err: any) {
        // One bad day/dimension must not lose the whole batch.
        const msg = `${date} [${dimensions.join('+')}]: ${err?.message ?? err}`;
        failures.push(msg);
        log(`[gsc] query failed — ${msg}`);
      }
    }
  }

  if (failures.length && successes === 0) {
    const reason = failures[0];
    finishRun(opts.db, runId, 'failed', rowsWritten, reason);
    return { status: 'failed', rowsWritten, runId, reason };
  }
  if (failures.length) {
    const reason = `${failures.length} of ${dates.length * dimensionSets.length} queries failed; first: ${failures[0]}`;
    finishRun(opts.db, runId, 'partial', rowsWritten, reason);
    return { status: 'partial', rowsWritten, runId, reason };
  }

  finishRun(opts.db, runId, 'ok', rowsWritten);
  log(`[gsc] ok — ${rowsWritten} rows for ${startDate}..${endDate}`);
  return { status: 'ok', rowsWritten, runId };
}
