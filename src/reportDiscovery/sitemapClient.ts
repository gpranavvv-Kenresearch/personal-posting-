/**
 * sitemapClient.ts — fetch + parse a kenresearch.com sitemap XML file into
 * plain {url, lastmod} entries. No XML library needed — sitemap <url> blocks
 * are flat and regular enough for a direct regex scan.
 */

export interface SitemapEntry {
  url: string;
  lastmod: string; // "YYYY-MM-DD" as published — kenresearch.com's sitemaps are date-only, no time
}

export async function fetchSitemap(sitemapUrl: string): Promise<SitemapEntry[]> {
  const res = await fetch(sitemapUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KenResearchReportWatcher/1.0)' } });
  if (!res.ok) {
    throw new Error(`Sitemap fetch failed: ${sitemapUrl} -> HTTP ${res.status}`);
  }
  const xml = await res.text();
  return parseSitemapXml(xml);
}

export function parseSitemapXml(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlBlockRe = /<url>([\s\S]*?)<\/url>/g;
  let m: RegExpExecArray | null;
  while ((m = urlBlockRe.exec(xml)) !== null) {
    const block = m[1];
    const locMatch = block.match(/<loc>([\s\S]*?)<\/loc>/);
    const lastmodMatch = block.match(/<lastmod>([\s\S]*?)<\/lastmod>/);
    if (!locMatch) continue;
    entries.push({
      url: locMatch[1].trim(),
      lastmod: (lastmodMatch?.[1] ?? '').trim().slice(0, 10), // keep just the date part
    });
  }
  return entries;
}
