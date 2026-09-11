/**
 * Run LinkedIn Pulse posting for a single blog sheet row.
 *   npx tsx src/tools/runLinkedinPulseRow.ts 112
 */
import 'dotenv/config';
import { getSheetRowByIndex, saveLinkedinPulseResult } from '../sheets/sheets.js';
import { executeBrowserTool } from '../tools/browserTools.js';

const rowIndex = parseInt(process.argv[2] || '112', 10);

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
    console.error('❌ No blog content — cannot post');
    process.exit(1);
  }

  try {
    const loginResult = await executeBrowserTool('login_linkedin_pulse', { nickname: row.name });
    if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
    console.log(`   ✅ Logged in as ${row.name}`);

    const postResult = await executeBrowserTool('post_linkedin_pulse', {
      title: row.title,
      htmlContent: row.blogContent,
      seoTitle: row.descriptionTitle || row.title,
      seoDescription: row.description || '',
    });

    if (!postResult.success) throw new Error(postResult.error || 'Post failed');

    console.log(`   ✅ Posted: ${postResult.postUrl}`);

    await saveLinkedinPulseResult(row, {
      postUrl: postResult.postUrl || '',
      status: 'Posted',
      error: '',
      batch: 'Manual',
    });
    console.log(`   ✅ Sheet updated`);
  } catch (err: any) {
    console.error(`   ❌ Failed: ${err.message}`);
    await saveLinkedinPulseResult(row, {
      postUrl: '',
      status: 'Failed',
      error: err.message,
      batch: 'Manual',
    }).catch(() => {});
    process.exit(1);
  }

  process.exit(0);
})();
