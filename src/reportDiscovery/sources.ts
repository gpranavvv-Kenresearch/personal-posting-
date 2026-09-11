/**
 * sources.ts — which kenresearch.com sitemaps this watcher polls, and how
 * to classify/enrich a URL from each one.
 *
 * Deliberately excludes: blog-sitemap.xml (empty — dead /blog section),
 * home-sitemap.xml / staticpage-sitemap.xml (not content), brandcomparison
 * (static competitor-comparison pages, not reports), ai-markdown-sitemap.xml
 * (mirrors product-sitemap.xml 1:1 — polling it too would just double-count).
 */

export type ContentType = 'report' | 'article' | 'pov' | 'casestudy' | 'benchmarking' | 'survey';

export interface SitemapSource {
  type: ContentType;
  /** Sitemap file URLs for this type — product has a second page. */
  sitemapUrls: string[];
  /**
   * product-sitemap.xml is sorted newest-first (confirmed live) — on a
   * routine poll (not bootstrap), only the first page needs re-reading.
   * Other sitemaps are small enough that this doesn't matter.
   */
  headOnlyOnRoutinePoll: boolean;
}

const BASE = 'https://www.kenresearch.com';

export const SITEMAP_SOURCES: SitemapSource[] = [
  {
    type: 'report',
    sitemapUrls: [`${BASE}/product-sitemap.xml`, `${BASE}/product-sitemap.xml?p=2`],
    headOnlyOnRoutinePoll: true,
  },
  { type: 'article', sitemapUrls: [`${BASE}/article-sitemap.xml`], headOnlyOnRoutinePoll: false },
  { type: 'pov', sitemapUrls: [`${BASE}/pov-sitemap.xml`], headOnlyOnRoutinePoll: false },
  { type: 'casestudy', sitemapUrls: [`${BASE}/casestudy-sitemap.xml`], headOnlyOnRoutinePoll: false },
  { type: 'benchmarking', sitemapUrls: [`${BASE}/competitionbenchmarking-sitemap.xml`], headOnlyOnRoutinePoll: false },
  { type: 'survey', sitemapUrls: [`${BASE}/survey-sitemap.xml`], headOnlyOnRoutinePoll: false },
];

/** Skip literal duplicate-content slugs (e.g. "...-duplicate") seen live in the product sitemap. */
export function isDuplicateSlug(url: string): boolean {
  return /-duplicate(\/|$|\?)/i.test(url);
}

// Longest-prefix-first so "saudi-arabia" matches before a hypothetical
// shorter overlapping token would. Slug shape observed live:
// /industry-reports/{region-}{topic}-market — region prefix is optional
// (global reports have no region token at all).
const REGION_TOKENS = [
  'saudi-arabia', 'south-africa', 'south-korea', 'north-america', 'latin-america',
  'united-kingdom', 'united-states', 'new-zealand', 'sri-lanka', 'hong-kong',
  'gcc', 'uae', 'usa', 'uk', 'india', 'china', 'japan', 'vietnam', 'indonesia',
  'philippines', 'thailand', 'malaysia', 'singapore', 'egypt', 'nigeria', 'kenya',
  'brazil', 'mexico', 'canada', 'germany', 'france', 'italy', 'spain', 'russia',
  'australia', 'turkey', 'poland', 'europe', 'asia', 'africa', 'global',
];

export function extractRegionFromSlug(url: string): string {
  const slug = url.split('/').filter(Boolean).pop() ?? '';
  const normalized = slug.toLowerCase();
  const sorted = [...REGION_TOKENS].sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    if (normalized.startsWith(`${token}-`) || normalized === token) {
      return token;
    }
  }
  return ''; // no recognizable region prefix — leave blank rather than guess
}
