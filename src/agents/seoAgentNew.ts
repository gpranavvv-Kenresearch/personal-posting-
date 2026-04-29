/**
 * seoAgentNew.ts — SEO Analysis Agent
 * Checks Google ranking via SerpAPI (with ValueSERP fallback) and assigns priority.
 * Uses Tavily for keyword enrichment.
 * No Anthropic/LLM dependency — pure API calls.
 */

import { callSerpApi } from '../config/serpApiClient.js';
import { callTavily } from '../config/tavilyClient.js';

export type Platform = 'x' | 'facebook' | 'linkedin';

export interface SeoAnalysisResult {
  indexStatus: 'indexed' | 'not_indexed' | 'unknown';
  rankPage: number;    // page number (1 = first page, 2 = second, etc.)
  rankPosition: number; // absolute position (1-100+, 999 = not found)
  seoRanking: number;  // same as rankPosition for compatibility
  keywords: string[];
  platforms: Platform[];
  priority: 'P1' | 'P2' | 'P3';
  seoScore?: number;
}

/**
 * Run SEO analysis: check Google ranking + Tavily keywords
 */
export async function runSeoAnalysis(
  targetUrl: string,
  title?: string,
): Promise<SeoAnalysisResult> {

  // 1. Check Google ranking via SerpAPI (ValueSERP fallback is automatic)
  let rankPosition = 999;
  let indexStatus: 'indexed' | 'not_indexed' | 'unknown' = 'unknown';
  let keywords: string[] = [];

  try {
    // Trim title after "Market" or "Industry" for cleaner SERP query
    let searchQuery = title || targetUrl;
    const cutMatch = searchQuery.match(/^(.*?\b(?:Market|Industry)\b)/i);
    if (cutMatch) searchQuery = cutMatch[1].trim();
    const serpResult = await callSerpApi({
      engine: 'google',
      q: searchQuery,
      num: '70',
    });

    const organicResults: any[] = serpResult.organic_results || [];

    // Find target URL in results
    if (targetUrl && organicResults.length > 0) {
      let hostname = '';
      try { hostname = new URL(targetUrl).hostname; } catch { /* ignore */ }

      for (let i = 0; i < organicResults.length; i++) {
        const link: string = organicResults[i].link || organicResults[i].url || '';
        if (hostname && link.includes(hostname)) {
          rankPosition = i + 1;
          indexStatus = 'indexed';
          break;
        }
        // Also try exact URL match
        if (link && targetUrl && link.includes(targetUrl.replace(/^https?:\/\//, ''))) {
          rankPosition = i + 1;
          indexStatus = 'indexed';
          break;
        }
      }

      if (rankPosition === 999 && organicResults.length > 0) {
        indexStatus = 'not_indexed';
      }
    }
  } catch (err: any) {
    console.warn(`   ⚠️  SERP check failed: ${err.message}`);
    indexStatus = 'unknown';
  }

  // 2. Tavily keyword enrichment (optional — skip if no keys)
  if (title) {
    try {
      const tavilyResult = await callTavily({
        query: title,
        search_depth: 'basic',
        max_results: 5,
      });
      keywords = (tavilyResult.results || [])
        .map((r: any) => r.title?.split(' ').slice(0, 3).join(' '))
        .filter(Boolean)
        .slice(0, 5);
    } catch {
      // Tavily optional — ignore errors
    }
  }

  // 3. Assign priority based on rank position
  //    P1: rank 70+ or not indexed → needs most social push
  //    P2: rank 31-69              → moderate push
  //    P3: rank 1-30 (pages 1-3)  → already ranking well, less frequent
  let priority: 'P1' | 'P2' | 'P3';
  if (rankPosition <= 30) {
    priority = 'P3';
  } else if (rankPosition <= 69) {
    priority = 'P2';
  } else {
    priority = 'P1';
  }

  const rankPage = rankPosition <= 10 ? 1 : rankPosition <= 20 ? 2 : rankPosition <= 30 ? 3
    : rankPosition <= 40 ? 4 : rankPosition <= 50 ? 5 : rankPosition <= 60 ? 6
    : rankPosition <= 70 ? 7 : Math.ceil(rankPosition / 10);

  return {
    indexStatus,
    rankPage,
    rankPosition,
    seoRanking: rankPosition,
    keywords,
    platforms: ['x', 'facebook', 'linkedin'],
    priority,
  };
}

/**
 * SEO optimize (kept for backward compatibility)
 */
export async function runSeoOptimize(
  tweetText: string,
  _keywords?: string[],
): Promise<{ optimizedTweet: string; seoScore: number }> {
  return {
    optimizedTweet: tweetText,
    seoScore: 85,
  };
}
