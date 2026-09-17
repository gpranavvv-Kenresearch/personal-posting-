/**
 * backfillRssSince.ts — force the RSS watcher to poll from an arbitrary past
 * date instead of its saved last-poll-date, then restore normal cadence.
 * Useful for backfilling a day the daemon missed.
 *
 * Usage:
 *   npx tsx src/tools/backfillRssSince.ts 2026-09-15
 */
import 'dotenv/config';
import { setLastPollDate } from '../reportDiscovery/rssPollState.js';
import { runRssReportWatcher } from '../reportDiscovery/watcher.js';
import { appendRssExtractionRows } from '../sheets/sheets.js';

const since = process.argv[2];
if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error('Usage: npx tsx src/tools/backfillRssSince.ts YYYY-MM-DD');
  process.exit(1);
}

(async () => {
  setLastPollDate(since);
  const result = await runRssReportWatcher();

  console.log(`\nSince: ${result.since}`);
  console.log(`New items: ${result.new.length}`);
  for (const item of result.new) {
    console.log(`  [${item.type}]${item.region ? ` (${item.region})` : ''} ${item.title} → ${item.url}`);
  }
  if (result.skippedUnknownCategory > 0) {
    console.log(`\nSkipped (unknown category): ${result.skippedUnknownCategory}`);
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
  console.error('❌ Backfill failed:', err.message);
  process.exit(1);
});
