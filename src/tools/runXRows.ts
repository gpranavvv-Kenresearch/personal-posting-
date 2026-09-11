/**
 * Run X (Twitter) posting for specific rows by sheet index.
 * Mirrors runLinkedinRows.ts, but for X — generates content if the row's X
 * Post cell is empty, then posts live via the real production X agent.
 *   npx tsx src/tools/runXRows.ts 703
 */
import 'dotenv/config';
import { getSheetRowByIndex, saveSocialSlotResult } from '../sheets/sheets.js';
import { runXAgent } from '../agents/xAgentNew.js';
import { generateTweet } from '../agents/contentAgentNew.js';

const rowIndexes = process.argv.slice(2).map(n => parseInt(n, 10));

if (rowIndexes.length === 0) {
  console.error('Usage: npx tsx src/tools/runXRows.ts <row1> [row2] ...');
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
    console.log(`   [${idx}] account: ${row.name} | xPost: ${row.xPost ? row.xPost.slice(0, 60) + '...' : '(empty)'}`);
    rows.push({ idx, row });
  }

  if (rows.length === 0) {
    console.error('❌ No valid rows found');
    process.exit(1);
  }

  const results = [];

  for (const { idx, row } of rows) {
    const nickname = row.name;
    let tweetText = row.xPost || '';

    if (!tweetText) {
      console.log(`   Row ${idx} has no xPost — generating...`);
      try {
        tweetText = await generateTweet({
          url: row.targetUrl || '',
          title: row.title || '',
          seoRanking: 100,
          priority: row.priority || 'P3',
          marketValue: row.marketValue,
        });
        console.log(`   ✅ Generated: ${tweetText.slice(0, 80)}...`);
      } catch (genErr: any) {
        console.error(`   ❌ Generation failed: ${genErr.message}`);
        results.push({ idx, nickname, success: false, error: `Content generation failed: ${genErr.message}` });
        continue;
      }
    }

    console.log(`\n[Row ${idx}] Posting as ${nickname}...`);

    try {
      const result = await runXAgent({ tweetText, accountHandle: nickname });
      if (!result.success) {
        throw new Error(result.error || 'Post failed');
      }

      console.log(`   ✅ Posted: ${result.tweetUrl || '(no url)'}`);

      await saveSocialSlotResult(idx, 1, 'X', {
        url: result.tweetUrl || '',
        status: 'Posted',
        batch: 'Manual',
      });
      console.log(`   ✅ Sheet updated`);
      results.push({ idx, nickname, success: true, postUrl: result.tweetUrl });
    } catch (err: any) {
      console.error(`   ❌ Row ${idx} failed: ${err.message}`);
      await saveSocialSlotResult(idx, 1, 'X', {
        url: '',
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
