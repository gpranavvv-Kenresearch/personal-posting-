/**
 * seoAgent.ts — Tweet SEO Optimizer + Google Ranking Analyzer
 *
 * runSeoAnalysis  — SerpAPI: checks if URL is indexed on Google + exact rank page
 *                   Tavily: finds trending keywords
 *                   Decides which platforms to post to based on ranking.
 * runSeoOptimize  — scores tweet locally (0-100), calls OpenRouter if score < 75.
 */

import { callOpenRouter } from '../config/openRouterClient.js';
import { callTavily } from '../config/tavilyClient.js';
import { callSerpApi } from '../config/serpApiClient.js';
import { SheetRow } from '../sheets/sheets.js';
import { settings } from '../config/settings.js';

export type Platform = 'x' | 'facebook' | 'linkedin';

export interface SeoAnalysisResult {
  indexStatus: 'indexed' | 'not_indexed' | 'unknown';
  rankPage:     number;   // page number 1-10 (internal — used for platform decisions); 99 = beyond top 100
  rankPosition: number;   // exact Google position 1-100; 0 = indexed but outside top 100; -1 = unknown
  keywords: string[];     // top trending keywords
  platforms: Platform[];  // decided based on ranking
}


// ── Platform decision ──────────────────────────────────────────────────────

// ── Active platforms toggle ─────────────────────────────────────────────────
// Set to false to disable a platform globally. Re-enable when ready.
const PLATFORMS_ENABLED = {
  facebook: true,
  linkedin: true,
};

function decidePlatforms(indexStatus: string, rankPage: number, title: string): Platform[] {
  const platforms: Platform[] = ['x'];
  if (!PLATFORMS_ENABLED.facebook && !PLATFORMS_ENABLED.linkedin) return platforms;

  if (indexStatus === 'not_indexed' || rankPage >= 7) {
    // Weak/no ranking → boost on all platforms
    if (PLATFORMS_ENABLED.facebook) platforms.push('facebook');
    if (PLATFORMS_ENABLED.linkedin) platforms.push('linkedin');
  } else if (rankPage >= 3 && rankPage <= 6) {
    // Mid ranking (pages 3–6) → one extra platform based on topic type
    const isB2B = /enterprise|consulting|policy|government|industrial|manufacturing|b2b|corporate/i.test(title);
    if (isB2B  && PLATFORMS_ENABLED.linkedin) platforms.push('linkedin');
    if (!isB2B && PLATFORMS_ENABLED.facebook) platforms.push('facebook');
  }
  // rank 1–3 → X only (already ranking well)
  return platforms;
}

// ── Main SEO analysis export ───────────────────────────────────────────────
// SerpAPI → index check + rank page
// Tavily  → trending keywords

// ── Generate keyword phrases from URL slug ─────────────────────────────────
// e.g. "india-frozen-food-market" →
//   "india frozen food market", "frozen food market in india",
//   "india frozen food industry", "frozen food market size india", ...

function generateKeywordPhrases(slug: string): string[] {
  const base = slug.toLowerCase().replace(/-/g, ' ').trim();
  // Strip trailing filler words
  const clean = base.replace(/\s*(market|industry|report|analysis|size|forecast|overview)$/i, '').trim();
  const topic = clean || base;

  const phrases: string[] = [
    `${topic} market`,
    `${topic} market size`,
    `${topic} industry`,
    `${topic} market growth`,
    `${topic} market analysis`,
    `${topic} market forecast`,
    `${topic} market report`,
    `${topic} market trends`,
  ];

  // Also add a reordered variant if it starts with a country/region
  const regionRe = /^(india|global|asia|us|usa|uk|china|japan|europe|mena|gcc)\s+/i;
  const regionMatch = topic.match(regionRe);
  if (regionMatch) {
    const region = regionMatch[1];
    const coreTopic = topic.replace(regionRe, '').trim();
    phrases.unshift(`${coreTopic} market in ${region}`);
    phrases.unshift(`${coreTopic} market size ${region}`);
  }

  return [...new Set(phrases)].slice(0, 8);
}

export async function runSeoAnalysis(targetUrl: string, title: string): Promise<SeoAnalysisResult> {
  console.log(`\n🔍 SEO Analysis...`);
  console.log(`   URL: ${targetUrl}`);

  // Extract slug from URL — use the raw slug as the search query
  const rawSlug = targetUrl.split('/').filter(Boolean).pop() || '';          // e.g. "india-gene-therapy-market"
  const urlSlug = rawSlug.replace(/-/g, ' ');                                 // e.g. "india gene therapy market"
  const slug = title || urlSlug;

  const keywords: string[] = generateKeywordPhrases(rawSlug || slug);
  let indexStatus: 'indexed' | 'not_indexed' | 'unknown' = 'unknown';
  let rankPage     = 99;   // page number (1-10) for platform decision; 99 = outside top 100
  let rankPosition = -1;   // exact position (1-100); 0 = indexed but not in top 100; -1 = unknown

  // ── SerpAPI: organic rank check ────────────────────────────────────────────
  // Search the raw slug (e.g. "india-gene-therapy-market") in Google top 100.
  // If the kenresearch.com URL appears → record EXACT position (1-100).
  // If not in top 100 → site: fallback to check if indexed at all.
  if (settings.serpApi.keys.length === 0) {
    console.log('   ⚠️  No SERPAPI keys set — skipping index check, defaulting to all platforms');
    indexStatus = 'unknown';
  } else {
    const searchQuery = rawSlug.replace(/-/g, ' ');   // e.g. "apac insulin market"
    const rankData = await callSerpApi({ engine: 'google', q: searchQuery, num: '100' }).catch((err: any) => {
      console.warn(`   ⚠️  SerpAPI rank check failed: ${err.message}`);
      return null;
    });

    if (rankData) {
      const organic: any[] = rankData.organic_results ?? [];

      // Extract URL path to match exactly (e.g. "/apac-insulin-market")
      let urlPath = '';
      try { urlPath = new URL(targetUrl).pathname.toLowerCase().replace(/\/$/, ''); } catch { urlPath = targetUrl.toLowerCase(); }

      const match = organic.find((r: any) => {
        const link = (r.link ?? '').toLowerCase().replace(/\/$/, '');
        return link.includes('kenresearch.com') && link.includes(urlPath);
      });

      if (match) {
        // ── FOUND in top 100 ──────────────────────────────────────────────
        indexStatus  = 'indexed';
        rankPosition = typeof match.position === 'number' ? match.position : organic.indexOf(match) + 1;
        rankPage     = Math.ceil(rankPosition / 10);
        const pageLabel = `page ${rankPage}`;
        console.log(`   ✅ Ranked #${rankPosition} on Google (${pageLabel}) — query: "${searchQuery}"`);
      } else {
        // ── NOT in top 100 — check if indexed at all via site: ─────────────
        const siteData = await callSerpApi({ engine: 'google', q: `site:${targetUrl}`, num: '1' }).catch(() => null);
        if (siteData && (siteData.organic_results ?? []).length > 0) {
          indexStatus  = 'indexed';
          rankPage     = 99;
          rankPosition = 0;   // indexed but outside top 100
          console.log(`   ✅ Indexed but NOT in top 100 results for "${searchQuery}"`);
        } else {
          indexStatus  = 'not_indexed';
          rankPage     = 99;
          rankPosition = 0;
          console.log(`   ❌ Not found in Google — not indexed`);
        }
      }
    } else {
      console.log(`   ⚠️  SerpAPI unavailable — using unknown status`);
    }
  }

  console.log(`   🔑 Keywords: ${keywords.join(' | ')}`);

  const platforms = decidePlatforms(indexStatus, rankPage, title);

  // Human-readable rank summary
  let rankSummary: string;
  if (rankPosition > 0)       rankSummary = `position ${rankPosition} (page ${rankPage})`;
  else if (rankPosition === 0) rankSummary = indexStatus === 'indexed' ? 'indexed, beyond top 100' : 'not indexed';
  else                         rankSummary = 'unknown';
  console.log(`   🎯 Platforms: ${platforms.join(', ')} | Rank: ${rankSummary}`);

  return { indexStatus, rankPage, rankPosition, keywords, platforms };
}

export interface SeoResult {
  optimized: string;
  seoScore: number;
  improvements: string[];
}

const OPENROUTER_MODEL = 'anthropic/claude-haiku-4-5';

const FORBIDDEN_WORDS = [
  'reshaping', 'accelerating', 'evolving', 'transforming', 'booming',
  'skyrocketing', 'surging', 'soaring', 'rapidly growing', 'growing fast', 'fast-growing',
];

// X counts URLs as 23 chars regardless of actual length
function computeXCharCount(tweet: string): number {
  const urls = tweet.match(/https?:\/\/\S+/g) ?? [];
  let count = tweet.length;
  for (const url of urls) {
    count += 23 - url.length;
  }
  return count;
}

function scoreLocally(tweet: string, row: SheetRow): { score: number; improvements: string[] } {
  let score = 0;
  const improvements: string[] = [];
  const lower = tweet.toLowerCase();

  // +15: market value from row appears in tweet
  if (row.marketValue && row.marketValue.trim() && lower.includes(row.marketValue.toLowerCase())) {
    score += 15;
  } else if (row.marketValue && row.marketValue.trim()) {
    improvements.push(`Include market value: ${row.marketValue}`);
  }

  // +15: 2+ hashtags
  const hashtags = tweet.match(/#\w+/g) ?? [];
  if (hashtags.length >= 2) {
    score += 15;
  } else {
    improvements.push('Add a second relevant hashtag');
  }

  // +15: tweet length 200-280 X-chars (covers the full valid range)
  const xCount = computeXCharCount(tweet);
  if (xCount >= 200 && xCount <= 280) {
    score += 15;
  } else if (xCount < 200) {
    improvements.push('Tweet is short — consider adding more context');
  }

  // +10: URL present
  if (/https?:\/\/\S+/.test(tweet)) {
    score += 10;
  } else {
    improvements.push('Include a URL');
  }

  // +10: opening emoji
  const firstChar = tweet.trim()[0];
  const isEmoji = /\p{Emoji}/u.test(firstChar);
  if (isEmoji) {
    score += 10;
  } else {
    improvements.push('Start with a relevant emoji');
  }

  // +15: number/stat in text
  if (/\d+/.test(tweet)) {
    score += 15;
  } else {
    improvements.push('Include a specific number or statistic');
  }

  // +10: title keyword present
  if (row.title && row.title.trim()) {
    const titleWords = row.title.split(/\s+/).filter(w => w.length > 4);
    if (titleWords.some(w => lower.includes(w.toLowerCase()))) {
      score += 10;
    } else {
      improvements.push('Reference the report topic more explicitly');
    }
  } else {
    score += 10; // no title to check, give benefit of doubt
  }

  // +10: no forbidden words
  const foundForbidden = FORBIDDEN_WORDS.find(w => lower.includes(w));
  if (!foundForbidden) {
    score += 10;
  } else {
    improvements.push(`Remove overused word: "${foundForbidden}"`);
  }

  return { score: Math.min(score, 100), improvements };
}

const SEO_TARGET_SCORE = 75;
const SEO_MAX_RETRIES = 3;

/** Remove dash separators (` - ` or leading `- `) from tweet text, leaving URL untouched. */
function stripDashes(tweet: string): string {
  return tweet
    .replace(/ - /g, ' ')       // inline dash separator → space
    .replace(/^- /gm, '')       // leading dash on any line
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function runSeoOptimize(tweet: string, row: SheetRow, seoKeywords?: string[]): Promise<SeoResult> {
  try {
    const urlMatch = tweet.match(/https?:\/\/\S+/);
    const originalUrl = urlMatch ? urlMatch[0] : '';

    let optimized = stripDashes(tweet);
    let { score, improvements } = scoreLocally(optimized, row);
    console.log(`   📈 SEO local score: ${score}/100`);

    if (score >= SEO_TARGET_SCORE) {
      console.log(`   ✅ Score ${score} ≥ ${SEO_TARGET_SCORE} — skipping AI optimization`);
      return { optimized, seoScore: score, improvements };
    }

    let aiImprovements = improvements;
    let attempt = 0;

    while (score < SEO_TARGET_SCORE && attempt < SEO_MAX_RETRIES) {
      attempt++;
      console.log(`   🤖 Score ${score} < ${SEO_TARGET_SCORE} — AI attempt ${attempt}/${SEO_MAX_RETRIES}...`);

      const currentXCount = computeXCharCount(optimized);

      try {
        const response = await callOpenRouter({
          model: OPENROUTER_MODEL,
          max_tokens: 350,
          system: `You are an SEO optimizer for X (Twitter) posts about market research reports.

Your job: improve the tweet's discoverability while keeping it authentic and STRICTLY under 280 X-chars.

X-CHAR FORMULA: tweet.length + (23 - url.length) for each URL in the tweet.
URLs always count as exactly 23 chars regardless of actual length.
TEXT BEFORE THE URL must be ≤200 chars (including emoji and trailing space).

RULES:
1. Return ONLY valid JSON: {"optimized": "...", "improvements": ["...", "..."]}
2. Keep the URL exactly as-is — do not shorten, alter, or remove it
3. HARD LIMIT: final X-char count must be ≤280. Count carefully before returning.
4. If fewer than 2 hashtags, add one relevant market research hashtag only if it fits within 280
5. Never invent numbers or statistics not in the original
6. Never use: reshaping, accelerating, evolving, transforming, booming, skyrocketing, surging, soaring
7. NEVER use dashes (-) anywhere — no " - " separators, no bullet dashes, no em-dashes`,
          messages: [{
            role: 'user',
            content: `Optimize this tweet for better SEO and engagement. Target score: ${SEO_TARGET_SCORE}/100.\n\nCURRENT TWEET: "${optimized}"\nCURRENT X-CHAR COUNT: ${currentXCount}/280\nCHARS REMAINING: ${280 - currentXCount}\nCURRENT SCORE: ${score}/100\nMISSING: ${improvements.join(', ')}\n\nReport topic: ${row.title || 'market research'}\nMarket value: ${row.marketValue || 'not specified'}${seoKeywords && seoKeywords.length > 0 ? `\nTrending keywords for this topic: ${seoKeywords.join(', ')}` : ''}\n\nReturn JSON only. The optimized tweet MUST have X-char count ≤280 and NO dashes (-).`,
          }],
        });

        const rawText = response.content[0]?.text ?? '';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { optimized?: string; improvements?: string[] };

          if (parsed.optimized && typeof parsed.optimized === 'string') {
            const candidate = stripDashes(parsed.optimized);
            if (originalUrl && !candidate.includes(originalUrl)) {
              console.warn(`   ⚠️  AI changed the URL — keeping previous version`);
            } else if (computeXCharCount(candidate) > 280) {
              console.warn(`   ⚠️  AI output is over 280 X-chars — keeping previous version`);
            } else {
              optimized = candidate;
              const reScore = scoreLocally(optimized, row);
              score = reScore.score;
              aiImprovements = Array.isArray(parsed.improvements) ? parsed.improvements : reScore.improvements;
              improvements = reScore.improvements;
              console.log(`   📈 Re-scored after attempt ${attempt}: ${score}/100`);
            }
          }
        } else {
          console.warn(`   ⚠️  AI returned no valid JSON — keeping previous version`);
        }
      } catch (apiErr: any) {
        console.warn(`   ⚠️  SEO AI call failed (${apiErr.message}) — stopping retries`);
        break;
      }
    }

    if (score >= SEO_TARGET_SCORE) {
      console.log(`   ✅ Target score ${SEO_TARGET_SCORE} reached (${score}/100) after ${attempt} attempt(s)`);
    } else {
      console.log(`   ⚠️  Best score after ${attempt} attempt(s): ${score}/100 (target: ${SEO_TARGET_SCORE})`);
    }

    if (aiImprovements.length > 0) {
      console.log(`   📊 Improvements: ${aiImprovements.join(', ')}`);
    }

    return { optimized, seoScore: score, improvements: aiImprovements };
  } catch (err: any) {
    console.error(`   ❌ SEO agent unexpected error: ${err.message}`);
    return { optimized: tweet, seoScore: 0, improvements: [] };
  }
}
