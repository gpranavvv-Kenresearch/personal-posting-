/**
 * sanityAgent.ts — Pre-posting tweet validation (v2)
 * Pure TypeScript logic — no OpenRouter/Claude calls.
 *
 * 14 checks covering content, URL, hashtag, length, spam, and duplicate detection.
 * Supports batch-level duplicate tracking via optional BatchContext.
 */

import { SheetRow } from '../sheets/sheets.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SanityResult {
  valid: boolean;
  issues: string[];
  sanitized?: string;
}

/** Pass one BatchContext per batch run to detect cross-row duplicates. */
export interface BatchContext {
  seenUrls: Set<string>;
  seenTexts: string[];
}

export function createBatchContext(): BatchContext {
  return { seenUrls: new Set(), seenTexts: [] };
}

// ── Constants ──────────────────────────────────────────────────────────────

const ALLOWED_DOMAINS = ['kenresearch.com'];

const HASHTAG_FALLBACKS = ['#MarketResearch', '#MarketInsights', '#IndustryTrends', '#Research'];

const FORBIDDEN_WORDS = ['fuck', 'shit', 'ass', 'bitch', 'cunt', 'nigger', 'faggot'];

const FILLER_WORDS = ['just', 'really', 'truly', 'very', 'now'];

const CTA_SHORTENERS: Array<[RegExp, string]> = [
  [/Read more about this here/gi, 'Read:'],
  [/Read more about this/gi, 'Read:'],
  [/Explore more at/gi, 'See:'],
  [/Learn more about this/gi, 'Learn:'],
  [/Find out more/gi, 'See:'],
  [/Discover more at/gi, 'See:'],
];

const URL_FETCH_TIMEOUT_MS = 5000;
const MAX_HASHTAGS = 4;
const MIN_TEXT_WITHOUT_URL = 40;
const UPPERCASE_RATIO_LIMIT = 0.6;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

// ── Helpers ────────────────────────────────────────────────────────────────

/** X counts all URLs as 23 chars regardless of actual length. */
function computeXCharCount(tweet: string): number {
  const urls = tweet.match(/https?:\/\/\S+/g) ?? [];
  let count = tweet.length;
  for (const url of urls) {
    count += 23 - url.length;
  }
  return count;
}

function extractUrls(tweet: string): string[] {
  return tweet.match(/https?:\/\/\S+/g) ?? [];
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Strip URLs, hashtags, lowercase, collapse whitespace — for similarity comparison. */
function normalizeForSimilarity(tweet: string): string {
  return tweet
    .replace(/https?:\/\/\S+/g, '')
    .replace(/#\w+/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jaccard similarity on word bags (0–1). */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeForSimilarity(a).split(/\s+/).filter(Boolean));
  const wordsB = new Set(normalizeForSimilarity(b).split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Uppercase spam ratio — only counts letter characters, ignores URL portions.
 * Returns 0–1.
 */
function uppercaseRatio(tweet: string): number {
  const withoutUrls = tweet.replace(/https?:\/\/\S+/g, '');
  const letters = withoutUrls.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return 0;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length;
}

/** Remove hashtag by position (last match first). */
function removeLastHashtag(tweet: string): string {
  const idx = tweet.lastIndexOf('#');
  if (idx === -1) return tweet;
  // Remove from # to end of word
  return tweet.slice(0, idx).trimEnd() + tweet.slice(idx).replace(/#\w+/, '').trimStart();
}

/**
 * Multi-strategy trim. Tries 4 strategies in order until xCount ≤ 280.
 * Strategy 1 (excess hashtags) is already handled before calling this.
 * Returns trimmed tweet or null if all strategies fail.
 */
function smartTrim(tweet: string): string | null {
  let current = tweet;

  // Strategy 2: sentence boundary trim (., !, ?, \n, ": ")
  const urlMatch = current.match(/https?:\/\/\S+/);
  if (urlMatch) {
    const urlStart = current.indexOf(urlMatch[0]);
    const textBefore = current.slice(0, urlStart).trimEnd();
    const rest = current.slice(urlStart);

    const boundaries = [
      textBefore.lastIndexOf('. '),
      textBefore.lastIndexOf('! '),
      textBefore.lastIndexOf('? '),
      textBefore.lastIndexOf('\n'),
      textBefore.lastIndexOf(': '),
    ];
    const cutAt = Math.max(...boundaries);
    if (cutAt > 0) {
      const trimmed = (textBefore.slice(0, cutAt + 1).trimEnd() + ' ' + rest).trim();
      if (computeXCharCount(trimmed) <= 280) return trimmed;
      current = trimmed; // keep trying with trimmed version
    }
  }

  // Strategy 3: strip filler words one at a time
  for (const word of FILLER_WORDS) {
    const regex = new RegExp(`\\b${word}\\b\\s?`, 'gi');
    const attempt = current.replace(regex, '').replace(/\s{2,}/g, ' ').trim();
    if (attempt !== current && computeXCharCount(attempt) <= 280) return attempt;
    if (attempt !== current) current = attempt; // partial progress, keep going
  }

  // Strategy 4: shorten CTA phrases
  for (const [pattern, replacement] of CTA_SHORTENERS) {
    if (pattern.test(current)) {
      const attempt = current.replace(pattern, replacement).replace(/\s{2,}/g, ' ').trim();
      if (computeXCharCount(attempt) <= 280) return attempt;
      current = attempt;
    }
  }

  return null;
}

// ── URL reachability check ─────────────────────────────────────────────────

async function checkUrlReachable(url: string): Promise<'ok' | 'bad_status' | 'timeout' | 'error'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    return res.ok ? 'ok' : 'bad_status';
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return 'timeout';
    return 'error';
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function runSanityCheck(
  tweet: string,
  row: SheetRow,
  batchCtx?: BatchContext,
): Promise<SanityResult> {
  try {
    const issues: string[] = [];
    let current = tweet;
    let fixApplied = false;

    console.log(`   🔍 Sanity check running...`);

    // ── Check 1: Empty tweet ─────────────────────────────────────────────
    if (!current || current.trim().length === 0) {
      console.log(`   ❌ Sanity FAILED: empty tweet`);
      return { valid: false, issues: ['MAJOR:empty_tweet'] };
    }

    // ── Check 2: URL present ─────────────────────────────────────────────
    const urls = extractUrls(current);
    if (urls.length === 0) {
      console.log(`   ❌ Sanity FAILED: no URL found`);
      return { valid: false, issues: ['MAJOR:no_url'] };
    }

    // ── Check 3: Domain whitelist ────────────────────────────────────────
    const primaryUrl = urls[0];
    const domain = extractDomain(primaryUrl);
    const domainAllowed = ALLOWED_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
    if (!domainAllowed) {
      issues.push(`MAJOR:domain_not_allowed(${domain})`);
      console.log(`   ❌ Sanity FAILED: domain "${domain}" not in allowed list`);
      return { valid: false, issues };
    }

    // ── Check 4: URL reachable ───────────────────────────────────────────
    const reachability = await checkUrlReachable(primaryUrl);
    if (reachability === 'bad_status') {
      issues.push(`MAJOR:url_unreachable(${primaryUrl})`);
      console.log(`   ❌ Sanity FAILED: URL returned non-200 status`);
      return { valid: false, issues };
    } else if (reachability === 'timeout' || reachability === 'error') {
      issues.push(`MINOR:url_check_${reachability}`);
      console.log(`   ⚠️  Minor: URL reachability check ${reachability} (not blocking)`);
    }

    // ── Check 5: Link-only detection ─────────────────────────────────────
    const textWithoutUrl = current.replace(/https?:\/\/\S+/g, '').trim();
    if (textWithoutUrl.length < MIN_TEXT_WITHOUT_URL) {
      issues.push(`MAJOR:link_only(text_length=${textWithoutUrl.length})`);
      console.log(`   ❌ Sanity FAILED: tweet has too little text (${textWithoutUrl.length} chars without URL)`);
      return { valid: false, issues };
    }

    // ── Check 6: Uppercase spam ──────────────────────────────────────────
    const uRatio = uppercaseRatio(current);
    if (uRatio > UPPERCASE_RATIO_LIMIT) {
      issues.push(`MAJOR:uppercase_spam(ratio=${uRatio.toFixed(2)})`);
      console.log(`   ❌ Sanity FAILED: uppercase ratio ${(uRatio * 100).toFixed(0)}% exceeds limit`);
      return { valid: false, issues };
    }

    // ── Check 7: Hashtag present (with fallback list) ────────────────────
    if (!/#\w+/.test(current)) {
      let hashtagAdded = false;
      for (const tag of HASHTAG_FALLBACKS) {
        const candidate = `${current} ${tag}`;
        if (computeXCharCount(candidate) <= 280) {
          issues.push(`MINOR:no_hashtag_auto_fixed(added ${tag})`);
          current = candidate;
          fixApplied = true;
          hashtagAdded = true;
          console.log(`   ⚠️  Minor issue auto-fixed: appended ${tag}`);
          break;
        }
      }
      if (!hashtagAdded) {
        issues.push('MAJOR:no_hashtag_cannot_fit');
        console.log(`   ❌ Sanity FAILED: no hashtag and none from fallback list fit`);
        return { valid: false, issues };
      }
    }

    // ── Check 8: Hashtag count ≤ 4 ──────────────────────────────────────
    const hashtags = current.match(/#\w+/g) ?? [];
    if (hashtags.length > MAX_HASHTAGS) {
      issues.push(`MAJOR:too_many_hashtags(${hashtags.length})`);
      console.log(`   ❌ Sanity FAILED: ${hashtags.length} hashtags exceeds max of ${MAX_HASHTAGS}`);
      return { valid: false, issues };
    }

    // ── Check 9: Length (multi-strategy trim) ────────────────────────────
    let xCount = computeXCharCount(current);
    if (xCount > 280) {
      const trimResult = smartTrim(current);
      if (trimResult && computeXCharCount(trimResult) <= 280) {
        const newCount = computeXCharCount(trimResult);
        issues.push(`MINOR:length_auto_trimmed(${xCount}→${newCount})`);
        current = trimResult;
        fixApplied = true;
        console.log(`   ⚠️  Minor issue auto-fixed: trimmed tweet from ${xCount} to ${newCount} X-chars`);
        xCount = newCount;
      } else {
        issues.push(`MAJOR:length_too_long(${xCount})`);
        console.log(`   ❌ Sanity FAILED: tweet is ${xCount} X-chars, all trim strategies failed`);
        return { valid: false, issues };
      }
    }

    // ── Check 10: Profanity ──────────────────────────────────────────────
    const lowerTweet = current.toLowerCase();
    const badWord = FORBIDDEN_WORDS.find(w => new RegExp(`\\b${w}\\b`).test(lowerTweet));
    if (badWord) {
      issues.push(`MAJOR:profanity(${badWord})`);
      console.log(`   ❌ Sanity FAILED: profanity detected`);
      return { valid: false, issues };
    }

    // ── Check 11: Spam patterns ──────────────────────────────────────────
    if (/!{3,}/.test(current)) {
      issues.push('MAJOR:spam_pattern(excessive_exclamation)');
      console.log(`   ❌ Sanity FAILED: spam pattern detected (excessive "!!!")`);
      return { valid: false, issues };
    }

    // ── Check 12: Duplicate URL in batch ────────────────────────────────
    if (batchCtx) {
      const normalizedUrl = primaryUrl.replace(/\/$/, '').toLowerCase();
      if (batchCtx.seenUrls.has(normalizedUrl)) {
        issues.push(`MAJOR:duplicate_url(${primaryUrl})`);
        console.log(`   ❌ Sanity FAILED: URL already posted in this batch`);
        return { valid: false, issues };
      }
    }

    // ── Check 13: Duplicate text similarity ─────────────────────────────
    if (batchCtx && batchCtx.seenTexts.length > 0) {
      for (const prev of batchCtx.seenTexts) {
        const similarity = jaccardSimilarity(current, prev);
        if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
          issues.push(`MAJOR:duplicate_text(similarity=${similarity.toFixed(2)})`);
          console.log(`   ❌ Sanity FAILED: tweet too similar to another in batch (${(similarity * 100).toFixed(0)}%)`);
          return { valid: false, issues };
        }
      }
    }

    // ── Check 14: Title keyword (MINOR, log only) ────────────────────────
    if (row.title && row.title.trim()) {
      const titleWords = row.title.split(/\s+/).filter(w => w.length > 4);
      const hasKeyword = titleWords.some(w => lowerTweet.includes(w.toLowerCase()));
      if (!hasKeyword) {
        issues.push('MINOR:no_title_keyword');
        console.log(`   ⚠️  Minor: no title keywords found in tweet (not blocking)`);
      }
    }

    // ── All checks passed — register in batch context ────────────────────
    if (batchCtx) {
      const normalizedUrl = primaryUrl.replace(/\/$/, '').toLowerCase();
      batchCtx.seenUrls.add(normalizedUrl);
      batchCtx.seenTexts.push(current);
    }

    console.log(`   ✅ Sanity passed${fixApplied ? ' (with auto-fixes)' : ''}`);
    return {
      valid: true,
      issues,
      sanitized: fixApplied ? current : undefined,
    };
  } catch (err: any) {
    console.error(`   ❌ Sanity check unexpected error: ${err.message}`);
    return { valid: false, issues: [`MAJOR:unexpected_error:${err.message}`] };
  }
}
