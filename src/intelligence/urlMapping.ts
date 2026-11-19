/**
 * urlMapping.ts — tie a kenresearch.com report URL to the posts promoting it.
 *
 * Why this exists
 * ---------------
 * The automation publishes about one Ken Research report onto 30+ third-party
 * platforms. Nothing downstream — performance, indexation, platform stats,
 * lead attribution — can say anything useful until we know WHICH published
 * post promotes WHICH report. This module is that join table.
 *
 * It populates two tables (see schema.ts):
 *   published_posts — one row per thing we actually published, anywhere.
 *   url_mapping     — report_url <-> published_url, with HOW we know, so a
 *                     weak guess is never mistaken for a recorded fact.
 *
 * Four mapping methods, strongest first:
 *   'sheet'  the sheet row itself records the published URL, in a column whose
 *            header names the platform. Direct evidence.
 *   'utm'    the published URL carries utm_source=<platform>, confirming which
 *            platform it belongs to.
 *   'slug'   the report's slug appears in / overlaps the published URL. Weak:
 *            it is an inference, not a record.
 *   'manual' reserved for a human. NEVER produced by this module, and an
 *            existing manual row is never overwritten by an automatic one.
 *
 * Safety
 * ------
 *   - Gated by the intelligence master flag; a no-op when it is off.
 *   - The spreadsheet is read ONLY through guardSheetsClient(), so a
 *     development run can never read outside its locked tab.
 *   - Columns are resolved by HEADER NAME, never by fixed index.
 *   - Every run is bookkept via startRun/finishRun, including failures, so a
 *     missing credential shows up as a 'failed' run rather than a crash.
 *   - Idempotent: re-running upserts on the natural keys in schema.ts.
 */

import type { DB } from './db.js';
import { nowIso, startRun, finishRun } from './db.js';
import { enabled } from './flags.js';
import { MAIN_SHEET_ID, maskId } from '../config/sheetIds.js';
import { guardSheetsClient } from '../config/tabGuard.js';
import { platformByName } from './platforms.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type MappingMethod = 'sheet' | 'utm' | 'slug' | 'manual';

export interface Classification {
  method: MappingMethod;
  confidence: number;
  reason: string;
}

export interface PublishedUrlColumn {
  header: string;
  index: number;
  /** '' when the platform is not in the header but in a sibling cell. */
  platform: string;
  /**
   * Index of the column holding the platform NAME for this row, used by the
   * "slot" layout where the header is generic ("Blog URL 1") and the actual
   * platform varies per row ("Blog Platform 1" = HackMD, Blogger, ...).
   */
  platformColumn?: number;
  /** Index of the matching "Last Posted ..." column, if one exists. */
  postedAtColumn?: number;
}

export interface IngestResult {
  ok: boolean;
  runId: number | null;
  status: 'ok' | 'partial' | 'failed';
  rowsRead: number;
  postsUpserted: number;
  mappingsUpserted: number;
  skippedRows: number;
  reason?: string;
  warnings: string[];
}

/** Below this, a mapping is too weak to be worth recording at all. */
export const MIN_CONFIDENCE = 0.3;

// ── URL hygiene ──────────────────────────────────────────────────────────────

/** Query params that identify a campaign, not a page. Stripped on normalise. */
const TRACKING_PARAM = /^(utm_[a-z_]*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|ref|yclid|_ga)$/i;

/** Cell text that means "no URL here" even though the column is a URL column. */
const STATUS_WORDS = new Set([
  'error', 'failed', 'fail', 'failure', 'n/a', 'na', 'none', 'null', 'skipped',
  'skip', 'pending', 'retry', 'blocked', 'timeout', 'tbd', '-', '--', 'done',
  'posted', 'success', 'ok', 'true', 'false', 'yes', 'no',
]);

const URL_RE = /https?:\/\/[^\s|,"'<>\\\]]+/gi;

/** True when the whole cell is a status word rather than a URL. */
export function isStatusText(cellValue: string | null | undefined): boolean {
  const s = (cellValue ?? '').trim().toLowerCase();
  if (!s) return false;
  return s.split(/\s*\|\s*/).every(part => STATUS_WORDS.has(part.trim()));
}

/** Every raw http(s) substring in a cell, trailing punctuation trimmed. */
export function rawUrlsIn(cellValue: string | null | undefined): string[] {
  const s = (cellValue ?? '').trim();
  if (!s) return [];
  const out: string[] = [];
  for (const m of s.match(URL_RE) ?? []) {
    const cleaned = m.replace(/[)\]}>.,;:!?'"]+$/g, '');
    if (cleaned.length > 'https://'.length) out.push(cleaned);
  }
  return out;
}

/**
 * Canonical form of a URL: lowercase scheme+host, no fragment, no tracking
 * params, no trailing slash on a non-root path. Returns null for anything that
 * is not a usable absolute http(s) URL.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  s = s.replace(/[)\]}>.,;:!?'"]+$/g, '');
  if (!/^https?:\/\//i.test(s)) return null;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!u.hostname || !u.hostname.includes('.')) return null;

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString().replace(/\?$/, '');
}

/** The utm_source carried by a URL, lowercased. Read BEFORE normalising. */
export function utmSourceOf(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const v = new URL(s).searchParams.get('utm_source');
    return v ? v.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The report URL recorded in a cell. Prefers a kenresearch.com URL; a cell may
 * carry appended history ("a | b"), in which case the first report URL wins —
 * the row's subject does not change, only its posting history grows.
 */
export function extractReportUrl(cellValue: string | null | undefined): string | null {
  if (isStatusText(cellValue)) return null;
  const raws = rawUrlsIn(cellValue);
  if (raws.length === 0) return null;

  const normalized = raws.map(normalizeUrl).filter((u): u is string => Boolean(u));
  if (normalized.length === 0) return null;

  const ken = normalized.find(u => /(^|\.)kenresearch\.com$/i.test(safeHost(u)));
  return ken ?? normalized[0];
}

/**
 * Every published URL recorded in a cell, normalised and de-duplicated in
 * order of appearance. Cells commonly hold appended history separated by
 * " | " (see appendValue in src/sheets/sheets.ts), and commonly hold status
 * text such as ERROR or FAILED instead of a URL.
 */
export function extractPublishedUrls(cellValue: string | null | undefined): string[] {
  if (isStatusText(cellValue)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawUrlsIn(cellValue)) {
    const n = normalizeUrl(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// ── Slugs ────────────────────────────────────────────────────────────────────

/** Words so common in Ken Research slugs that they carry almost no signal. */
const GENERIC_SLUG_WORDS = new Set([
  'market', 'markets', 'report', 'reports', 'research', 'industry', 'analysis',
  'outlook', 'size', 'share', 'growth', 'trends', 'trend', 'forecast', 'global',
  'overview', 'study', 'the', 'and', 'for', 'with', 'ken',
]);

/**
 * The identifying slug of a URL: its last path segment, with a file extension
 * and any trailing hex post-id (Medium's "-a1b2c3d4e5") removed.
 */
export function slugOf(url: string | null | undefined): string {
  const n = normalizeUrl(url);
  if (!n) return '';
  let pathname: string;
  try {
    pathname = new URL(n).pathname;
  } catch {
    return '';
  }
  const segments = pathname.split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return '';

  let last = decodeURIComponent(segments[segments.length - 1]).toLowerCase();
  last = last.replace(/\.(html?|php|aspx?|md|pdf)$/i, '');
  last = last.replace(/-[0-9a-f]{8,}$/i, '');
  last = last.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return last;
}

function slugTokens(slug: string): string[] {
  return slug.split(/[^a-z0-9]+/i).map(t => t.toLowerCase()).filter(t => t.length >= 3);
}

/**
 * How strongly a published URL looks like it is about a given report, 0..1.
 *
 * 1.0 when the report's whole slug appears verbatim in the published URL.
 * Otherwise the share of the report's distinctive slug tokens that appear in
 * the published URL. Generic words ("market", "report") are ignored unless
 * that would leave nothing to compare.
 */
export function slugSimilarity(
  reportUrl: string | null | undefined,
  publishedUrl: string | null | undefined,
): number {
  const reportSlug = slugOf(reportUrl);
  const published = normalizeUrl(publishedUrl);
  if (!reportSlug || !published) return 0;

  const haystack = published.toLowerCase();
  if (reportSlug.length >= 8 && haystack.includes(reportSlug)) return 1;

  const all = slugTokens(reportSlug);
  if (all.length === 0) return 0;
  let tokens = all.filter(t => !GENERIC_SLUG_WORDS.has(t));
  if (tokens.length === 0) tokens = all;

  const publishedTokens = new Set(slugTokens(slugOf(published)).concat(
    haystack.split(/[^a-z0-9]+/).filter(t => t.length >= 3),
  ));

  const hits = tokens.filter(t => publishedTokens.has(t)).length;
  return Number((hits / tokens.length).toFixed(4));
}

// ── Classification ───────────────────────────────────────────────────────────

export interface ClassifyOptions {
  /** The sheet row recorded this URL in a platform-named column. */
  fromSheetColumn?: boolean;
  /** The platform that column (or caller) claims. Compared to utm_source. */
  platform?: string;
}

/**
 * Decide how we know a published URL belongs to a report, and how sure we are.
 *
 * Never returns 'manual' — that method is reserved for human-entered rows and
 * is produced only by recordManualMapping().
 */
export function classifyMapping(
  reportUrl: string | null | undefined,
  publishedUrl: string | null | undefined,
  opts: ClassifyOptions = {},
): Classification {
  const report = normalizeUrl(reportUrl);
  const published = normalizeUrl(publishedUrl);

  if (!report || !published) {
    return { method: 'slug', confidence: 0, reason: 'unusable url' };
  }

  const utm = utmSourceOf(publishedUrl);
  const claimed = opts.platform ? normalizePlatform(opts.platform) : null;
  const utmAgrees = Boolean(utm && claimed && normalizePlatform(utm) === claimed);

  if (opts.fromSheetColumn) {
    // The row itself records this URL under a platform-named column. That is
    // the strongest evidence available; a matching utm_source raises it further.
    return {
      method: 'sheet',
      confidence: utmAgrees ? 0.99 : 0.95,
      reason: utmAgrees ? 'sheet column, utm_source agrees' : 'recorded in a platform sheet column',
    };
  }

  if (utm) {
    return {
      method: 'utm',
      confidence: claimed ? (utmAgrees ? 0.85 : 0.5) : 0.8,
      reason: utmAgrees
        ? `utm_source=${utm} matches the claimed platform`
        : claimed
          ? `utm_source=${utm} contradicts claimed platform ${claimed}`
          : `utm_source=${utm}`,
    };
  }

  const sim = slugSimilarity(report, published);
  return {
    method: 'slug',
    // Slug evidence is inference. Cap it well below a recorded fact so a
    // coincidence can never outrank the sheet.
    confidence: Number(Math.min(0.7, 0.3 + sim * 0.4).toFixed(4)),
    reason: `slug similarity ${sim}`,
  };
}

// ── Platform naming ──────────────────────────────────────────────────────────

const PLATFORM_ALIASES: Record<string, string> = {
  fb: 'facebook',
  li: 'linkedin',
  'linked in': 'linkedin',
  twitter: 'x',
  'google site': 'googlesites',
  'google sites': 'googlesites',
  googlesite: 'googlesites',
  'dev.to': 'devto',
  'dev to': 'devto',
  'linkedin pulse': 'linkedin-pulse',
  'linkedinpulse': 'linkedin-pulse',
  'word press': 'wordpress',
  'hack md': 'hackmd',
};

/** Canonical, lowercase, utm-style platform name. */
export function normalizePlatform(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return '';
  if (PLATFORM_ALIASES[s]) return PLATFORM_ALIASES[s];
  const squashed = s.replace(/[^a-z0-9.-]+/g, '');
  return PLATFORM_ALIASES[squashed] ?? squashed;
}

/** The platform a "<Platform> Post URL" header refers to, or '' if not one. */
export function platformFromHeader(header: string | null | undefined): string {
  const h = (header ?? '').trim();
  if (!h) return '';
  if (!isPublishedUrlHeader(h)) return '';
  const stripped = h.replace(/\s*(post\s*)?url\s*$/i, '').trim();
  return normalizePlatform(stripped);
}

function isPublishedUrlHeader(header: string): boolean {
  const h = header.trim().toLowerCase();
  if (!/url\s*$/.test(h)) return false;
  // "Download Report URL", "Cover Image URL", "Target URL", "Report URL 2" are
  // inputs or assets, never somewhere we published.
  if (/download|image|target|^report url|^url$/.test(h)) return false;
  if (/post\s*url$/.test(h) || /pulse\s*url$/.test(h)) return true;

  // Not every column follows "<Platform> Post URL". src/sheets/sheets.ts also
  // writes bare "<Platform> URL" headers — Instapaper URL, Raindrop URL,
  // Pearltrees URL, PdfHost URL, 4shared URL, Scribd URL, Mastodon URL. Those
  // are real published-URL columns and were previously invisible to the
  // mapper, so those platforms could never be measured.
  //
  // The whole remainder must be a platform the registry knows, which is what
  // keeps "LinkedIn Profile URL" or "Images URL" out.
  const stripped = h.replace(/\s*url\s*$/i, '').trim();
  if (!stripped) return false;
  return Boolean(platformByName(normalizePlatform(stripped)));
}

// ── Header mapping (by NAME, never by index) ─────────────────────────────────

export function headerIndex(headers: string[], ...names: string[]): number | undefined {
  const lower = headers.map(h => (h ?? '').trim().toLowerCase());
  for (const n of names) {
    const i = lower.indexOf(n.trim().toLowerCase());
    if (i !== -1) return i;
  }
  return undefined;
}

export function findReportUrlColumn(headers: string[]): number | undefined {
  return headerIndex(headers, 'Report URL', 'Target URL', 'targetUrl', 'target_url', 'Report Url');
}

/**
 * "Slot" columns: a generic URL header whose platform lives in a sibling cell.
 *
 * The New Logic tab — the main blog-posting path, covering 14 platforms through
 * 3 shared slots — is laid out as:
 *     Blog Platform 1 | Blog URL 1 | Blog Platform 2 | Blog URL 2 | ...
 * The header "Blog URL 1" names no platform, so header-based detection skipped
 * it entirely and almost the whole blog estate was invisible to measurement:
 * a 9,774-row tab yielded 18 mappings, all from two unrelated columns.
 *
 * Pairing is by the trailing slot number, so "Blog URL 2" binds to
 * "Blog Platform 2" and to "Last Posted Blog Platform 2".
 */
export function findSlotUrlColumns(headers: string[]): PublishedUrlColumn[] {
  const norm = headers.map(h => (h ?? '').trim());
  const out: PublishedUrlColumn[] = [];

  norm.forEach((header, index) => {
    const m = header.match(/^(.*?)\s*url\s*(\d+)$/i);
    if (!m) return;
    const prefix = m[1].trim();
    const slot = m[2];
    if (!prefix) return;

    // Compare on a collapsed, lower-cased form instead of building a regex out
    // of the prefix — the prefix comes from a spreadsheet header and may hold
    // any characters at all.
    const flat = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    const wantPlatform = flat(`${prefix} platform ${slot}`);
    const wantPosted = flat(`last posted ${prefix} platform ${slot}`);

    const platformColumn = norm.findIndex(h => flat(h) === wantPlatform);
    if (platformColumn === -1) return;

    const postedAtColumn = norm.findIndex(h => flat(h) === wantPosted);

    out.push({
      header, index, platform: '',
      platformColumn,
      postedAtColumn: postedAtColumn === -1 ? undefined : postedAtColumn,
    });
  });

  return out;
}

export function findPublishedUrlColumns(headers: string[]): PublishedUrlColumn[] {
  const out: PublishedUrlColumn[] = [];
  headers.forEach((raw, index) => {
    const header = (raw ?? '').trim();
    const platform = platformFromHeader(header);
    if (platform) out.push({ header, index, platform });
  });
  // Slot columns carry no platform in the header; resolved per row.
  for (const slot of findSlotUrlColumns(headers)) {
    if (!out.some(c => c.index === slot.index)) out.push(slot);
  }
  return out.sort((a, b) => a.index - b.index);
}

/** "Last Posted <Platform>" column for a platform, if the sheet has one. */
export function findLastPostedColumn(headers: string[], platform: string): number | undefined {
  const want = normalizePlatform(platform);
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] ?? '').trim();
    if (!/^last\s*posted/i.test(h)) continue;
    if (normalizePlatform(h.replace(/^last\s*posted/i, '')) === want) return i;
  }
  return undefined;
}

/** Most recent value of an appended "a | b | c" cell. */
export function latestOf(cellValue: string | null | undefined): string {
  const parts = (cellValue ?? '').split(' | ').map(p => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Best-effort ISO-8601 UTC timestamp from a sheet date cell. */
export function toIsoTimestamp(cellValue: string | null | undefined, fallback: string = nowIso()): string {
  const v = latestOf(cellValue);
  if (!v) return fallback;
  const dateOnly = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${v}T00:00:00.000Z`;
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}

// ── Upserts ──────────────────────────────────────────────────────────────────

export interface PostRecord {
  reportUrl: string;
  platform: string;
  publishedUrl: string;
  account?: string | null;
  postedAt: string;
  sheetTab?: string | null;
  sheetRow?: number | null;
  title?: string | null;
  utmSource?: string | null;
}

/** Insert-or-update one published post on its natural key (platform, url). */
export function upsertPublishedPost(db: DB, rec: PostRecord): void {
  db.prepare(`
    INSERT INTO published_posts
      (report_url, platform, published_url, account, posted_at, sheet_tab, sheet_row, title, utm_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, published_url) DO UPDATE SET
      report_url = excluded.report_url,
      account    = COALESCE(excluded.account, published_posts.account),
      posted_at  = MIN(published_posts.posted_at, excluded.posted_at),
      sheet_tab  = COALESCE(excluded.sheet_tab, published_posts.sheet_tab),
      sheet_row  = COALESCE(excluded.sheet_row, published_posts.sheet_row),
      title      = COALESCE(excluded.title, published_posts.title),
      utm_source = COALESCE(excluded.utm_source, published_posts.utm_source)
  `).run(
    rec.reportUrl,
    rec.platform,
    rec.publishedUrl,
    rec.account ?? null,
    rec.postedAt,
    rec.sheetTab ?? null,
    rec.sheetRow ?? null,
    rec.title ?? null,
    rec.utmSource ?? null,
    nowIso(),
  );
}

/**
 * Insert-or-update a mapping. Never downgrades: an existing row is replaced
 * only by evidence at least as strong, and a 'manual' row is never touched.
 */
export function upsertMapping(
  db: DB,
  reportUrl: string,
  publishedUrl: string,
  platform: string | null,
  cls: Classification,
): void {
  db.prepare(`
    INSERT INTO url_mapping (report_url, published_url, platform, method, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_url, published_url) DO UPDATE SET
      platform   = COALESCE(excluded.platform, url_mapping.platform),
      method     = excluded.method,
      confidence = excluded.confidence
    WHERE url_mapping.method <> 'manual'
      AND excluded.confidence >= url_mapping.confidence
  `).run(reportUrl, publishedUrl, platform, cls.method, cls.confidence, nowIso());
}

/**
 * The only producer of method='manual'. A human mapping outranks everything
 * and is never overwritten by a collector.
 */
export function recordManualMapping(
  db: DB,
  reportUrl: string,
  publishedUrl: string,
  platform?: string,
): void {
  const report = normalizeUrl(reportUrl);
  const published = normalizeUrl(publishedUrl);
  if (!report || !published) throw new Error('[urlMapping] recordManualMapping needs two absolute http(s) URLs');
  db.prepare(`
    INSERT INTO url_mapping (report_url, published_url, platform, method, confidence, created_at)
    VALUES (?, ?, ?, 'manual', 1.0, ?)
    ON CONFLICT(report_url, published_url) DO UPDATE SET
      platform   = COALESCE(excluded.platform, url_mapping.platform),
      method     = 'manual',
      confidence = 1.0
  `).run(report, published, platform ? normalizePlatform(platform) : null, nowIso());
}

// ── Row -> records (pure, and the heart of the ingest) ───────────────────────

export interface RowPlan {
  posts: PostRecord[];
  mappings: Array<{ reportUrl: string; publishedUrl: string; platform: string; cls: Classification }>;
  skipped: boolean;
  reason?: string;
}

/**
 * Turn one spreadsheet row into the rows we would write. Pure: no database,
 * no network — which is what makes the messy-reality cases testable.
 */
export function planRow(
  headers: string[],
  row: string[],
  opts: { sheetTab?: string; sheetRow?: number } = {},
): RowPlan {
  const cell = (i: number | undefined): string => (i === undefined ? '' : (row[i] ?? ''));

  const reportIdx = findReportUrlColumn(headers);
  const reportUrl = extractReportUrl(cell(reportIdx));
  if (!reportUrl) return { posts: [], mappings: [], skipped: true, reason: 'no report url' };

  const title = cell(headerIndex(headers, 'Title', 'title')).trim() || null;
  const account = cell(headerIndex(headers, 'New Name', 'Name', 'name')).trim() || null;
  const fallbackDate = cell(headerIndex(headers, 'Date', 'date'));

  const posts: PostRecord[] = [];
  const mappings: RowPlan['mappings'] = [];
  const seen = new Set<string>();

  for (const colInfo of findPublishedUrlColumns(headers)) {
    const value = cell(colInfo.index);
    if (!value.trim() || isStatusText(value)) continue;

    // Slot layout: the platform is in a sibling cell on THIS row, not in the
    // header. A row whose platform cell is blank tells us nothing about where
    // the url was published, so it is skipped rather than guessed at.
    let rowPlatform = colInfo.platform;
    if (!rowPlatform && colInfo.platformColumn !== undefined) {
      const named = latestOf(cell(colInfo.platformColumn)).trim();
      if (!named || isStatusText(named)) continue;
      rowPlatform = normalizePlatform(named);
      if (!rowPlatform) continue;
    }
    if (!rowPlatform) continue;

    const raws = rawUrlsIn(value);
    for (const raw of raws) {
      const published = normalizeUrl(raw);
      if (!published) continue;
      const key = `${colInfo.platform}\u0000${published}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cls = classifyMapping(reportUrl, raw, {
        fromSheetColumn: true,
        platform: rowPlatform,
      });
      if (cls.confidence < MIN_CONFIDENCE) continue;

      const lastPostedIdx = colInfo.postedAtColumn ?? findLastPostedColumn(headers, rowPlatform);
      const postedAt = toIsoTimestamp(
        cell(lastPostedIdx) || fallbackDate,
        nowIso(),
      );

      posts.push({
        reportUrl,
        platform: rowPlatform,
        publishedUrl: published,
        account,
        postedAt,
        sheetTab: opts.sheetTab ?? null,
        sheetRow: opts.sheetRow ?? null,
        title,
        utmSource: utmSourceOf(raw) ?? colInfo.platform,
      });
      mappings.push({ reportUrl, publishedUrl: published, platform: colInfo.platform, cls });
    }
  }

  return { posts, mappings, skipped: posts.length === 0, reason: posts.length ? undefined : 'no published urls' };
}

// ── Sheet access (guarded) ───────────────────────────────────────────────────

/**
 * A Sheets client scoped to the spreadsheets scope and wrapped by the tab
 * guard. Returns null — never throws — when no credential is configured, so a
 * caller can degrade instead of dying.
 */
export async function getGuardedSheetsClient(): Promise<any | null> {
  try {
    const { google } = await import('googleapis');
    let credentials: object;

    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else {
      const fs = (await import('fs')).default;
      const raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
      credentials = JSON.parse(raw);
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      // Read-only is all this module ever needs. It writes nothing back.
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    return guardSheetsClient(google.sheets({ version: 'v4', auth }) as any);
  } catch {
    return null;
  }
}

async function readTabRows(tab: string, client?: any): Promise<string[][]> {
  const sheets = client ?? (await getGuardedSheetsClient());
  if (!sheets) throw new Error('no-credentials');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: MAIN_SHEET_ID,
    range: `${tab}!A:BZ`,
  });
  return (res?.data?.values ?? []) as string[][];
}

// ── The collector ────────────────────────────────────────────────────────────

/** The main sheet's default tab, matching SOCIAL_SHEET_NAME in sheets.ts. */
export const DEFAULT_TAB = 'Social Media';

export interface IngestOptions {
  db: DB;
  /**
   * Sheet tab to read, e.g. 'Social Media' or 'Blogs'. Optional: a caller that
   * omits it gets DEFAULT_TAB, which is the same tab the rest of the codebase
   * treats as the main sheet's default (SOCIAL_SHEET_NAME in sheets.ts). A
   * blank tab would otherwise become the range "undefined!A:BZ".
   */
  tab?: string;
  /** Maximum data rows to process. */
  limit?: number;
  /** Injected for tests — bypasses all network access. */
  readRows?: () => Promise<string[][]>;
  /** Pre-built Sheets client (already guarded). */
  client?: any;
  /** Run even when the intelligence flag is off (CLI / tests). */
  force?: boolean;
}

/**
 * Read a sheet tab and upsert published_posts + url_mapping.
 *
 * Degradation, in order of severity:
 *   flag off          -> returns ok:true, nothing read, nothing written.
 *   no credential     -> run recorded 'failed', reason 'no-credentials', no throw.
 *   sheet unreadable  -> run recorded 'failed' with the API message, no throw.
 *   a bad row         -> that row is counted as skipped; the batch continues
 *                        and the run finishes 'partial'.
 *
 * Idempotent: running twice over the same rows updates in place.
 */
export async function ingestFromSheet(opts: IngestOptions): Promise<IngestResult> {
  const { db } = opts;
  const tab = (opts.tab ?? '').trim() || DEFAULT_TAB;
  const limit = opts.limit ?? Infinity;

  const base: IngestResult = {
    ok: true, runId: null, status: 'ok', rowsRead: 0,
    postsUpserted: 0, mappingsUpserted: 0, skippedRows: 0, warnings: [],
  };

  if (!opts.force && !enabled('INTELLIGENCE_ENABLED')) {
    return { ...base, reason: 'intelligence disabled (FEATURE_INTELLIGENCE)' };
  }

  const runId = startRun(db, `urlMapping:${tab}`);

  let rows: string[][];
  try {
    rows = opts.readRows ? await opts.readRows() : await readTabRows(tab, opts.client);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const reason = msg === 'no-credentials'
      ? 'no Google service-account credential (.accounts/google-service-account.json or GOOGLE_SERVICE_ACCOUNT_JSON)'
      : `sheet read failed: ${msg}`;
    finishRun(db, runId, 'failed', 0, reason);
    return { ...base, ok: false, runId, status: 'failed', reason };
  }

  if (rows.length < 2) {
    finishRun(db, runId, 'ok', 0, undefined);
    return { ...base, runId, reason: `tab "${tab}" has no data rows (sheet ${maskId(MAIN_SHEET_ID)})` };
  }

  const headers = (rows[0] ?? []).map(h => String(h ?? ''));
  const warnings: string[] = [];
  if (findReportUrlColumn(headers) === undefined) {
    const reason = `tab "${tab}" has no report-URL column (looked for Report URL / Target URL / targetUrl)`;
    finishRun(db, runId, 'failed', 0, reason);
    return { ...base, ok: false, runId, status: 'failed', reason };
  }
  if (findPublishedUrlColumns(headers).length === 0) {
    warnings.push(`tab "${tab}" has no "<Platform> Post URL" columns — nothing to map`);
  }

  let posts = 0;
  let mappings = 0;
  let skipped = 0;
  let rowErrors = 0;

  const dataRows = rows.slice(1, 1 + (limit === Infinity ? rows.length : limit));

  for (let i = 0; i < dataRows.length; i++) {
    const sheetRow = i + 2; // 1-based, header is row 1
    try {
      const plan = planRow(headers, dataRows[i] ?? [], { sheetTab: tab, sheetRow });
      if (plan.skipped) { skipped++; continue; }

      // One row = one transaction. A single bad row can never roll back the
      // work already banked for earlier rows.
      db.exec('BEGIN');
      try {
        for (const p of plan.posts) { upsertPublishedPost(db, p); posts++; }
        for (const m of plan.mappings) {
          upsertMapping(db, m.reportUrl, m.publishedUrl, m.platform, m.cls);
          mappings++;
        }
        db.exec('COMMIT');
      } catch (inner) {
        db.exec('ROLLBACK');
        throw inner;
      }
    } catch (err: any) {
      rowErrors++;
      skipped++;
      if (warnings.length < 20) warnings.push(`row ${sheetRow}: ${String(err?.message ?? err)}`);
    }
  }

  const status: 'ok' | 'partial' = rowErrors > 0 ? 'partial' : 'ok';
  finishRun(db, runId, status, posts + mappings, rowErrors ? `${rowErrors} row(s) failed` : undefined);

  return {
    ok: true,
    runId,
    status,
    rowsRead: dataRows.length,
    postsUpserted: posts,
    mappingsUpserted: mappings,
    skippedRows: skipped,
    warnings,
  };
}

// ── Queries the rest of the intelligence layer will use ──────────────────────

/** Published URLs believed to promote a report, strongest evidence first. */
export function postsForReport(db: DB, reportUrl: string, minConfidence = MIN_CONFIDENCE): Array<{
  published_url: string; platform: string | null; method: string; confidence: number;
}> {
  const n = normalizeUrl(reportUrl) ?? reportUrl;
  return db.prepare(`
    SELECT published_url, platform, method, confidence
    FROM url_mapping
    WHERE report_url = ? AND confidence >= ?
    ORDER BY confidence DESC, published_url
  `).all(n, minConfidence) as any[];
}

/** The report a published URL promotes, by strongest evidence. */
export function reportForPost(db: DB, publishedUrl: string): string | null {
  const n = normalizeUrl(publishedUrl) ?? publishedUrl;
  const row = db.prepare(`
    SELECT report_url FROM url_mapping
    WHERE published_url = ?
    ORDER BY confidence DESC LIMIT 1
  `).get(n) as any;
  return row?.report_url ?? null;
}

/** Counts by method — the honest answer to "how much of this do we know?". */
export function mappingCoverage(db: DB): Record<string, number> {
  const rows = db.prepare(
    'SELECT method, COUNT(*) AS n FROM url_mapping GROUP BY method',
  ).all() as any[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.method as string] = Number(r.n);
  return out;
}
