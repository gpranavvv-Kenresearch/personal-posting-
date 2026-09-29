/**
 * Test posting a tweet WITH an image, pulled directly from a Social Media
 * sheet row's "Images URL" column (the same local-file-path image the
 * li-carousel/run_single_image_test.js script writes there for LI image
 * posts — see testInstagramImagePost.ts for the same pattern) and "X Post"
 * column for the tweet text.
 *
 *   npx tsx src/tools/testXImagePost.ts <rowIndex> [accountHandle]
 *
 * Example:
 *   npx tsx src/tools/testXImagePost.ts 2 pranav
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { runXAgent } from '../agents/xAgentNew.js';
import { generateTweet } from '../agents/contentAgentNew.js';

const rowIndex = parseInt(process.argv[2] || '', 10);
const accountHandle = process.argv[3] || 'pranav';

if (!rowIndex) {
  console.error('Usage: npx tsx src/tools/testXImagePost.ts <rowIndex> [accountHandle]');
  process.exit(1);
}

(async () => {
  console.log(`\nFetching Social Media row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'social');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in Social Media sheet`);
    process.exit(1);
  }

  console.log(`   Title      : ${row.title}`);
  console.log(`   Image path : ${row.imagesUrl || '(none)'}`);
  console.log(`   X Post     : ${(row.xPost || '').slice(0, 80)}`);

  if (!row.imagesUrl) {
    console.error('❌ This row has no "Images URL" yet — run the li-carousel run_single_image_test.js script for this row first.');
    process.exit(1);
  }

  // Same fallback as masterCoordinator.ts's runXBatch — use the sheet's
  // pre-written "X Post" text if present, otherwise generate one via AI.
  let tweetText = row.xPost?.trim() || '';
  if (!tweetText) {
    console.log('   ℹ️  No sheet content — generating tweet via AI...');
    tweetText = await generateTweet({
      url: row.targetUrl ?? '',
      title: row.title,
      seoRanking: 999,
      priority: row.priority ?? 'P3',
      marketValue: row.marketValue,
    });
  }
  if (!tweetText?.trim()) {
    console.error('❌ Could not get or generate tweet text for this row.');
    process.exit(1);
  }

  console.log(`\nPosting to X (@${accountHandle}) with image...\n`);
  const result = await runXAgent({ tweetText, accountHandle, imagePath: row.imagesUrl });
  console.log('\n✅ Result:', JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
})();
