/**
 * Run LinkedIn posting for specific rows by sheet index.
 * Bypasses Claude API orchestration — calls browser tools directly.
 *   npx tsx src/tools/runLinkedinRows.ts 438 442 444 447 448
 */
import 'dotenv/config';
import { getSheetRowByIndex, saveUnifiedLinkedInResult } from '../sheets/sheets.js';
import { executeBrowserTool } from '../tools/browserTools.js';
import { generateLiPost } from '../agents/contentAgentNew.js';

const rowIndexes = process.argv.slice(2).map(n => parseInt(n, 10));

if (rowIndexes.length === 0) {
  console.error('Usage: npx tsx src/tools/runLinkedinRows.ts <row1> [row2] ...');
  process.exit(1);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\nFetching social sheet rows: ${rowIndexes.join(', ')}...`);

  const rows = [];
  for (const idx of rowIndexes) {
    const row = await getSheetRowByIndex(idx, 'social');
    if (!row) {
      console.warn(`⚠️  Row ${idx} not found — skipping`);
      continue;
    }
    console.log(`   [${idx}] account: ${row.name} | liPost: ${row.linkedinPost ? row.linkedinPost.slice(0, 60) + '...' : '(empty)'}`);
    rows.push({ idx, row });
  }

  if (rows.length === 0) {
    console.error('❌ No valid rows found');
    process.exit(1);
  }

  const results = [];

  for (const { idx, row } of rows) {
    const nickname = row.name;
    let postText = row.linkedinPost || '';

    if (!postText) {
      console.log(`   Row ${idx} has no linkedinPost — generating via OpenRouter...`);
      try {
        postText = await generateLiPost({
          url: row.targetUrl || '',
          title: row.title || '',
          seoRanking: 100,
          priority: 'P3',
        });
        console.log(`   ✅ Generated: ${postText.slice(0, 80)}...`);
      } catch (genErr: any) {
        console.error(`   ❌ Generation failed: ${genErr.message}`);
        results.push({ idx, nickname, success: false, error: `Content generation failed: ${genErr.message}` });
        continue;
      }
    }

    console.log(`\n[Row ${idx}] Posting as ${nickname}...`);

    try {
      const loginResult = await executeBrowserTool('login_linkedin', { nickname });
      if (!loginResult.success) {
        throw new Error(loginResult.error || 'Login failed');
      }
      console.log(`   ✅ Logged in as ${nickname}`);

      const postResult = await executeBrowserTool('post_linkedin', { nickname, postText });
      if (!postResult.success) {
        throw new Error(postResult.error || 'Post failed');
      }

      postText = postResult.postText || postText;
      const postUrl = postResult.postUrl || '';
      console.log(`   ✅ Posted: ${postUrl || '(no url)'}`);

      await saveUnifiedLinkedInResult(row, {
        post: postText,
        postUrl,
        status: 'Posted',
        batch: 'Manual',
      });
      console.log(`   ✅ Sheet updated`);
      results.push({ idx, nickname, success: true, postUrl });
    } catch (err: any) {
      console.error(`   ❌ Row ${idx} failed: ${err.message}`);
      await saveUnifiedLinkedInResult(row, {
        post: postText,
        postUrl: '',
        status: 'Failed',
        error: err.message,
        batch: 'Manual',
      }).catch(() => {});
      results.push({ idx, nickname, success: false, error: err.message });
    }

    await sleep(2000);
  }

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})();
