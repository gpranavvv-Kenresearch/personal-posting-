/**
 * runReportWatcher.ts — poll kenresearch.com's sitemaps for new
 * reports/articles/surveys/etc. and append newly-found ones to the Sheet
 * so the existing 23-platform pipeline picks them up automatically.
 *
 * Usage:
 *   npx tsx src/tools/runReportWatcher.ts             # normal run
 *   npx tsx src/tools/runReportWatcher.ts --dry-run    # print what would be appended, don't write
 */
import 'dotenv/config';
import { runReportWatcher } from '../reportDiscovery/watcher.js';
import { appendDiscoveredReportRows } from '../sheets/sheets.js';

const dryRun = process.argv.includes('--dry-run');

(async () => {
  const result = await runReportWatcher();

  if (result.bootstrap) {
    console.log('\n🌱 First run — seen-list bootstrapped. Only recent items (last 3 days) are being added.');
  }

  console.log(`\nNew items: ${result.new.length}`);
  for (const item of result.new) {
    console.log(`  [${item.type}]${item.region ? ` (${item.region})` : ''} ${item.title} → ${item.url}`);
  }

  if (result.updated.length > 0) {
    console.log(`\nUpdated (re-touched, NOT posted) — ${result.updated.length}:`);
    for (const item of result.updated.slice(0, 10)) {
      console.log(`  [${item.type}] ${item.url} (lastmod now ${item.lastmod})`);
    }
    if (result.updated.length > 10) console.log(`  ...and ${result.updated.length - 10} more`);
  }

  if (dryRun) {
    console.log('\n(--dry-run: nothing written to the sheet)');
    return;
  }

  if (result.new.length > 0) {
    const rows = result.new.map(item => ({
      title: item.title,
      targetUrl: item.url,
      date: item.lastmod,
      type: item.type,
      region: item.region,
    }));
    await appendDiscoveredReportRows(rows);
  }
})().catch(err => {
  console.error('❌ Report watcher failed:', err.message);
  process.exit(1);
});
