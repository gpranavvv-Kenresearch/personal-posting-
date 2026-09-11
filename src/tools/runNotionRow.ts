/**
 * Run Notion posting for a single row by sheet index.
 *   npx tsx src/tools/runNotionRow.ts <rowIndex>
 */
import 'dotenv/config';
import { getSheetRowByIndex, saveUnifiedNotionResult } from '../sheets/sheets.js';
import { executeBrowserTool } from '../tools/browserTools.js';
import { ensureTargetUrl } from '../utils/utm.js';

const rowIndex = parseInt(process.argv[2] || '0', 10);
if (!rowIndex) {
  console.error('Usage: npx tsx src/tools/runNotionRow.ts <rowIndex>');
  process.exit(1);
}

(async () => {
  console.log(`\nFetching blog sheet row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'blog');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in Blogs sheet`);
    process.exit(1);
  }

  console.log(`   Title   : ${row.title}`);
  console.log(`   Account : ${row.name}`);
  console.log(`   Content : ${row.blogContent ? row.blogContent.slice(0, 80) + '...' : '(empty)'}`);

  if (!row.blogContent) {
    console.error('❌ No blog content in row — cannot post');
    process.exit(1);
  }

  const title = row.title;
  const content = ensureTargetUrl(row.blogContent, row.targetUrl);

  console.log('\nLogging in to Notion...');
  const loginResult = await executeBrowserTool('login_notion', { nickname: row.name });
  if (!loginResult.success) {
    console.error(`❌ Login failed: ${loginResult.error}`);
    await saveUnifiedNotionResult(row, { postUrl: '', status: 'Failed', batch: 'Manual', error: loginResult.error });
    process.exit(1);
  }

  console.log('Posting to Notion...');
  const postResult = await executeBrowserTool('post_notion', { title, htmlContent: content });

  if (postResult.success) {
    console.log(`\n✅ Posted: ${postResult.postUrl}`);
    await saveUnifiedNotionResult(row, { postUrl: postResult.postUrl || '', status: 'Posted', batch: 'Manual' });
  } else {
    console.error(`\n❌ Post failed: ${postResult.error}`);
    await saveUnifiedNotionResult(row, { postUrl: '', status: 'Failed', batch: 'Manual', error: postResult.error });
  }

  process.exit(0);
})();
