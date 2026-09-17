/**
 * rssClient.ts — fetch + parse the Tech Team's kenresearch.com RSS feed
 * (https://www.kenresearch.com/feed/newly-published.xml) into plain items.
 *
 * Confirmed live 2026-09-15. Real <item> shape has only: title, link,
 * description, pubDate, guid, category — no updatedDate/image/author despite
 * those being listed as "preferred" in the original PRD. `guid` equals
 * `link` (the canonical URL), which is also how the existing sitemap-based
 * seen-store already dedups, so both detection sources can share one store.
 *
 * `pubDate` mixes timezone offsets across items (some `+0000`, some `+0530`)
 * — normalizing through `Date()` handles both correctly since each carries
 * its own explicit offset.
 */

export interface RssItem {
  title: string;
  url: string;
  description: string;
  /** "YYYY-MM-DD", normalized from pubDate. */
  pubDate: string;
  guid: string;
  /** Raw <category> text as the feed sends it (e.g. "Report", "Article", "Survey"). */
  category: string;
}

const FEED_URL = 'https://www.kenresearch.com/feed/newly-published.xml';

export async function fetchRssFeed(opts?: { since?: string; until?: string; type?: string }): Promise<RssItem[]> {
  const params = new URLSearchParams();
  if (opts?.since) params.set('since', opts.since);
  if (opts?.until) params.set('until', opts.until);
  if (opts?.type) params.set('type', opts.type);
  const qs = params.toString();
  const url = qs ? `${FEED_URL}?${qs}` : FEED_URL;

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KenResearchReportWatcher/1.0)' } });
  if (!res.ok) {
    throw new Error(`RSS feed fetch failed: ${url} -> HTTP ${res.status}`);
  }
  const xml = await res.text();
  return parseRssXml(xml);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function normalizePubDate(raw: string): string {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function parseRssXml(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemBlockRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;

  while ((m = itemBlockRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string): string => {
      const mm = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return mm ? decodeEntities(mm[1].trim()) : '';
    };

    const title = get('title');
    const url = get('link');
    const guid = get('guid') || url;
    const pubDateRaw = get('pubDate');
    const description = get('description');
    const category = get('category');

    // Defensive: skip (don't throw) an item missing a required field, so one
    // malformed entry never kills the whole poll.
    if (!title || !url || !pubDateRaw || !guid) {
      console.warn(`   ⚠️  [RssClient] Skipping item missing a required field (title/url/pubDate/guid): ${title || url || '(unidentifiable item)'}`);
      continue;
    }

    items.push({ title, url, description, pubDate: normalizePubDate(pubDateRaw), guid, category });
  }

  return items;
}
