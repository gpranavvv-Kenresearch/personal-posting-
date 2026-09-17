/**
 * rawPullRssSince.ts — fetch the RSS feed since a given date and write
 * everything straight to the RSS Extraction tab, bypassing the seen-store
 * dedup (which is shared with the sitemap watcher and may have already
 * marked these URLs "seen" before this tab existed). Use for one-off
 * backfills; normal operation should go through runRssWatcher.ts /
 * runReportDiscoveryBatch() so dedup keeps working going forward.
 *
 * Usage:
 *   npx tsx src/tools/rawPullRssSince.ts 2026-09-15
 */
import 'dotenv/config';
import { fetchRssFeed } from '../reportDiscovery/rssClient.js';
import { contentTypeFromRssCategory, extractRegionFromSlug, isDuplicateSlug } from '../reportDiscovery/sources.js';
import { appendRssExtractionRows } from '../sheets/sheets.js';

const since = process.argv[2];
if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('Usage: npx tsx src/tools/rawPullRssSince.ts YYYY-MM-DD');
  process.exit(1);
}

(async () => {
  const items = await fetchRssFeed({ since });
  console.log(`Feed returned ${items.length} item(s) since ${since}.`);

  const rows = items
    .filter(item => !isDuplicateSlug(item.url))
    .map(item => {
      const type = contentTypeFromRssCategory(item.category);
      if (!type) {
        console.warn(`   ⚠️  Unknown category "${item.category}" for ${item.url} — writing with type "unknown"`);
      }
      return {
        title: item.title,
        url: item.url,
        type: type ?? 'unknown',
        region: extractRegionFromSlug(item.url),
        pubDate: item.pubDate,
        rawCategory: item.category,
        guid: item.guid,
        description: item.description,
      };
    });

  for (const r of rows) {
    console.log(`  [${r.type}]${r.region ? ` (${r.region})` : ''} ${r.title} → ${r.url}`);
  }

  const appended = await appendRssExtractionRows(rows);
  console.log(`\n✅ Appended ${appended} row(s) to "RSS Extraction".`);
})().catch(err => {
  console.error('❌ Raw pull failed:', err.message);
  process.exit(1);
});
