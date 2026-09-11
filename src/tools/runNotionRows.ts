/**
 * Run Notion posting for a range of rows by sheet index.
 *   npx tsx src/tools/runNotionRows.ts <fromRow> <toRow>
 *   Example: npx tsx src/tools/runNotionRows.ts 5 20
 */
import 'dotenv/config';
import { getSheetRowByIndex, saveUnifiedNotionResult } from '../sheets/sheets.js';
import { executeBrowserTool } from '../tools/browserTools.js';
import { ensureTargetUrl } from '../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const fromRow = parseInt(process.argv[2] || '0', 10);
const toRow   = parseInt(process.argv[3] || '0', 10);

if (!fromRow || !toRow || fromRow > toRow) {
  console.error('Usage: npx tsx src/tools/runNotionRows.ts <fromRow> <toRow>');
  console.error('Example: npx tsx src/tools/runNotionRows.ts 5 20');
  process.exit(1);
}

(async () => {
  console.log(`\n🚀 Notion batch: rows ${fromRow} → ${toRow}\n`);
  let posted = 0, skipped = 0, failed = 0;

  for (let i = fromRow; i <= toRow; i++) {
    console.log(`\n──── Row ${i} (${i - fromRow + 1}/${toRow - fromRow + 1}) ────`);

    const row = await getSheetRowByIndex(i, 'blog');
    if (!row) {
      console.warn(`⚠️  Row ${i} not found — skipping`);
      skipped++;
      continue;
    }

    console.log(`   Title   : ${row.title}`);
    console.log(`   Account : ${row.name}`);

    if (!row.blogContent) {
      console.warn(`⚠️  Row ${i} has no blog content — skipping`);
      skipped++;
      continue;
    }

    const title   = row.title;
    const content = ensureTargetUrl(row.blogContent, row.targetUrl);

    const loginResult = await executeBrowserTool('login_notion', { nickname: row.name });
    if (!loginResult.success) {
      console.error(`❌ Login failed: ${loginResult.error}`);
      await saveUnifiedNotionResult(row, { postUrl: '', status: 'Failed', batch: 'Manual', error: loginResult.error });
      failed++;
      await sleep(3000);
      continue;
    }

    const postResult = await executeBrowserTool('post_notion', { title, htmlContent: content });

    if (postResult.success) {
      console.log(`✅ Posted: ${postResult.postUrl}`);
      await saveUnifiedNotionResult(row, { postUrl: postResult.postUrl || '', status: 'Posted', batch: 'Manual' });
      posted++;
    } else {
      console.error(`❌ Post failed: ${postResult.error}`);
      await saveUnifiedNotionResult(row, { postUrl: '', status: 'Failed', batch: 'Manual', error: postResult.error });
      failed++;
    }

    if (i < toRow) await sleep(3000);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Posted: ${posted}  ⚠️ Skipped: ${skipped}  ❌ Failed: ${failed}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.exit(0);
})();
