/**
 * pipedrive.ts — CRM lead collector.
 *
 * PURPOSE
 *   Pull deals out of Pipedrive into the `leads` table (schema.ts migration 4)
 *   and attribute each one to a landing URL, a utm_source and — where the data
 *   allows — the kenresearch.com report URL that earned it.
 *
 * WHY IT IS WRITTEN SO DEFENSIVELY
 *   At the time of writing NO Pipedrive API token exists and nobody knows how
 *   this particular CRM account lays out its custom fields. Pipedrive exposes
 *   custom fields as opaque 40-char hash keys that differ per account, so
 *   hardcoding a field key would be a guess that silently returns nothing.
 *   Therefore:
 *     - the field layout is CONFIGURATION (env PIPEDRIVE_FIELD_MAP), not code;
 *     - when configuration is absent we fall back to scanning the deal for
 *       anything that looks like a URL or a known utm_source value;
 *     - every transform is a pure exported function so it can be tested hard
 *       against fixtures long before a real token exists.
 *
 * INDEPENDENCE (blueprint modification #8)
 *   This module imports neither the GSC nor the GA4 collector and works fine
 *   with both of them unbuilt. Leads are useful on their own.
 *
 * WHAT A HUMAN MUST SUPPLY — see humanSetupInstructions() at the bottom.
 */

import { enabled } from '../flags.js';
import { nowIso, startRun, finishRun, type DB } from '../db.js';

export const COLLECTOR = 'pipedrive';
const API_BASE = 'https://api.pipedrive.com/v1';
const PAGE_LIMIT = 100;
const MAX_PAGES = 200; // hard stop; 20k deals per run is already absurd

// ── Types ────────────────────────────────────────────────────────────────────

/** Maps a logical attribute to the Pipedrive custom-field hash key holding it. */
export interface FieldMap {
  landing_url?: string;
  report_url?: string;
  utm_source?: string;
  utm_campaign?: string;
}

export type AttributionMethod = 'field_map' | 'scan' | 'mixed' | 'none';

export interface Attribution {
  landing_url: string | null;
  report_url: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  method: AttributionMethod;
}

/** One row as it will be written to `leads`. */
export interface LeadRow {
  external_id: string;
  source_system: string;
  created_at: string;       // ISO-8601 UTC
  landing_url: string | null;
  report_url: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  stage: string | null;
  status: string | null;
  value_minor: number | null;
  currency: string | null;
  attribution_method: AttributionMethod;
}

export interface CollectResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  rows: number;
  pages: number;
  runId: number | null;
  status: 'skipped' | 'ok' | 'partial' | 'failed';
  error?: string;
}

type FetchLike = (input: string, init?: any) => Promise<any>;

// ── utm_source vocabulary ────────────────────────────────────────────────────

/**
 * The utm_source values this project actually emits (see src/utils/utm.ts) plus
 * the obvious aliases. Used ONLY by the scanning fallback: when a mapped field
 * exists its value wins, whatever it says.
 */
export const KNOWN_UTM_SOURCES: readonly string[] = [
  'facebook', 'fb', 'linkedin', 'linkedin-pulse', 'li', 'x', 'twitter',
  'medium', 'substack', 'hackmd', 'devto', 'dev.to', 'linkmate', 'guffiz',
  'googlesite', 'google-sites', 'blogger', 'notion', 'coda', 'paragraph',
  'wordpress', 'naver', 'calisthenics', 'instagram', 'youtube', 'patreon',
  'note', 'newsletter', 'email', 'organic', 'direct', 'google', 'bing',
];

const UTM_SET = new Set(KNOWN_UTM_SOURCES.map(s => s.toLowerCase()));

const REPORT_HOST_HINT = 'kenresearch.com';

// ── Money ────────────────────────────────────────────────────────────────────

/** Currencies that are not two-decimal. Anything unlisted is assumed to be 2. */
const MINOR_EXPONENT: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, PYG: 0, RWF: 0, UGX: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function minorExponent(currency?: string | null): number {
  if (!currency) return 2;
  const e = MINOR_EXPONENT[currency.trim().toUpperCase()];
  return e === undefined ? 2 : e;
}

/** Major-unit amount -> integer minor units. Null for anything non-numeric. */
export function moneyToMinor(value: unknown, currency?: string | null): number | null {
  // Number('') and Number('   ') are 0, which would silently turn an EMPTY
  // Pipedrive value field into a real zero-value deal. An absent amount is
  // null, not zero.
  const n =
    typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value.trim())
    : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * Math.pow(10, minorExponent(currency)));
}

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Pipedrive returns 'YYYY-MM-DD HH:MM:SS' in UTC (no zone marker). Normalise to
 * a real ISO-8601 UTC string. Returns null for anything unparseable rather than
 * inventing a timestamp.
 */
export function toIsoUtc(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]}T${m[2]}.000Z`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Field map parsing ────────────────────────────────────────────────────────

/**
 * Parse PIPEDRIVE_FIELD_MAP. Bad JSON is a configuration mistake, not a crash:
 * we return an empty map so the scanning fallback still produces something.
 */
export function parseFieldMap(json?: string | null): FieldMap {
  const raw = (json ?? '').trim();
  if (!raw) return {};
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: FieldMap = {};
  for (const k of ['landing_url', 'report_url', 'utm_source', 'utm_campaign'] as const) {
    const v = parsed[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

// ── Attribution ──────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s"'<>\\)]+/i;

function isUrlish(v: unknown): v is string {
  return typeof v === 'string' && URL_RE.test(v);
}

function extractUrl(v: string): string | null {
  const m = URL_RE.exec(v);
  return m ? m[0].replace(/[.,;:]+$/, '') : null;
}

function safeUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

/** Strip query + fragment — a report URL is the page, not the click. */
export function canonicalReportUrl(u: string): string | null {
  const p = safeUrl(u);
  if (!p) return null;
  return `${p.origin}${p.pathname}`.replace(/\/$/, '') || null;
}

function looksLikeReport(u: string): boolean {
  const p = safeUrl(u);
  return !!p && p.hostname.toLowerCase().includes(REPORT_HOST_HINT);
}

function hasUtm(u: string): boolean {
  const p = safeUrl(u);
  return !!p && [...p.searchParams.keys()].some(k => k.toLowerCase().startsWith('utm_'));
}

/**
 * Walk a deal's own values (plus one level of nesting, because Pipedrive v2 and
 * some exports nest custom fields under `custom_fields`). Returns [key, value]
 * pairs of strings in a STABLE order so attribution is deterministic.
 */
function stringEntries(deal: any): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!deal || typeof deal !== 'object') return out;
  for (const [k, v] of Object.entries(deal)) {
    if (typeof v === 'string') { out.push([k, v]); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as any)) {
        if (typeof v2 === 'string') out.push([`${k}.${k2}`, v2]);
      }
    }
  }
  return out;
}

function mappedValue(deal: any, key?: string): string | null {
  if (!key || !deal || typeof deal !== 'object') return null;
  let v: any = deal[key];
  if (v === undefined && deal.custom_fields && typeof deal.custom_fields === 'object') {
    v = deal.custom_fields[key];
  }
  if (v && typeof v === 'object' && typeof v.value === 'string') v = v.value; // v2 shape
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function normaliseUtm(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (!s || s.length > 40) return null;
  return UTM_SET.has(s) ? s : null;
}

/**
 * Work out where a deal came from.
 *
 * Order of trust:
 *   1. An explicitly mapped custom field. Always wins — if an operator tells us
 *      which field holds the landing URL, we believe them.
 *   2. Scanning. Among all URLs anywhere on the deal, the one carrying utm_*
 *      parameters is the best landing-URL candidate (that is literally what the
 *      tags are for); otherwise the first URL found, in key order.
 *   3. report_url: the first kenresearch.com URL seen, canonicalised. If the
 *      landing URL itself is on kenresearch.com, that is the report.
 *
 * Pure: no I/O, no clock, no env.
 */
export function inferAttribution(deal: any, fieldMap: FieldMap = {}): Attribution {
  let usedMap = false;
  let usedScan = false;

  // ── 1. mapped fields
  const mapLanding = mappedValue(deal, fieldMap.landing_url);
  const mapReport = mappedValue(deal, fieldMap.report_url);
  const mapSource = mappedValue(deal, fieldMap.utm_source);
  const mapCampaign = mappedValue(deal, fieldMap.utm_campaign);

  let landing: string | null = mapLanding && isUrlish(mapLanding) ? extractUrl(mapLanding) : mapLanding;
  let report: string | null = mapReport ? (canonicalReportUrl(mapReport) ?? mapReport) : null;
  let source: string | null = mapSource ? mapSource.trim().toLowerCase() : null;
  let campaign: string | null = mapCampaign;
  if (landing || report || source || campaign) usedMap = true;

  // ── 2. scan for URLs
  const entries = stringEntries(deal);
  const urls: string[] = [];
  for (const [, v] of entries) {
    const u = isUrlish(v) ? extractUrl(v) : null;
    if (u && !urls.includes(u)) urls.push(u);
  }

  if (!landing && urls.length) {
    landing = urls.find(hasUtm) ?? urls[0];
    usedScan = true;
  }

  if (!report) {
    const fromLanding = landing && looksLikeReport(landing) ? canonicalReportUrl(landing) : null;
    const fromScan = urls.find(looksLikeReport);
    const picked = fromLanding ?? (fromScan ? canonicalReportUrl(fromScan) : null);
    if (picked) { report = picked; usedScan = true; }
  }

  // ── 3. utm params off the landing URL, then a vocabulary scan
  if (landing) {
    const p = safeUrl(landing);
    if (p) {
      if (!source) {
        const s = p.searchParams.get('utm_source');
        if (s && s.trim()) { source = s.trim().toLowerCase(); usedScan = true; }
      }
      if (!campaign) {
        const c = p.searchParams.get('utm_campaign');
        if (c && c.trim()) { campaign = c.trim(); usedScan = true; }
      }
    }
  }

  if (!source) {
    for (const [, v] of entries) {
      const s = normaliseUtm(v);
      if (s) { source = s; usedScan = true; break; }
    }
  }

  const method: AttributionMethod =
    usedMap && usedScan ? 'mixed'
    : usedMap ? 'field_map'
    : usedScan ? 'scan'
    : 'none';

  return {
    landing_url: landing ?? null,
    report_url: report ?? null,
    utm_source: source ?? null,
    utm_campaign: campaign ?? null,
    method,
  };
}

// ── Transform ────────────────────────────────────────────────────────────────

function stageOf(deal: any): string | null {
  if (typeof deal?.stage_name === 'string' && deal.stage_name.trim()) return deal.stage_name.trim();
  if (deal?.stage_id !== undefined && deal?.stage_id !== null) return String(deal.stage_id);
  return null;
}

/**
 * Turn one `GET /v1/deals` response body into LeadRows. Pure.
 *
 * Tolerates: a bare array, {data:null} (Pipedrive's "no results"), deals
 * missing an id (skipped — without a natural key we cannot upsert), and
 * missing add_time (falls back to update_time, then null).
 */
export function transformDeals(apiResponse: any, fieldMap: FieldMap = {}): LeadRow[] {
  const data: any[] =
    Array.isArray(apiResponse) ? apiResponse
    : Array.isArray(apiResponse?.data) ? apiResponse.data
    : [];

  const rows: LeadRow[] = [];
  for (const deal of data) {
    if (!deal || typeof deal !== 'object') continue;
    const id = deal.id;
    if (id === undefined || id === null || String(id).trim() === '') continue;

    const attribution = inferAttribution(deal, fieldMap);
    const currency = typeof deal.currency === 'string' && deal.currency.trim()
      ? deal.currency.trim().toUpperCase()
      : null;

    rows.push({
      external_id: String(id),
      source_system: 'pipedrive',
      created_at: toIsoUtc(deal.add_time) ?? toIsoUtc(deal.update_time) ?? '',
      landing_url: attribution.landing_url,
      report_url: attribution.report_url,
      utm_source: attribution.utm_source,
      utm_campaign: attribution.utm_campaign,
      stage: stageOf(deal),
      status: typeof deal.status === 'string' ? deal.status : null,
      value_minor: moneyToMinor(deal.value, currency),
      currency,
      attribution_method: attribution.method,
    });
  }
  return rows;
}

/** Read Pipedrive's pagination block defensively. */
export function readPagination(apiResponse: any): { more: boolean; nextStart: number | null } {
  const p = apiResponse?.additional_data?.pagination;
  if (!p || typeof p !== 'object') return { more: false, nextStart: null };
  const more = p.more_items_in_collection === true;
  const next = typeof p.next_start === 'number' ? p.next_start : null;
  return { more, nextStart: next };
}

// ── Persistence ──────────────────────────────────────────────────────────────

const UPSERT_SQL = `
  INSERT INTO leads
    (external_id, source_system, created_at, landing_url, report_url,
     utm_source, utm_campaign, stage, status, value_minor, currency, collected_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source_system, external_id) DO UPDATE SET
    created_at   = excluded.created_at,
    landing_url  = COALESCE(excluded.landing_url,  leads.landing_url),
    report_url   = COALESCE(excluded.report_url,   leads.report_url),
    utm_source   = COALESCE(excluded.utm_source,   leads.utm_source),
    utm_campaign = COALESCE(excluded.utm_campaign, leads.utm_campaign),
    stage        = excluded.stage,
    status       = excluded.status,
    value_minor  = excluded.value_minor,
    currency     = excluded.currency,
    collected_at = excluded.collected_at
`;

/**
 * Idempotent write. Re-running for the same day UPDATES on the natural key
 * (source_system, external_id) and never duplicates. Attribution columns use
 * COALESCE so a later run that lost its field map does not erase a good value.
 */
export function upsertLeads(db: DB, rows: LeadRow[], collectedAt = nowIso()): number {
  const stmt = db.prepare(UPSERT_SQL);
  let n = 0;
  for (const r of rows) {
    if (!r.created_at) continue; // created_at is NOT NULL in schema
    stmt.run(
      r.external_id, r.source_system, r.created_at, r.landing_url, r.report_url,
      r.utm_source, r.utm_campaign, r.stage, r.status, r.value_minor, r.currency,
      collectedAt,
    );
    n++;
  }
  return n;
}

// ── Collector ────────────────────────────────────────────────────────────────

/** Remove anything token-shaped from text before it reaches a log. */
export function redact(text: string, token?: string | null): string {
  let out = text;
  if (token && token.length >= 6) out = out.split(token).join('***');
  return out.replace(/api_token=[^&\s]+/gi, 'api_token=***');
}

export interface CollectOptions {
  db: DB;
  /** Earliest lead creation date to keep, YYYY-MM-DD or ISO. Default: all. */
  since?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests. Defaults to process.env.PIPEDRIVE_API_TOKEN. */
  token?: string;
  /** Injected for tests. Defaults to process.env.PIPEDRIVE_FIELD_MAP. */
  fieldMapJson?: string;
  /** Ignore the feature flag (used by a manual one-off run). */
  force?: boolean;
  pageLimit?: number;
}

/**
 * Collect deals into `leads`.
 *
 * Degradation ladder — none of these throw:
 *   flag off          -> {skipped:true}, no run row, nothing written.
 *   no token          -> 'failed' run with a clear, token-free message.
 *   HTTP/parse error  -> 'partial' if anything was written, else 'failed'.
 *   weird deal shapes -> skipped individually; the batch still lands.
 */
export async function collectPipedrive(opts: CollectOptions): Promise<CollectResult> {
  const { db, since } = opts;

  if (!opts.force && !enabled('PIPEDRIVE_COLLECTION')) {
    return {
      ok: true, skipped: true, status: 'skipped', rows: 0, pages: 0, runId: null,
      reason: 'FEATURE_PIPEDRIVE_COLLECTION (or FEATURE_INTELLIGENCE) is off — no-op.',
    };
  }

  const token = (opts.token ?? process.env.PIPEDRIVE_API_TOKEN ?? '').trim();
  const fieldMap = parseFieldMap(opts.fieldMapJson ?? process.env.PIPEDRIVE_FIELD_MAP);
  const windowEnd = nowIso().slice(0, 10);
  const runId = startRun(db, COLLECTOR, since, windowEnd);

  if (!token) {
    const msg =
      'PIPEDRIVE_API_TOKEN is not set. Set it in .env (Pipedrive > Personal preferences > ' +
      'API > Your personal API token). Lead collection skipped.';
    finishRun(db, runId, 'failed', 0, msg);
    return { ok: false, skipped: false, status: 'failed', rows: 0, pages: 0, runId, error: msg };
  }

  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const limit = opts.pageLimit ?? PAGE_LIMIT;
  const sinceIso = since ? toIsoUtc(since) : null;

  let start = 0;
  let pages = 0;
  let written = 0;
  let failure: string | null = null;

  try {
    while (pages < MAX_PAGES) {
      const url = `${API_BASE}/deals?limit=${limit}&start=${start}&sort=${encodeURIComponent('add_time DESC')}`;
      const res = await doFetch(url, {
        method: 'GET',
        headers: { 'x-api-token': token, accept: 'application/json' },
      });

      if (!res || res.ok === false) {
        failure = `Pipedrive returned HTTP ${res?.status ?? '?'} on page ${pages + 1}.`;
        break;
      }

      const body = await res.json();
      if (body && body.success === false) {
        failure = `Pipedrive error on page ${pages + 1}: ${String(body.error ?? 'unknown')}`;
        break;
      }

      const rows = transformDeals(body, fieldMap);
      const keep = sinceIso ? rows.filter(r => r.created_at >= sinceIso) : rows;
      written += upsertLeads(db, keep);
      pages++;

      // Sorted newest-first: once an entire page predates the window, stop.
      const pageExhausted = Boolean(sinceIso) && rows.length > 0 && keep.length === 0;
      const { more, nextStart } = readPagination(body);
      if (pageExhausted || !more || rows.length === 0) break;
      start = nextStart ?? start + limit;
    }
  } catch (err: any) {
    failure = redact(String(err?.message ?? err), token);
  }

  if (failure) {
    const status = written > 0 ? 'partial' : 'failed';
    const msg = redact(failure, token);
    finishRun(db, runId, status, written, msg);
    return { ok: false, skipped: false, status, rows: written, pages, runId, error: msg };
  }

  finishRun(db, runId, 'ok', written);
  return { ok: true, skipped: false, status: 'ok', rows: written, pages, runId };
}

// ── What a human must supply ─────────────────────────────────────────────────

/**
 * Printed by the operator runbook. Deliberately verbose: nobody on this project
 * has ever held a Pipedrive token, so the discovery steps must be written down.
 */
export function humanSetupInstructions(): string {
  return [
    'PIPEDRIVE SETUP — two things are needed, both from a human with CRM access.',
    '',
    '1. PIPEDRIVE_API_TOKEN',
    '   Pipedrive > (avatar) > Personal preferences > API > "Your personal API token".',
    '   Copy it into .env as PIPEDRIVE_API_TOKEN=... . The token inherits that',
    '   user\'s permissions, so use an account that can see all deals.',
    '   Never commit it; never paste it into a log or an issue.',
    '',
    '2. PIPEDRIVE_FIELD_MAP (optional but strongly recommended)',
    '   Custom fields are 40-character hash keys that differ per account, so they',
    '   cannot be hardcoded. Discover this account\'s keys with:',
    '',
    '     curl -H "x-api-token: $PIPEDRIVE_API_TOKEN" \\',
    '          https://api.pipedrive.com/v1/dealFields',
    '',
    '   Each entry has "name" (what a human sees, e.g. "Landing Page URL") and',
    '   "key" (the hash). Find the fields holding the landing page URL and the',
    '   utm_source, then set:',
    '',
    '     PIPEDRIVE_FIELD_MAP={"landing_url":"<hash>","utm_source":"<hash>"}',
    '',
    '   Optional extra keys: "report_url", "utm_campaign".',
    '',
    'Without the field map the collector still runs: it scans each deal for any',
    'URL and for a recognisable utm_source value. That fallback is best-effort —',
    'attribution_method on each row records whether a value was mapped or guessed.',
    '',
    '3. Enable it: FEATURE_INTELLIGENCE=1 and FEATURE_PIPEDRIVE_COLLECTION=1.',
    '   With either unset the collector is a no-op and writes nothing.',
  ].join('\n');
}
