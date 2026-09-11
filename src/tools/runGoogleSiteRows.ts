/**
 * Run Google Sites posting for a range of rows.
 *   npx tsx src/tools/runGoogleSiteRows.ts 56 61
 */
import 'dotenv/config';
import { getSheetRowByIndex, saveUnifiedGoogleSiteResult } from '../sheets/sheets.js';
import { executeBrowserTool } from '../tools/browserTools.js';
import { ensureTargetUrl } from '../utils/utm.js';

const fromRow = parseInt(process.argv[2] || '0', 10);
const toRow   = parseInt(process.argv[3] || '0', 10);

if (!fromRow || !toRow) {
  console.error('Usage: npx tsx src/tools/runGoogleSiteRows.ts <fromRow> <toRow>');
  process.exit(1);
}

(async () => {
  for (let i = fromRow; i <= toRow; i++) {
    console.log(`\n========== Row ${i} ==========`);
    const row = await getSheetRowByIndex(i, 'blog');
    if (!row) { console.warn(`Row ${i} not found, skipping`); continue; }

    console.log(`   Title   : ${row.title?.slice(0, 70)}`);
    console.log(`   Account : ${row.name}`);

    if (!row.blogContent) {
      console.warn(`   No blog content — skipping`);
      await saveUnifiedGoogleSiteResult(row, { postUrl: '', slug: '', status: 'Failed', batch: 'Manual', error: 'No blog content' });
      continue;
    }

    const title = row.title || row.descriptionTitle || '';
    const content = ensureTargetUrl(row.blogContent, row.targetUrl);

    const loginResult = await executeBrowserTool('login_googlesite', { nickname: row.name });
    if (!loginResult.success) {
      console.error(`   Login failed: ${loginResult.error}`);
      await saveUnifiedGoogleSiteResult(row, { postUrl: '', slug: '', status: 'Failed', batch: 'Manual', error: loginResult.error });
      continue;
    }

    const postResult = await executeBrowserTool('post_googlesite', { title, htmlContent: content, seedKeyword: row.seedKeyword });
    if (postResult.success) {
      console.log(`   ✅ Posted: ${postResult.postUrl}`);
      await saveUnifiedGoogleSiteResult(row, { postUrl: postResult.postUrl || '', slug: postResult.slug || '', status: 'Posted', batch: 'Manual' });
    } else {
      console.error(`   ❌ Failed: ${postResult.error}`);
      await saveUnifiedGoogleSiteResult(row, { postUrl: '', slug: '', status: 'Failed', batch: 'Manual', error: postResult.error });
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\nDone.');
  process.exit(0);
})();
