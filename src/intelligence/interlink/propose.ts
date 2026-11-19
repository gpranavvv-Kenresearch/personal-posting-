/**
 * interlink/propose.ts — interlink PROPOSAL generation.
 *
 * Answers: "where could an already-published post usefully link to another
 * kenresearch.com report?"
 *
 * NOTHING in this file changes anything outside the local database. Every
 * output is a row in `interlink_proposals` with status 'proposed'. A human
 * approves each one before the applier may touch a live page; that is the
 * whole point of splitting proposal from application.
 *
 * Design rules, mirroring the rest of the intelligence layer:
 *   - The decision logic is a set of PURE functions (relevanceScore,
 *     findBestParagraph, generateAnchorText). Persistence is a thin shell
 *     around them, so every judgement call is testable without a database and
 *     without a network.
 *   - 'unknown' indexation is NOT 'not_indexed'. An unknown is ranked BELOW a
 *     confirmed gap, never treated as one.
 *   - Source text is INJECTED (`fetchSourceText`). This module never fetches a
 *     page itself, which keeps it pure enough to test and makes it impossible
 *     for a test to hit a live API.
 *   - Limits come from weights.ts and are CONFIGURABLE SAFETY CONTROLS, not
 *     Google policy thresholds. See the note on enforcement below.
 */

import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { enabled } from '../flags.js';
import {
  loadInterlinkLimits, sanitiseInterlinkLimits, DEFAULT_THRESHOLDS,
  type InterlinkLimits, type Thresholds,
} from '../weights.js';
import { canApplyInterlinks, platformByName } from '../platforms.js';
import { slugOf } from '../urlMapping.js';

/**
 * Tag a destination URL with the UTM of the page the link will live ON
 * (the source post's platform), matching how every other outbound
 * kenresearch.com link on that platform is already tagged — see
 * src/utils/utm.ts. Without this, a click through a newly-inserted
 * interlink is indistinguishable in GA4 from direct/unknown traffic.
 *
 * Idempotent: strips any existing utm_* params first, so re-tagging (or a
 * destination that already carried one) never produces duplicates.
 */
export function tagDestinationUrl(url: string, sourcePlatform: string): string {
  const platform = platformByName(sourcePlatform);
  if (!platform) return url; // unknown platform: leave untouched rather than guess
  let [base, hash = ''] = url.split('#');
  hash = hash ? `#${hash}` : '';
  const [path, query = ''] = base.split('?');
  const kept = query
    .split('&')
    .filter((p) => p.length > 0 && !p.toLowerCase().startsWith('utm_'));
  kept.push(`utm_source=${platform.utmSource}`, 'utm_medium=referral', 'utm_campaign=automation');
  return `${path}?${kept.join('&')}${hash}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TOPIC RELEVANCE
//
// HONEST LIMITATION: this is shallow LEXICAL matching — token overlap, bigram
// overlap and slug-term matching. It has no semantic understanding whatsoever.
// It cannot tell that "hospital" and "healthcare facility" are the same topic,
// and it will happily score two unrelated reports highly because they share the
// words "market", "India" and "2030".
//
// That is a deliberate trade-off: no embeddings dependency, no model call, and
// a score anyone can recompute by hand from the text. The REAL relevance check
// is the human who reads the proposal before approving it. This score only
// decides what is worth putting in front of that human.
// ─────────────────────────────────────────────────────────────────────────────

export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'in', 'into', 'is',
  'it', 'its', 'of', 'on', 'or', 'our', 'out', 'over', 'per', 'so', 'such',
  'than', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this',
  'those', 'to', 'up', 'was', 'we', 'were', 'what', 'when', 'which', 'while',
  'who', 'why', 'will', 'with', 'would', 'you', 'your', 'about', 'after',
  'also', 'any', 'because', 'before', 'between', 'both', 'during', 'each',
  'more', 'most', 'not', 'other', 'report', 'reports',
]);

/** Crude suffix stripping. Not a real stemmer; just enough to match plurals. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string | null | undefined): string[] {
  return String(text ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1)
    .filter(t => !STOPWORDS.has(t))
    .map(stem)
    .filter(t => !STOPWORDS.has(t));
}

export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Fraction of the distinct `needles` that appear in `haystack`. */
function coverage(needles: string[], haystack: Set<string>): number {
  const distinct = [...new Set(needles)];
  if (!distinct.length) return 0;
  let hit = 0;
  for (const t of distinct) if (haystack.has(t)) hit++;
  return hit / distinct.length;
}

export const RELEVANCE_WEIGHTS = { unigram: 0.5, bigram: 0.3, slug: 0.2 } as const;

/**
 * 0..1 lexical relevance between a source page's text and a destination report.
 * Components that cannot be computed (empty title, no slug) are dropped and the
 * remaining weights renormalised — a missing component must not read as a zero.
 */
export function relevanceScore(
  sourceText: string | null | undefined,
  destinationTitle: string | null | undefined,
  destinationSlug: string | null | undefined = '',
): number {
  const src = tokenize(sourceText);
  if (!src.length) return 0;

  const dest = tokenize(destinationTitle);
  const slug = tokenize(String(destinationSlug ?? '').replace(/[-_/]+/g, ' '));
  if (!dest.length && !slug.length) return 0;

  const srcSet = new Set(src);
  const srcBigrams = new Set(bigrams(src));
  const destBigrams = bigrams(dest);

  const parts: Array<[number, number]> = [];
  if (dest.length) parts.push([coverage(dest, srcSet), RELEVANCE_WEIGHTS.unigram]);
  if (destBigrams.length) {
    const hit = [...new Set(destBigrams)].filter(b => srcBigrams.has(b)).length;
    parts.push([hit / new Set(destBigrams).size, RELEVANCE_WEIGHTS.bigram]);
  }
  if (slug.length) parts.push([coverage(slug, srcSet), RELEVANCE_WEIGHTS.slug]);

  const weightSum = parts.reduce((s, [, w]) => s + w, 0);
  if (weightSum === 0) return 0;
  return clamp01(parts.reduce((s, [v, w]) => s + v * w, 0) / weightSum);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PARAGRAPH SELECTION
// ─────────────────────────────────────────────────────────────────────────────

export interface DestinationRef {
  url: string;
  title?: string | null;
  slug?: string | null;
}

/**
 * At most this many pre-existing links may already sit in a paragraph before we
 * consider it "dense" and leave it alone. A safety control, not a policy limit.
 */
export const MAX_EXISTING_LINKS_PER_PARAGRAPH = 2;

/**
 * Split into paragraphs on blank lines, but NEVER inside a fenced code block.
 *
 * A naive blank-line split tears a fence apart, and the fragment after the
 * blank line no longer carries its opening ``` marker. Every downstream
 * "is this code?" check then says no, and a link could be inserted into
 * published source code. Keeping a fence whole is the only correct fix.
 */
function splitOnBlankLinesRespectingFences(text: string): string[] {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const joined = buf.join('\n');
    if (joined.trim().length > 0) out.push(joined);
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^\s*(```+|~~~+)/);
    if (m) {
      if (fence === null) {
        flush();
        fence = m[1][0];
        buf.push(line);
        continue;
      }
      if (m[1][0] === fence) {
        buf.push(line);
        fence = null;
        flush();
        continue;
      }
    }
    if (fence === null && line.trim() === '') { flush(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

export function splitParagraphs(text: string | null | undefined): string[] {
  return splitOnBlankLinesRespectingFences(String(text ?? '')).map(p => p.trim());
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function isHeading(paragraph: string): boolean {
  const p = paragraph.trim();
  if (/^#{1,6}\s/.test(p)) return true;
  if (/^<h[1-6][\s>]/i.test(p)) return true;
  // Setext heading: a line followed by ==== or ----
  if (/^[^\n]+\n[=-]{3,}\s*$/.test(p)) return true;
  return false;
}

export function isCodeBlock(paragraph: string): boolean {
  const p = paragraph.trim();
  if (p.startsWith('```') || p.startsWith('~~~')) return true;
  if (/^(?: {4}|\t)/.test(paragraph)) return true;
  if (/^<(pre|code)\b/i.test(p)) return true;
  return false;
}

export function isListItem(paragraph: string): boolean {
  const p = paragraph.trim();
  if (/^[-*+]\s/.test(p)) return true;
  if (/^\d+[.)]\s/.test(p)) return true;
  if (/^>\s?/.test(p)) return true;              // blockquote — also left alone
  if (/^<(ul|ol|li|table|blockquote)\b/i.test(p)) return true;
  return false;
}

/** Character ranges already occupied by a link, so an anchor never lands inside one. */
export function linkRanges(paragraph: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const patterns = [
    /\[[^\]]*\]\([^)]*\)/g,
    /<a\b[^>]*>[\s\S]*?<\/a>/gi,
    /https?:\/\/\S+/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(paragraph)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

export function countLinks(paragraph: string): number {
  const md = paragraph.match(/\[[^\]]*\]\([^)]*\)/g)?.length ?? 0;
  const html = paragraph.match(/<a\b[^>]*>/gi)?.length ?? 0;
  const stripped = paragraph.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/<a\b[\s\S]*?<\/a>/gi, ' ');
  const bare = stripped.match(/https?:\/\/\S+/g)?.length ?? 0;
  return md + html + bare;
}

/** Comparable form of a URL, for "does this text already link there?". */
export function linkKey(url: string | null | undefined): string {
  let s = String(url ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('#')[0].split('?')[0];
  return s.replace(/\/+$/, '');
}

export function containsLinkTo(text: string, destinationUrl: string): boolean {
  const key = linkKey(destinationUrl);
  if (!key) return false;
  const hay = String(text ?? '').toLowerCase().replace(/^https?:\/\//, '');
  return hay.replace(/https?:\/\//g, '').replace(/www\./g, '').includes(key);
}

export type ParagraphRejection =
  | 'too_short' | 'heading' | 'code_block' | 'list_item' | 'already_links' | 'link_dense';

export function paragraphRejection(
  paragraph: string,
  destination: DestinationRef,
  limits: InterlinkLimits = loadInterlinkLimits(),
): ParagraphRejection | null {
  if (isHeading(paragraph)) return 'heading';
  if (isCodeBlock(paragraph)) return 'code_block';
  if (isListItem(paragraph)) return 'list_item';
  if (wordCount(paragraph) < limits.minParagraphWords) return 'too_short';
  if (containsLinkTo(paragraph, destination.url)) return 'already_links';
  if (countLinks(paragraph) >= MAX_EXISTING_LINKS_PER_PARAGRAPH) return 'link_dense';
  return null;
}

export interface ParagraphPick {
  paragraph: string;
  /** Index within splitParagraphs(sourceText) — including the skipped ones. */
  index: number;
  score: number;
}

/**
 * The best paragraph in `sourceText` to host a link to `destination`, or null
 * when no paragraph is eligible. Ties go to the earlier paragraph.
 */
export function findBestParagraph(
  sourceText: string | null | undefined,
  destination: DestinationRef,
  limits: InterlinkLimits = loadInterlinkLimits(),
): ParagraphPick | null {
  const paragraphs = splitParagraphs(sourceText);
  let best: ParagraphPick | null = null;

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (paragraphRejection(p, destination, limits)) continue;
    const score = relevanceScore(p, destination.title ?? '', destination.slug ?? slugOf(destination.url));
    if (score <= 0) continue;
    if (!best || score > best.score) best = { paragraph: p, index: i, score };
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ANCHOR TEXT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anchors we refuse to emit. "Click here" tells a reader and a crawler nothing
 * about the destination, and an automated system producing them at scale is a
 * recognisable footprint.
 */
export const BANNED_ANCHORS = new Set([
  'click here', 'click', 'here', 'read more', 'read this', 'read on',
  'this report', 'the report', 'this article', 'the article', 'this post',
  'learn more', 'find out more', 'more info', 'more information',
  'link', 'this link', 'this', 'see more', 'full report', 'details',
  // Generic single words. True verbatim anchors, but they describe the shape of
  // the destination rather than its subject, so they are no better than "here".
  'article', 'post', 'page', 'content', 'study', 'guide', 'blog', 'document',
  'overview', 'summary', 'analysis', 'information', 'data', 'pdf', 'site',
]);

export const MAX_ANCHOR_WORDS = 8;
export const MAX_ANCHOR_CHARS = 80;

export type AnchorStrategy = 'verbatim' | 'descriptive';

export interface AnchorResult {
  anchor: string;
  strategy: AnchorStrategy;
  foundInParagraph: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimPunctuation(s: string): string {
  return s.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9)\]]+$/, '');
}

export function isBannedAnchor(anchor: string): boolean {
  const key = trimPunctuation(String(anchor ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
  return key.length === 0 || BANNED_ANCHORS.has(key);
}

/** Words of a title, punctuation stripped, empties dropped. */
function titleWords(title: string | null | undefined): string[] {
  return String(title ?? '')
    .replace(/[|–—:,;]/g, ' ')
    .split(/\s+/)
    .map(w => trimPunctuation(w))
    .filter(Boolean);
}

function overlapsLink(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => start < b && end > a);
}

function findPhrase(paragraph: string, words: string[], ranges: Array<[number, number]>): string | null {
  const pattern = words.map(escapeRegex).join('[\\s\\u00a0]+(?:the[\\s\\u00a0]+)?');
  const re = new RegExp(`(^|[^A-Za-z0-9])(${pattern})([^A-Za-z0-9]|$)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) {
    const start = m.index + m[1].length;
    const end = start + m[2].length;
    if (overlapsLink(start, end, ranges)) {
      re.lastIndex = start + 1;
      continue;
    }
    const matched = trimPunctuation(paragraph.slice(start, end));
    if (matched && matched.length <= MAX_ANCHOR_CHARS && !isBannedAnchor(matched)) return matched;
    re.lastIndex = start + 1;
  }
  return null;
}

/**
 * Prefer an anchor that ALREADY APPEARS in the paragraph: the link then reads
 * as part of the sentence someone wrote, rather than as an insertion.
 *
 * Falls back to a short descriptive phrase derived from the destination title.
 * Never returns "click here" / "read more" / "this report"; if the only thing
 * available is banned or empty, returns an empty anchor and the caller skips
 * the proposal entirely.
 */
export function generateAnchorText(
  paragraph: string,
  destinationTitle: string | null | undefined,
): AnchorResult {
  const text = String(paragraph ?? '');
  const words = titleWords(destinationTitle);
  // A destination whose whole title is a banned phrase gives us nothing to
  // describe it with. Mining a word out of "learn more" would technically be
  // verbatim and still be a useless anchor, so refuse outright.
  if (!words.length || isBannedAnchor(words.join(' '))) {
    return { anchor: '', strategy: 'descriptive', foundInParagraph: false };
  }
  const ranges = linkRanges(text);

  // Longest verbatim phrase first — a 4-word match is a better anchor than a
  // 2-word one, and a far better one than a single generic noun.
  const maxN = Math.min(MAX_ANCHOR_WORDS, words.length);
  for (let n = maxN; n >= 2; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const slice = words.slice(i, i + n);
      if (slice.join(' ').length > MAX_ANCHOR_CHARS) continue;
      if (isBannedAnchor(slice.join(' '))) continue;
      if (!slice.some(w => !STOPWORDS.has(w.toLowerCase()))) continue;
      const hit = findPhrase(text, slice, ranges);
      // Check the FINAL anchor, not the candidate slice: findPhrase returns the
      // text as it appears in the paragraph and trims punctuation, so a allowed
      // candidate like "learn more about" can come back as the banned "learn more".
      if (hit && !isBannedAnchor(hit)) return { anchor: hit, strategy: 'verbatim', foundInParagraph: true };
    }
  }

  // Single distinctive word, as a last verbatim resort.
  for (const w of words) {
    const lw = w.toLowerCase();
    if (lw.length < 5 || STOPWORDS.has(lw) || isBannedAnchor(lw)) continue;
    const hit = findPhrase(text, [w], ranges);
    if (hit && !isBannedAnchor(hit)) return { anchor: hit, strategy: 'verbatim', foundInParagraph: true };
  }

  // Descriptive fallback: a trimmed form of the destination title.
  let descriptive = words.slice(0, MAX_ANCHOR_WORDS).join(' ');
  while (descriptive.length > MAX_ANCHOR_CHARS && descriptive.includes(' ')) {
    descriptive = descriptive.slice(0, descriptive.lastIndexOf(' '));
  }
  descriptive = trimPunctuation(descriptive);
  // Truncation can itself produce a banned phrase (e.g. a title beginning
  // "Learn More About ..." trimmed down to "Learn More"), so the check must
  // happen on the final string. An empty anchor makes the caller skip the
  // proposal entirely, which is the right outcome.
  if (isBannedAnchor(descriptive)) return { anchor: '', strategy: 'descriptive', foundInParagraph: false };
  return { anchor: descriptive, strategy: 'descriptive', foundInParagraph: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SOURCE SELECTION
// ─────────────────────────────────────────────────────────────────────────────

export type IndexationStatus = 'indexed' | 'not_indexed' | 'unknown';

export interface SourceCandidate {
  publishedPostId: number;
  sourceUrl: string;
  platform: string;
  title: string | null;
  reportUrl: string | null;
  postedAt: string;
  indexation: IndexationStatus;
}

/**
 * Indexation ordering for SOURCES. A link from a page search engines have never
 * seen is worth very little, so confirmed-indexed sources come first. 'unknown'
 * sits in the middle: it is not evidence of a problem, only absence of evidence.
 */
const SOURCE_INDEX_RANK: Record<IndexationStatus, number> = {
  indexed: 0, unknown: 1, not_indexed: 2,
};

/**
 * Coerce anything that is not one of the three legal statuses to 'unknown'.
 *
 * The schema has a CHECK constraint on indexation_checks.status, so today the
 * database cannot hold anything else — but these functions are exported and a
 * later migration could add a status. The default must be 'unknown' in EVERY
 * reader, because the alternative is that a value we do not understand falls
 * through to the 'indexed' branch and reads as "this page is fine, leave it
 * alone". That is absence of evidence being recorded as evidence, which is the
 * exact failure this module claims not to make. Comparison is case-sensitive on
 * purpose: 'NOT_INDEXED' is not a confirmed gap, it is an unexpected value.
 */
export function normaliseIndexation(status: unknown): IndexationStatus {
  return status === 'indexed' || status === 'not_indexed' || status === 'unknown'
    ? status
    : 'unknown';
}

export function selectSources(opts: { db: DB; limit?: number }): SourceCandidate[] {
  const { db, limit = 100 } = opts;
  const rows = db.prepare(`
    SELECT p.id, p.published_url, p.platform, p.title, p.report_url, p.posted_at,
           (SELECT ic.status FROM indexation_checks ic
             WHERE ic.url = p.published_url
             ORDER BY ic.checked_at DESC LIMIT 1) AS indexation
      FROM published_posts p
     WHERE p.published_url IS NOT NULL AND TRIM(p.published_url) <> ''
     ORDER BY p.posted_at DESC
  `).all() as any[];

  const out: SourceCandidate[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const platform = String(r.platform ?? '');
    // Only platforms we could ever actually edit. 'unknown' is excluded exactly
    // as 'none' is — it must be proven editable, not presumed.
    if (!canApplyInterlinks(platform)) continue;
    const url = String(r.published_url);
    if (seen.has(url)) continue;
    seen.add(url);
    const status = normaliseIndexation(r.indexation);
    out.push({
      publishedPostId: Number(r.id),
      sourceUrl: url,
      platform,
      title: r.title ?? null,
      reportUrl: r.report_url ?? null,
      postedAt: String(r.posted_at ?? ''),
      indexation: status,
    });
  }

  out.sort((a, b) =>
    SOURCE_INDEX_RANK[a.indexation] - SOURCE_INDEX_RANK[b.indexation] ||
    b.postedAt.localeCompare(a.postedAt));
  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DESTINATION SELECTION
// ─────────────────────────────────────────────────────────────────────────────

export interface DestinationCandidate extends DestinationRef {
  url: string;
  title: string | null;
  slug: string;
  indexation: IndexationStatus;
  position: number | null;
  /** 0..1 — how much this destination needs help. Higher = bigger gap. */
  gap: number;
}

/**
 * How badly a destination needs an inbound link.
 *
 * THE STANDING RULE: 'unknown' is NOT 'not_indexed'. A confirmed gap outranks
 * an unknown; an unknown is merely a lower-priority candidate, never reported
 * or treated as a confirmed indexation failure.
 */
export function destinationGap(
  indexation: IndexationStatus,
  position: number | null,
  t: Thresholds = DEFAULT_THRESHOLDS,
): number {
  // Anything unrecognised becomes 'unknown' rather than falling through to the
  // 'indexed' branch below — see normaliseIndexation().
  const status = normaliseIndexation(indexation);
  if (status === 'not_indexed') return 1;
  if (status === 'unknown') return 0.5;
  // Indexed: the gap is now about rank, not visibility.
  if (position === null) return 0.2;
  if (position <= t.rankTopBand) return 0;          // already strong — leave it alone
  if (position <= t.rankMidBand) return 0.35;       // mid-page: the most upside
  return 0.25;                                      // far back: a link helps less
}

export function selectDestinations(opts: { db: DB; limit?: number; thresholds?: Thresholds }): DestinationCandidate[] {
  const { db, limit = 100, thresholds = DEFAULT_THRESHOLDS } = opts;
  const rows = db.prepare(`
    SELECT p.report_url AS url,
           MAX(p.title)  AS title,
           (SELECT ic.status FROM indexation_checks ic
             WHERE ic.url = p.report_url
             ORDER BY ic.checked_at DESC LIMIT 1) AS indexation,
           (SELECT AVG(up.position) FROM url_performance up
             WHERE up.url = p.report_url AND up.position IS NOT NULL
               AND up.metric_scope = 'url') AS position
      FROM published_posts p
     WHERE p.report_url IS NOT NULL AND TRIM(p.report_url) <> ''
     GROUP BY p.report_url
  `).all() as any[];

  const out: DestinationCandidate[] = [];
  for (const r of rows) {
    const indexation = normaliseIndexation(r.indexation);
    const position = r.position === null || r.position === undefined ? null : Number(r.position);
    const gap = destinationGap(indexation, position, thresholds);
    if (gap <= 0) continue;
    const url = String(r.url);
    out.push({
      url,
      title: r.title ?? null,
      slug: slugOf(url),
      indexation,
      position,
      gap,
    });
  }

  out.sort((a, b) => b.gap - a.gap || (b.position ?? 0) - (a.position ?? 0) || a.url.localeCompare(b.url));
  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────

/** Stable hash of a paragraph, so the applier can detect the page changed. */
export function paragraphHash(paragraph: string): string {
  const normalised = String(paragraph ?? '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 32);
}

export const EXCERPT_MAX_CHARS = 500;

export interface ProposalInput {
  sourceUrl: string;
  sourcePlatform?: string | null;
  destinationUrl: string;
  anchorText: string;
  paragraph: string;
  relevance: number;
  rationale?: string | null;
}

/**
 * Insert one proposal. Returns its id, or null when an identical
 * (source_url, destination_url, anchor_text) already exists — re-running must
 * never duplicate.
 */
export function insertProposal(db: DB, p: ProposalInput, now: string = nowIso()): number | null {
  const res = db.prepare(`
    INSERT OR IGNORE INTO interlink_proposals
      (source_url, source_platform, destination_url, anchor_text,
       paragraph_excerpt, paragraph_hash, relevance, rationale, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
  `).run(
    p.sourceUrl,
    p.sourcePlatform ?? null,
    p.destinationUrl,
    p.anchorText,
    p.paragraph.slice(0, EXCERPT_MAX_CHARS),
    paragraphHash(p.paragraph),
    p.relevance,
    p.rationale ?? null,
    now,
  );
  return Number(res.changes) > 0 ? Number(res.lastInsertRowid) : null;
}

/** Live proposals already attached to a source page (a rejected one does not count). */
export function activeProposalsForSource(db: DB, sourceUrl: string): number {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM interlink_proposals
     WHERE source_url = ? AND status IN ('proposed','approved','applied')
  `).get(sourceUrl) as any;
  return Number(r?.n ?? 0);
}

/**
 * Counts proposals since `sinceIso` targeting the SAME destination, by
 * linkKey (protocol/www/query/fragment-insensitive) rather than an exact
 * string match. destination_url is stored UTM-tagged per the source
 * platform (tagDestinationUrl), so two proposals to the same report from
 * different source platforms — or the same platform re-run after a query
 * string changed — store different exact strings but must still count
 * against the same weekly cap.
 */
export function proposalsForDestinationSince(db: DB, destinationUrl: string, sinceIso: string): number {
  const key = linkKey(destinationUrl);
  if (!key) return 0;
  const rows = db.prepare(`
    SELECT destination_url FROM interlink_proposals
     WHERE status <> 'rejected' AND created_at >= ?
  `).all(sinceIso) as Array<{ destination_url: string }>;
  return rows.filter(r => linkKey(r.destination_url) === key).length;
}

/**
 * When this source page was last changed by us: the most recent applied
 * interlink, or failing that the moment it was published. Both count as an
 * edit for cooldown purposes.
 */
export function lastEditOfSource(db: DB, sourceUrl: string): string | null {
  const r = db.prepare(`
    SELECT MAX(x) AS t FROM (
      SELECT MAX(applied_at) AS x FROM interlink_proposals
        WHERE source_url = ? AND applied_at IS NOT NULL
      UNION ALL
      SELECT MAX(posted_at) AS x FROM published_posts WHERE published_url = ?
    )
  `).get(sourceUrl, sourceUrl) as any;
  return r?.t ? String(r.t) : null;
}

function hoursBetween(laterIso: string, earlierIso: string): number {
  const a = Date.parse(laterIso);
  const b = Date.parse(earlierIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return (a - b) / 3_600_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6 + 7. The run
// ─────────────────────────────────────────────────────────────────────────────

export type SkipReason =
  | 'disabled' | 'no_source_text' | 'self_link' | 'already_linked'
  | 'no_paragraph' | 'low_relevance' | 'no_anchor' | 'anchor_not_in_paragraph'
  | 'duplicate'
  | 'source_cap' | 'destination_week_cap' | 'cooldown' | 'run_cap';

export interface GeneratedProposal {
  id: number;
  sourceUrl: string;
  sourcePlatform: string;
  destinationUrl: string;
  anchorText: string;
  anchorStrategy: AnchorStrategy;
  relevance: number;
  paragraphIndex: number;
  paragraphHash: string;
}

export interface GenerateResult {
  created: number;
  considered: number;
  skipped: Record<string, number>;
  proposals: GeneratedProposal[];
  limits: InterlinkLimits;
}

export interface GenerateOptions {
  db: DB;
  /** Upper bound on proposals created; never exceeds maxLinksAddedPerRun. */
  limit?: number;
  /**
   * Supplies the body text of a source page. INJECTED on purpose: this module
   * never performs network I/O, so a test can never hit a live API.
   */
  fetchSourceText: (source: SourceCandidate) => string | null | Promise<string | null>;
  now?: Date;
  limits?: InterlinkLimits;
  sourceLimit?: number;
  destinationLimit?: number;
}

/**
 * Generate interlink proposals.
 *
 * LIMITS are CONFIGURABLE SAFETY CONTROLS (see weights.ts), not Google policy
 * thresholds — no search engine publishes a number that makes N links safe and
 * N+1 unsafe. They exist so an automated system cannot do something drastic at
 * scale before a human notices. Every one of them is enforced here against the
 * data already in the database, so a restarted or repeated run cannot evade them.
 *
 * Gated by FEATURE_INTERLINKING_PROPOSALS (plus the master switch). With the
 * flag off this is a no-op that writes nothing.
 */
export async function generateProposals(opts: GenerateOptions): Promise<GenerateResult> {
  // Sanitise even a caller-supplied limits object: a limit that reads as NaN
  // makes every `>=` comparison false, which silently removes the cap.
  const limits = sanitiseInterlinkLimits(opts.limits ?? loadInterlinkLimits());
  const skipped: Record<string, number> = {};
  const bump = (r: SkipReason) => { skipped[r] = (skipped[r] ?? 0) + 1; };
  const empty = (): GenerateResult => ({ created: 0, considered: 0, skipped, proposals: [], limits });

  if (!enabled('INTERLINKING_PROPOSALS')) {
    bump('disabled');
    return empty();
  }

  const { db, fetchSourceText } = opts;
  const now = opts.now ?? new Date();
  const nowStr = now.toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
  // The explicit --limit may only TIGHTEN the configured cap, never raise it,
  // and a non-finite --limit (e.g. parseInt of a typo) is ignored rather than
  // allowed to poison Math.min into NaN and remove the cap altogether.
  const askedLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit)
    ? Math.max(0, Math.floor(opts.limit))
    : limits.maxLinksAddedPerRun;
  const runCap = Math.min(askedLimit, limits.maxLinksAddedPerRun);

  const sources = selectSources({ db, limit: opts.sourceLimit ?? 200 });
  const destinations = selectDestinations({ db, limit: opts.destinationLimit ?? 200 });

  const proposals: GeneratedProposal[] = [];
  let considered = 0;

  for (const source of sources) {
    if (proposals.length >= runCap) { bump('run_cap'); break; }

    // cooldownHours — do not pile edits onto a page we just touched.
    const lastEdit = lastEditOfSource(db, source.sourceUrl);
    if (lastEdit && hoursBetween(nowStr, lastEdit) < limits.cooldownHours) { bump('cooldown'); continue; }

    let perSource = activeProposalsForSource(db, source.sourceUrl);
    if (perSource >= limits.maxNewLinksPerSourcePage) { bump('source_cap'); continue; }

    const text = await fetchSourceText(source);
    if (!text || !text.trim()) { bump('no_source_text'); continue; }

    for (const dest of destinations) {
      if (proposals.length >= runCap) { bump('run_cap'); break; }
      if (perSource >= limits.maxNewLinksPerSourcePage) { bump('source_cap'); break; }

      considered++;

      // Two distinct ways a "self" link can arise, and both must be caught:
      //   - the destination IS the report this post was written to promote
      //     (linking a post back to its own subject adds nothing);
      //   - the destination IS this very page. That happens whenever a row's
      //     published_url coincides with some other row's report_url, and
      //     comparing only against reportUrl misses it entirely — the result
      //     is a page proposed a link to itself.
      const destKey = linkKey(dest.url);
      if (destKey === linkKey(source.reportUrl ?? '') || destKey === linkKey(source.sourceUrl)) {
        bump('self_link');
        continue;
      }
      if (containsLinkTo(text, dest.url)) { bump('already_linked'); continue; }

      if (proposalsForDestinationSince(db, dest.url, weekAgo) >= limits.maxLinksPerDestinationPerWeek) {
        bump('destination_week_cap');
        continue;
      }

      const pick = findBestParagraph(text, dest, limits);
      if (!pick) { bump('no_paragraph'); continue; }
      if (pick.score < limits.minRelevanceToPropose) { bump('low_relevance'); continue; }

      const anchor = generateAnchorText(pick.paragraph, dest.title ?? dest.slug);
      if (!anchor.anchor) { bump('no_anchor'); continue; }
      // A DESCRIPTIVE anchor is derived from the destination title and by
      // definition does not occur in the paragraph. apply.ts inserts a link by
      // wrapping an existing occurrence, so such a proposal can only ever be
      // refused as 'unsafe-insertion'. Generating it anyway would put something
      // in the approval queue that cannot be applied however the human votes —
      // review time spent on a guaranteed no-op. generateAnchorText keeps the
      // descriptive fallback (it is useful on its own, and tested directly);
      // the RUN declines to propose on it.
      if (!anchor.foundInParagraph) { bump('anchor_not_in_paragraph'); continue; }

      const rationale =
        `relevance ${pick.score.toFixed(2)} (lexical) · paragraph #${pick.index} · ` +
        `anchor ${anchor.strategy} · destination ${dest.indexation}` +
        (dest.position === null ? '' : ` · avg position ${dest.position.toFixed(1)}`);

      // Tagged with the SOURCE page's platform UTM — the click is attributed
      // to the page the link lives on, matching every other outbound link
      // that platform's posts carry. Duplicate/self-link checks above
      // deliberately used the untagged dest.url, so a query-string difference
      // never masks a real duplicate.
      const taggedDestinationUrl = tagDestinationUrl(dest.url, source.platform);

      const id = insertProposal(db, {
        sourceUrl: source.sourceUrl,
        sourcePlatform: source.platform,
        destinationUrl: taggedDestinationUrl,
        anchorText: anchor.anchor,
        paragraph: pick.paragraph,
        relevance: pick.score,
        rationale,
      }, nowStr);

      if (id === null) { bump('duplicate'); continue; }

      perSource++;
      proposals.push({
        id,
        sourceUrl: source.sourceUrl,
        sourcePlatform: source.platform,
        destinationUrl: taggedDestinationUrl,
        anchorText: anchor.anchor,
        anchorStrategy: anchor.strategy,
        relevance: pick.score,
        paragraphIndex: pick.index,
        paragraphHash: paragraphHash(pick.paragraph),
      });
    }
  }

  return { created: proposals.length, considered, skipped, proposals, limits };
}

/** Human-readable summary of a run, for the CLI / logs. */
export function formatProposalRun(result: GenerateResult): string {
  const lines: string[] = [];
  lines.push(`Interlink proposals: ${result.created} created from ${result.considered} source/destination pairs.`);
  lines.push('NOTHING is applied automatically — each proposal needs a human approval.');
  const reasons = Object.entries(result.skipped).sort((a, b) => b[1] - a[1]);
  if (reasons.length) lines.push(`Skipped: ${reasons.map(([r, n]) => `${r}=${n}`).join(', ')}`);
  for (const p of result.proposals) {
    lines.push(`  [${p.relevance.toFixed(2)}] ${p.sourceUrl} -> ${p.destinationUrl}  anchor="${p.anchorText}" (${p.anchorStrategy})`);
  }
  return lines.join('\n');
}
