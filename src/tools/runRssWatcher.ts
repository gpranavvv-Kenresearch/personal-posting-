/**
 * runRssWatcher.ts — poll the Tech Team RSS feed
 * (kenresearch.com/feed/newly-published.xml) and append newly-found items to
 * the "RSS Extraction" staging tab, same source runReportDiscoveryBatch()
 * polls on cron.
 *
 * Usage:
 *   npx tsx src/tools/runRssWatcher.ts             # normal run
 *   npx tsx src/tools/runRssWatcher.ts --dry-run    # print what would be appended, don't write
 */
import 'dotenv/config';
import { runRssReportWatcher } from '../reportDiscovery/watcher.js';
import { appendRssExtractionRows } from '../sheets/sheets.js';

const dryRun = process.argv.includes('--dry-run');

(async () => {
  const result = await runRssReportWatcher();

  console.log(`\nSince: ${result.since}`);
  console.log(`New items: ${result.new.length}`);
  for (const item of result.new) {
    console.log(`  [${item.type}]${item.region ? ` (${item.region})` : ''} ${item.title} → ${item.url}`);
  }
  if (result.skippedUnknownCategory > 0) {
    console.log(`\nSkipped (unknown category): ${result.skippedUnknownCategory}`);
  }

  if (dryRun) {
    console.log('\n(--dry-run: nothing written to the sheet)');
    return;
  }

  if (result.new.length > 0) {
    const rows = result.new.map(item => ({
      title: item.title,
      url: item.url,
      type: item.type,
      region: item.region,
      pubDate: item.date,
      rawCategory: item.rawCategory,
      guid: item.guid,
      description: item.description,
    }));
    await appendRssExtractionRows(rows);
  }
})().catch(err => {
  console.error('❌ RSS watcher failed:', err.message);
  process.exit(1);
});
