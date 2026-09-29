/**
 * Test posting a New Logic row's Title + Blog Content to Mataroa via its
 * REST API (no browser at all).
 *
 *   npx tsx src/tools/testMataroaPost.ts <rowIndex>
 *
 * Example:
 *   npx tsx src/tools/testMataroaPost.ts 2
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { postToMataroaApi } from '../browser/mataroa/apiPoster.js';

const rowIndex = parseInt(process.argv[2] || '', 10);
if (!rowIndex) {
  console.error('Usage: npx tsx src/tools/testMataroaPost.ts <rowIndex>');
  process.exit(1);
}

(async () => {
  const apiKey = process.env.MATAROA_API_KEY;
  if (!apiKey) {
    console.error('❌ MATAROA_API_KEY not set in .env');
    process.exit(1);
  }

  console.log(`\nFetching New Logic row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'newLogic');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in New Logic sheet`);
    process.exit(1);
  }

  console.log(`   Title   : ${row.title}`);
  console.log(`   Content : ${row.blogContent ? row.blogContent.slice(0, 80) + '...' : '(empty)'}`);

  if (!row.blogContent) {
    console.error('❌ No blog content in row — cannot post');
    process.exit(1);
  }

  const result = await postToMataroaApi(apiKey, row.title, row.blogContent);
  console.log('\n✅ Result:', JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
})();
