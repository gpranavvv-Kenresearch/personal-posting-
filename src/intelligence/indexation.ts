/**
 * indexation.ts — is a published post actually in Google's index?
 *
 * STANDING PROJECT DECISION (blueprint modification #1):
 *   A third-party `site:` query is INDEXATION EVIDENCE, NOT DEFINITIVE
 *   CONFIRMATION. Google's site: operator is well known to under-report, and a
 *   SERP reseller adds its own caching and throttling on top. Therefore:
 *
 *     - exact URL present in the results  -> 'indexed'      (high confidence)
 *     - clean zero-result from a healthy  -> 'not_indexed'  (MODERATE, never 1.0)
 *       provider
 *     - provider error / rate limit /     -> 'unknown'      (confidence 0)
 *       captcha / garbled body / all
 *       providers exhausted
 *
 *   'unknown' is a FIRST-CLASS RESULT, not a failure. Nothing in this module
 *   may ever downgrade an 'unknown' into a 'not_indexed'.
 *
 * Key rotation and provider fallback are NOT reimplemented here: this module
 * wraps src/config/serpApiClient.ts (SerpAPI -> Zenserp -> Serpstack, with
 * per-provider key rotation) and only adds classification + persistence.
 *
 * Gated by FEATURE_INDEXATION_CHECKS (plus the FEATURE_INTELLIGENCE master
 * switch). Disabled, checkIndexation() is a no-op that writes nothing.
 */

import fs from 'fs';
import path from 'path';
import { callSerpApi } from '../config/serpApiClient.js';
import { enabled } from './flags.js';
import { nowIso, startRun, finishRun, type DB } from './db.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type IndexationStatus = 'indexed' | 'not_indexed' | 'unknown';

export interface Classification {
  status: IndexationStatus;
  /** 0..1. Never 1.0 for 'not_indexed' — site: is unreliable by construction. */
  confidence: number;
  /** Short human-readable justification, safe to log (no keys, no tokens). */
  evidence: string;
  /** Number of organic results the provider returned, or null when unknowable. */
  rawHitCount: number | null;
}

/** Normalised shape produced by serpApiClient for every provider. */
export interface SerpResult { link?: string; title?: string; snippet?: string; position?: number }
export interface SerpResponse { organic_results?: SerpResult[]; error?: unknown; [k: string]: unknown }

/** Injectable so tests never touch the network. */
export type SerpSearcher = (query: string) => Promise<{ response: unknown; provider: string }>;

export interface CheckIndexationOptions {
  db: DB;
  /** URLs to check. Either plain strings or {url, platform}. */
  urls: Array<string | { url: string; platform?: string | null }>;
  /** Hard cap on provider calls for this run. Default 25. */
  limit?: number;
  /** Skip any URL already checked within this many days. Default 7. */
  maxAgeDays?: number;
  /** Polite delay between provider calls, ms. Default 2000 (0 in tests). */
  delayMs?: number;
  /** Test seam. Defaults to the real SERP provider rotation. */
  searcher?: SerpSearcher;
}

export interface CheckIndexationSummary {
  enabled: boolean;
  considered: number;
  skippedRecent: number;
  checked: number;
  indexed: number;
  notIndexed: number;
  unknown: number;
  runId: number | null;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_DELAY_MS = 2000;

const CONFIDENCE_INDEXED = 0.95;
const CONFIDENCE_NOT_INDEXED = 0.6;        // moderate, deliberately not 1.0
const CONFIDENCE_NOT_INDEXED_NEAR_MISS = 0.55;
const CONFIDENCE_UNKNOWN = 0;

// ── URL normalisation ────────────────────────────────────────────────────────

/** Query params that are tracking noise and must never affect identity. */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src', 'source',
];

/**
 * Canonical form for comparison: scheme dropped, host lowercased, leading
 * `www.` removed, tracking params stripped, remaining params sorted, fragment
 * dropped, trailing slash removed.
 *
 * Returns a trimmed lowercase best-effort string for input that is not a URL,
 * so a malformed row degrades to "never matches" rather than throwing.
 */
export function normaliseUrl(input: string): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';

  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw.toLowerCase();

  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
  const params = [...u.searchParams.entries()].sort(
    (a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1),
  );
  const qs = params.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&');

  let pathname = decodeURI_(u.pathname).replace(/\/{2,}/g, '/');
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  if (pathname === '/') pathname = '';

  return `${host}${pathname}${qs ? `?${qs}` : ''}`;
}

function decodeURI_(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function hostOf(normalised: string): string {
  const slash = normalised.indexOf('/');
  const q = normalised.indexOf('?');
  let end = normalised.length;
  if (slash !== -1) end = Math.min(end, slash);
  if (q !== -1) end = Math.min(end, q);
  return normalised.slice(0, end);
}

// ── Classification (PURE) ────────────────────────────────────────────────────

/**
 * Turn one provider response into a tri-state verdict. Pure: no I/O, no clock,
 * no randomness. Everything this module decides about a URL is decided here.
 */
export function classifyIndexation(providerResponse: unknown, targetUrl: string): Classification {
  const target = normaliseUrl(targetUrl);

  if (!target) {
    return unknownResult('target url is empty or unparseable');
  }

  // Thrown/rejected calls are passed in as Error for convenience.
  if (providerResponse instanceof Error) {
    return unknownResult(`provider error: ${sanitise(providerResponse.message)}`);
  }
  if (providerResponse === null || providerResponse === undefined) {
    return unknownResult('provider returned no body');
  }
  if (typeof providerResponse === 'string') {
    const s = providerResponse.trim();
    if (!s) return unknownResult('provider returned an empty body');
    if (looksLikeBlock(s)) return unknownResult(`provider blocked: ${sanitise(s.slice(0, 80))}`);
    return unknownResult('provider returned a non-JSON body');
  }
  if (typeof providerResponse !== 'object' || Array.isArray(providerResponse)) {
    return unknownResult('provider returned an unexpected body shape');
  }

  const body = providerResponse as SerpResponse;

  // Explicit provider-side failure (serpstack `error`, zenserp message, ...).
  if (body.error !== undefined && body.error !== null && body.error !== false) {
    const msg = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    return unknownResult(`provider reported an error: ${sanitise(String(msg).slice(0, 120))}`);
  }
  for (const key of ['search_metadata_status_error', 'captcha', 'message'] as const) {
    const v = (body as any)[key];
    if (typeof v === 'string' && looksLikeBlock(v)) {
      return unknownResult(`provider blocked: ${sanitise(v.slice(0, 80))}`);
    }
  }

  const results = body.organic_results;
  if (results === undefined || results === null) {
    // No organic_results key at all => we cannot tell zero results from a
    // garbled response. Never call this 'not_indexed'.
    return unknownResult('response has no organic_results field');
  }
  if (!Array.isArray(results)) {
    return unknownResult('organic_results is not an array');
  }

  const links = results
    .map(r => (r && typeof r === 'object' ? String((r as SerpResult).link ?? '') : ''))
    .filter(Boolean);
  const rawHitCount = results.length;

  if (rawHitCount === 0) {
    return {
      status: 'not_indexed',
      confidence: CONFIDENCE_NOT_INDEXED,
      evidence: `site: query returned 0 organic results for ${target} (evidence only — Google's site: operator under-reports)`,
      rawHitCount: 0,
    };
  }

  // Results came back, but not one of them carried a usable url. We cannot
  // compare anything, so we cannot claim the target is absent: that is a
  // garbled payload, i.e. 'unknown' — never 'not_indexed'.
  if (links.length === 0) {
    return unknownResult(
      `${rawHitCount} result(s) returned but none carried a url — cannot compare against ${target}`,
    );
  }

  const exact = links.find(l => normaliseUrl(l) === target);
  if (exact) {
    return {
      status: 'indexed',
      confidence: CONFIDENCE_INDEXED,
      evidence: `exact url found in organic results (${rawHitCount} hit${rawHitCount === 1 ? '' : 's'}): ${exact}`,
      rawHitCount,
    };
  }

  // Near miss: the domain is in the index, but THIS url was not returned.
  const targetHost = hostOf(target);
  const sameDomain = links.filter(l => hostOf(normaliseUrl(l)) === targetHost);
  if (sameDomain.length) {
    return {
      status: 'not_indexed',
      confidence: CONFIDENCE_NOT_INDEXED_NEAR_MISS,
      evidence:
        `${rawHitCount} result(s) on ${targetHost} but none matched ${target} ` +
        `(nearest: ${sameDomain[0]}) — different url on the same domain does not count as indexed`,
      rawHitCount,
    };
  }

  return {
    status: 'not_indexed',
    confidence: CONFIDENCE_NOT_INDEXED,
    evidence: `${rawHitCount} result(s) returned, none on ${targetHost} — target url absent`,
    rawHitCount,
  };
}

function unknownResult(evidence: string): Classification {
  return { status: 'unknown', confidence: CONFIDENCE_UNKNOWN, evidence, rawHitCount: null };
}

function looksLikeBlock(s: string): boolean {
  const m = s.toLowerCase();
  return (
    m.includes('captcha') || m.includes('unusual traffic') || m.includes('rate limit') ||
    m.includes('ratelimit') || m.includes('too many requests') || m.includes('429') ||
    m.includes('quota') || m.includes('exhausted') || m.includes('forbidden') ||
    m.includes('<html')
  );
}

/** Belt and braces: never let a credential reach a log or the database. */
function sanitise(s: string): string {
  return s
    .replace(/\b(api[_-]?key|apikey|access_key|token)\b\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]');
}

// ── Query building ───────────────────────────────────────────────────────────

/** `site:` query for one exact URL. */
export function buildSiteQuery(url: string): string {
  const n = normaliseUrl(url);
  return n ? `site:${n}` : '';
}

// ── Provider plumbing ────────────────────────────────────────────────────────

const PROVIDER_ROT_STATE = path.resolve('.sessions/provider-rotation.json');
const PROVIDER_ORDER = ['serpapi', 'zenserp', 'serpstack'];

/**
 * serpApiClient does not report which provider answered, and we must not edit
 * it. It does, however, advance .sessions/provider-rotation.json to
 * (answeringProviderIndex + 1) on success, so the answering provider can be
 * read back. Best-effort only: falls back to a generic label.
 */
function providerThatAnswered(): string {
  try {
    const raw = JSON.parse(fs.readFileSync(PROVIDER_ROT_STATE, 'utf-8')) as { index?: number };
    const next = Number(raw?.index ?? 0);
    if (!Number.isFinite(next)) return 'serp-rotation';
    const idx = (next - 1 + PROVIDER_ORDER.length) % PROVIDER_ORDER.length;
    return PROVIDER_ORDER[idx] ?? 'serp-rotation';
  } catch {
    return 'serp-rotation';
  }
}

/** Default searcher: the project's existing provider rotation, nothing new. */
export const defaultSearcher: SerpSearcher = async (query: string) => {
  const response = await callSerpApi({ q: query, num: '20', hl: 'en', gl: 'us' });
  return { response, provider: providerThatAnswered() };
};

// ── Persistence ──────────────────────────────────────────────────────────────

/** Most recent check for a URL, matched on the NORMALISED url we store. */
export function lastCheck(db: DB, url: string): { checked_at: string; status: IndexationStatus } | null {
  const row = db.prepare(
    `SELECT checked_at, status FROM indexation_checks WHERE url = ? ORDER BY checked_at DESC LIMIT 1`,
  ).get(normaliseUrl(url)) as any;
  return row ? { checked_at: String(row.checked_at), status: row.status as IndexationStatus } : null;
}

export function recordCheck(
  db: DB,
  url: string,
  platform: string | null,
  provider: string | null,
  c: Classification,
  checkedAt: string = nowIso(),
): void {
  const key = normaliseUrl(url);
  // indexation_checks is deliberately a history table (migration 3 declares no
  // UNIQUE constraint — a URL's status over time is the point). Idempotency is
  // therefore enforced on its natural key, (url, checked_at): replaying the
  // same collection writes nothing new instead of duplicating a row.
  db.prepare(
    `INSERT INTO indexation_checks (url, platform, checked_at, status, evidence, provider, confidence, raw_hit_count)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM indexation_checks WHERE url = ? AND checked_at = ?
     )`,
  ).run(
    key,
    platform ?? null,
    checkedAt,
    c.status,
    c.evidence,
    provider ?? null,
    c.confidence,
    c.rawHitCount === null ? null : Math.trunc(c.rawHitCount),
    key,
    checkedAt,
  );
}

/** True when this URL was checked within `maxAgeDays` and should be skipped. */
export function isRecentlyChecked(db: DB, url: string, maxAgeDays: number, now: Date = new Date()): boolean {
  const last = lastCheck(db, url);
  if (!last) return false;
  const t = Date.parse(last.checked_at);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < maxAgeDays * 24 * 60 * 60 * 1000;
}

// ── Collector ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/**
 * Check a batch of published URLs and write indexation_checks rows.
 *
 * Degrades rather than throws:
 *   - flag off              -> no-op, {enabled:false}, nothing written
 *   - no SERP keys / all
 *     providers exhausted   -> every remaining URL recorded as 'unknown',
 *                              run finished as 'partial' (or 'failed' if
 *                              nothing at all could be checked)
 *   - one URL blowing up    -> that URL is 'unknown', the batch continues
 */
export async function checkIndexation(opts: CheckIndexationOptions): Promise<CheckIndexationSummary> {
  const empty: CheckIndexationSummary = {
    enabled: false, considered: 0, skippedRecent: 0, checked: 0,
    indexed: 0, notIndexed: 0, unknown: 0, runId: null,
  };
  if (!enabled('INDEXATION_CHECKS')) return empty;

  const {
    db,
    urls,
    limit = DEFAULT_LIMIT,
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    delayMs = DEFAULT_DELAY_MS,
    searcher = defaultSearcher,
  } = opts;

  const items = (urls ?? [])
    .map(u => (typeof u === 'string' ? { url: u, platform: null } : { url: u?.url, platform: u?.platform ?? null }))
    .filter(u => typeof u.url === 'string' && u.url.trim().length > 0) as Array<{ url: string; platform: string | null }>;

  const summary: CheckIndexationSummary = {
    enabled: true, considered: items.length, skippedRecent: 0, checked: 0,
    indexed: 0, notIndexed: 0, unknown: 0, runId: null,
  };

  const runId = startRun(db, 'indexation');
  summary.runId = runId;

  let rowsWritten = 0;
  let hardError: string | undefined;
  const seen = new Set<string>();

  try {
    for (const item of items) {
      if (summary.checked >= limit) break;

      const key = normaliseUrl(item.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      if (isRecentlyChecked(db, item.url, maxAgeDays)) {
        summary.skippedRecent++;
        continue;
      }

      let classification: Classification;
      let provider: string | null = null;

      try {
        const query = buildSiteQuery(item.url);
        if (!query) {
          classification = classifyIndexation(null, item.url);
        } else {
          const { response, provider: p } = await searcher(query);
          provider = p ?? null;
          classification = classifyIndexation(response, item.url);
        }
      } catch (err: any) {
        // Exhausted providers, timeouts, network failures: 'unknown', never
        // 'not_indexed'. The batch keeps going.
        classification = classifyIndexation(err instanceof Error ? err : new Error(String(err)), item.url);
        if (/exhaust/i.test(String(err?.message ?? ''))) hardError = sanitise(String(err.message));
      }

      try {
        recordCheck(db, item.url, item.platform, provider, classification);
        rowsWritten++;
      } catch (err: any) {
        hardError = sanitise(String(err?.message ?? err));
      }

      summary.checked++;
      if (classification.status === 'indexed') summary.indexed++;
      else if (classification.status === 'not_indexed') summary.notIndexed++;
      else summary.unknown++;

      if (summary.checked < limit) await sleep(delayMs);
    }

    const allUnknown = summary.checked > 0 && summary.unknown === summary.checked;
    const status: 'ok' | 'partial' | 'failed' =
      summary.checked === 0 ? (items.length ? 'partial' : 'ok')
        : allUnknown ? 'failed'
          : summary.unknown > 0 || hardError ? 'partial'
            : 'ok';

    finishRun(db, runId, status, rowsWritten, hardError);
  } catch (err: any) {
    // Should be unreachable; still never lose the run record.
    finishRun(db, runId, 'failed', rowsWritten, sanitise(String(err?.message ?? err)));
  }

  return summary;
}
