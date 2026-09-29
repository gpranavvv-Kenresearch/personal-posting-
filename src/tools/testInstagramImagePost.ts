/**
 * Test posting to Instagram WITH an image, using a Social Media row's Title
 * (as caption) and "Images URL" column — the same local-file-path image the
 * li-carousel/run_single_image_test.js script writes there for LI image posts.
 *
 *   npx tsx src/tools/testInstagramImagePost.ts <rowIndex> [instagramNickname]
 *
 * Example:
 *   npx tsx src/tools/testInstagramImagePost.ts 2
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { loginToInstagram, closeInstagramBrowser, getInstagramAccountByNickname } from '../browser/instagram/login.js';
import { postToInstagram } from '../browser/instagram/poster.js';

const rowIndex = parseInt(process.argv[2] || '', 10);
const nickname = process.argv[3] || 'account1';

if (!rowIndex) {
  console.error('Usage: npx tsx src/tools/testInstagramImagePost.ts <rowIndex> [instagramNickname]');
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

  if (!row.imagesUrl) {
    console.error('❌ This row has no "Images URL" yet — run the li-carousel run_single_image_test.js script for this row first.');
    process.exit(1);
  }

  const caption = row.blogCaption || row.title || '';
  console.log(`\n--- CAPTION (${caption.length} chars) ---\n${caption}\n`);

  const account = getInstagramAccountByNickname(nickname);
  if (!account) {
    console.error(`❌ Instagram account "${nickname}" not found in .accounts/accounts-instagram.json`);
    process.exit(1);
  }

  console.log(`Logging in to Instagram (${account.username})...`);
  let page;
  try {
    page = await loginToInstagram(account);
  } catch (err: any) {
    console.error(`❌ Login failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\nPosting to Instagram with image...\n');
  try {
    const result = await postToInstagram(page, { filePath: row.imagesUrl, description: caption });
    console.log('\n✅ Result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error(`❌ Post failed: ${err.message}`);
  } finally {
    await closeInstagramBrowser();
  }

  process.exit(0);
})();
