import { fetchSitemap } from './sitemapClient.js';
import { SITEMAP_SOURCES, ContentType, isDuplicateSlug, extractRegionFromSlug } from './sources.js';
import { isBootstrap, loadSeenStore, saveSeenStore, SeenStore } from './seenStore.js';
import { fetchReportMdSummary } from './mdEnrichment.js';

export interface DiscoveredItem {
  url: string;
  title: string;
  type: ContentType;
  region: string;
  lastmod: string;
}

export interface UpdatedItem {
  url: string;
  type: ContentType;
  lastmod: string;
}

export interface WatchResult {
  bootstrap: boolean;
  new: DiscoveredItem[];
  updated: UpdatedItem[]; // known URL, lastmod changed — informational only, never routed to posting
}

/**
 * Sanity check against a real failure mode confirmed live 2026-09-09: the
 * .md twin for .../thailand-poultry-producers-market returned the title
 * "Philippines Express and E-Commerce Logistics Market..." — a completely
 * different report (stale slug/redirect on kenresearch.com's side, or a
 * misrouted .md response). Trusting that blindly would post the wrong title
 * next to the wrong report link across every platform. Require most of the
 * URL slug's distinctive words to actually appear in the fetched title.
 */
function looksLikeMismatch(url: string, mdTitle: string): boolean {
  const slug = url.split('/').filter(Boolean).pop() ?? '';
  const slugWords = slug.split('-').filter(w => w.length > 2 && w !== 'market');
  if (slugWords.length === 0) return false;
  const titleLower = mdTitle.toLowerCase();
  const matches = slugWords.filter(w => titleLower.includes(w));
  return matches.length / slugWords.length < 0.5;
}

function titleFromSlug(url: string): string {
  const slug = url.split('/').filter(Boolean).pop() ?? '';
  return slug
    .replace(/\.md$/i, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Poll the kenresearch.com sitemaps, diff against the seen-list, and return
 * genuinely new items plus a separate "updated" list (known URLs whose
 * lastmod changed on a re-touch — informational only, never posted).
 *
 * First run is a bootstrap: the full catalog is new to us, so everything
 * gets seeded into the seen-list silently, and only items with lastmod
 * within `recentDaysOnBootstrap` are actually emitted as "new" — otherwise
 * the very first run would flood the Sheet with the entire historical
 * catalog.
 */
export async function runReportWatcher(opts?: {
  recentDaysOnBootstrap?: number;
  enrichReports?: boolean;
}): Promise<WatchResult> {
  const bootstrap = isBootstrap();
  const seen: SeenStore = loadSeenStore();
  const cutoff = daysAgoIso(opts?.recentDaysOnBootstrap ?? 3);
  const enrichReports = opts?.enrichReports ?? true;

  const newItems: DiscoveredItem[] = [];
  const updatedItems: UpdatedItem[] = [];

  for (const source of SITEMAP_SOURCES) {
    const urlsToFetch = bootstrap || !source.headOnlyOnRoutinePoll
      ? source.sitemapUrls
      : [source.sitemapUrls[0]];

    for (const sitemapUrl of urlsToFetch) {
      let entries;
      try {
        entries = await fetchSitemap(sitemapUrl);
      } catch (err: any) {
        console.warn(`   ⚠️  [ReportWatcher] Failed to fetch ${sitemapUrl}: ${err.message}`);
        continue;
      }

      for (const entry of entries) {
        if (isDuplicateSlug(entry.url)) continue;

        const existing = seen[entry.url];
        if (!existing) {
          const isRecentEnoughForBootstrap = !bootstrap || entry.lastmod >= cutoff;
          if (isRecentEnoughForBootstrap) {
            newItems.push({
              url: entry.url,
              title: titleFromSlug(entry.url),
              type: source.type,
              region: extractRegionFromSlug(entry.url),
              lastmod: entry.lastmod,
            });
          }
        } else if (existing.lastmod !== entry.lastmod) {
          updatedItems.push({ url: entry.url, type: source.type, lastmod: entry.lastmod });
        }

        seen[entry.url] = {
          lastmod: entry.lastmod,
          type: source.type,
          firstSeenAt: existing?.firstSeenAt ?? new Date().toISOString(),
        };
      }
    }
  }

  saveSeenStore(seen);

  if (enrichReports) {
    for (const item of newItems) {
      if (item.type !== 'report') continue;
      const md = await fetchReportMdSummary(item.url);
      if (md?.title) {
        if (looksLikeMismatch(item.url, md.title)) {
          console.warn(`   ⚠️  [ReportWatcher] .md title mismatch for ${item.url} — got "${md.title.slice(0, 60)}", keeping slug-derived title`);
        } else {
          item.title = md.title;
        }
      }
      // marketValue/cagr aren't part of DiscoveredItem's shape (sheet intake
      // only needs title/url/type/region) — full report data still comes
      // from agents/reportDataAgent.ts at content-generation time.
    }
  }

  console.log(`   📡 [ReportWatcher] ${bootstrap ? 'BOOTSTRAP' : 'poll'}: ${newItems.length} new, ${updatedItems.length} updated (today ${todayIso()})`);
  return { bootstrap, new: newItems, updated: updatedItems };
}
