/**
 * contentIntelligence.ts — which content characteristics correlate with results.
 *
 * Extracts measurable features from published content (length, structure,
 * links, title shape) and relates them to traffic and leads.
 *
 * A deliberate warning that is baked into the output rather than left implicit:
 * this module measures CORRELATION on observational data. It cannot establish
 * that longer posts cause more traffic; it can only report that, among what we
 * published, longer posts had more. Acting on that is a judgement call, which
 * is why `interpretation` always carries the sample size and the caveat.
 */

import type { DB } from './db.js';
import { nowIso, daysAgo } from './db.js';
import { enabled } from './flags.js';

export interface ContentFeatures {
  wordCount: number;
  headingCount: number;
  linkCount: number;
  imageCount: number;
  titleLength: number;
  hasNumberInTitle: boolean;
  /** Flesch reading ease, approximate. Higher = easier. */
  readability: number;
}

const WORD_RE = /[A-Za-z0-9'-]+/g;

export function stripHtml(html: string): string {
  return (html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text: string): number {
  const m = (text ?? '').match(WORD_RE);
  return m ? m.length : 0;
}

export function countSyllables(word: string): number {
  const w = (word ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '')
    .match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

/**
 * Flesch reading ease. Approximate by design — we need a comparable number
 * across thousands of posts, not a linguistically exact one.
 */
export function fleschReadingEase(text: string): number {
  const clean = (text ?? '').trim();
  if (!clean) return 0;
  const sentences = Math.max(1, (clean.match(/[.!?]+(\s|$)/g) ?? []).length);
  const words = clean.match(WORD_RE) ?? [];
  if (!words.length) return 0;
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length);
  return Math.round(score * 10) / 10;
}

export function extractFeatures(opts: { html?: string; text?: string; title?: string }): ContentFeatures {
  const html = opts.html ?? '';
  const text = opts.text ?? stripHtml(html);
  const title = opts.title ?? '';

  const headingCount = html
    ? (html.match(/<h[1-6][\s>]/gi) ?? []).length
    : (text.match(/^#{1,6}\s/gm) ?? []).length;

  const linkCount = html
    ? (html.match(/<a\s[^>]*href=/gi) ?? []).length
    // (?<!!) so that an image "![alt](url)" is not also counted as a link —
    // the image syntax contains the link syntax.
    : (text.match(/(?<!!)\[[^\]]*\]\([^)]+\)/g) ?? []).length;

  const imageCount = html
    ? (html.match(/<img\s/gi) ?? []).length
    : (text.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length;

  return {
    wordCount: countWords(text),
    headingCount,
    linkCount,
    imageCount,
    titleLength: title.length,
    hasNumberInTitle: /\d/.test(title),
    readability: fleschReadingEase(text),
  };
}

// ── Correlation ──────────────────────────────────────────────────────────────

/**
 * Pearson correlation. Returns null when it would be meaningless: fewer than
 * `minN` pairs, or zero variance in either series (e.g. every post has the
 * same word count), where the formula divides by zero.
 */
export function pearson(xs: number[], ys: number[], minN = 10): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < minN) return null;

  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;

  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export function describeCorrelation(r: number | null, n: number): string {
  if (r === null) return `not enough data (n=${n})`;
  const a = Math.abs(r);
  const strength = a < 0.1 ? 'negligible' : a < 0.3 ? 'weak' : a < 0.5 ? 'moderate' : 'strong';
  const dir = r > 0 ? 'positive' : 'negative';
  return `${strength} ${dir} (r=${r.toFixed(2)}, n=${n})`;
}

export interface FeatureCorrelation {
  feature: string;
  outcome: 'sessions' | 'clicks' | 'leads';
  r: number | null;
  n: number;
  interpretation: string;
}

const FEATURE_COLUMNS = [
  'word_count', 'heading_count', 'link_count', 'image_count',
  'title_length', 'readability',
] as const;

const OUTCOME_COLUMNS = {
  sessions: 'sessions_30d',
  clicks: 'clicks_30d',
  leads: 'leads_30d',
} as const;

export function correlateFeatures(db: DB, minN = 10): FeatureCorrelation[] {
  const rows = db.prepare(
    `SELECT word_count, heading_count, link_count, image_count, title_length,
            readability, sessions_30d, clicks_30d, leads_30d
       FROM content_stats`
  ).all() as any[];

  const out: FeatureCorrelation[] = [];

  for (const feature of FEATURE_COLUMNS) {
    for (const [outcome, col] of Object.entries(OUTCOME_COLUMNS) as [keyof typeof OUTCOME_COLUMNS, string][]) {
      const pairs = rows
        .filter(r => r[feature] !== null && r[feature] !== undefined && r[col] !== null && r[col] !== undefined)
        .map(r => [Number(r[feature]), Number(r[col])] as const);

      const r = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]), minN);
      out.push({
        feature,
        outcome,
        r,
        n: pairs.length,
        interpretation: describeCorrelation(r, pairs.length),
      });
    }
  }

  return out.sort((a, b) => Math.abs(b.r ?? 0) - Math.abs(a.r ?? 0));
}

export function saveContentStats(
  db: DB,
  entry: { url: string; platform?: string; publishedPostId?: number; features: ContentFeatures },
): number {
  const f = entry.features;
  const r = db.prepare(
    `INSERT INTO content_stats
       (published_post_id, url, platform, word_count, heading_count, link_count,
        image_count, title_length, has_number_in_title, readability, computed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    entry.publishedPostId ?? null, entry.url, entry.platform ?? null,
    f.wordCount, f.headingCount, f.linkCount, f.imageCount, f.titleLength,
    f.hasNumberInTitle ? 1 : 0, f.readability, nowIso(),
  );
  return Number(r.lastInsertRowid);
}

/**
 * Backfill the 30-day outcome columns from url_performance and leads, so the
 * correlation has something to correlate against.
 */
export function refreshOutcomes(db: DB, windowDays = 30): number {
  const since = daysAgo(windowDays);
  const rows = db.prepare('SELECT id, url FROM content_stats').all() as any[];
  let updated = 0;

  for (const row of rows) {
    const perf = db.prepare(
      `SELECT SUM(sessions) AS sessions, SUM(clicks) AS clicks
         FROM url_performance WHERE url = ? AND metric_date >= ?`
    ).get(row.url, since) as any;

    const leads = db.prepare(
      `SELECT COUNT(*) AS c FROM leads WHERE landing_url = ? AND created_at >= ?`
    ).get(row.url, since) as any;

    db.prepare(
      'UPDATE content_stats SET sessions_30d = ?, clicks_30d = ?, leads_30d = ? WHERE id = ?'
    ).run(Number(perf?.sessions ?? 0), Number(perf?.clicks ?? 0), Number(leads?.c ?? 0), row.id);
    updated++;
  }
  return updated;
}

export function analyseContent(db: DB, minN = 10): FeatureCorrelation[] {
  if (!enabled('CONTENT_INTELLIGENCE')) return [];
  refreshOutcomes(db);
  return correlateFeatures(db, minN);
}

export function formatContentReport(correlations: FeatureCorrelation[]): string {
  if (!correlations.length) {
    return 'No content data. Is FEATURE_CONTENT_INTELLIGENCE enabled, and has any content been analysed?';
  }
  const usable = correlations.filter(c => c.r !== null);
  const lines = ['CONTENT FEATURE vs OUTCOME', ''];

  if (!usable.length) {
    lines.push(`No correlation is computable yet — every pairing has fewer than the minimum sample.`);
    lines.push(`Largest sample seen: n=${Math.max(0, ...correlations.map(c => c.n))}.`);
    return lines.join('\n');
  }

  for (const c of usable.slice(0, 12)) {
    lines.push(`  ${c.feature.padEnd(16)} -> ${c.outcome.padEnd(9)}  ${c.interpretation}`);
  }
  lines.push('');
  lines.push('CAVEAT: these are correlations on observational data, not causes.');
  lines.push('A strong correlation is a reason to run an experiment, not a reason to act.');
  return lines.join('\n');
}
