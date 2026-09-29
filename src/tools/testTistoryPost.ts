/**
 * Test posting a New Logic row's Title + Blog Content to Tistory.
 *
 *   npx tsx src/tools/testTistoryPost.ts <rowIndex> <nickname> [blogName]
 *
 * blogName (the account's own subdomain, e.g. "mystory95853" for
 * mystory95853.tistory.com) is optional if the account already has it set
 * in .accounts/accounts-tistory.json.
 *
 * Example:
 *   npx tsx src/tools/testTistoryPost.ts 2 myaccount mystory95853
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { loginToTistory, closeTistoryBrowser, getTistoryAccountByNickname } from '../browser/tistory/login.js';
import { postToTistory } from '../browser/tistory/poster.js';

const rowIndex = parseInt(process.argv[2] || '', 10);
const nickname = process.argv[3];
const blogNameArg = process.argv[4];

if (!rowIndex || !nickname) {
  console.error('Usage: npx tsx src/tools/testTistoryPost.ts <rowIndex> <nickname> [blogName]');
  process.exit(1);
}

(async () => {
  const account = getTistoryAccountByNickname(nickname);
  const blogName = blogNameArg || account?.blogName;
  if (!blogName) {
    console.error(`❌ No blogName given and none set for "${nickname}" in .accounts/accounts-tistory.json`);
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

  console.log(`\nLogging in to Tistory (${nickname})...`);
  let page;
  try {
    page = await loginToTistory(nickname);
  } catch (err: any) {
    console.error(`❌ Login failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\nPosting to Tistory...\n');
  try {
    const result = await postToTistory(page, { blogName, title: row.title, content: row.blogContent });
    console.log('\n✅ Result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error(`❌ Post failed: ${err.message}`);
  } finally {
    await closeTistoryBrowser();
  }

  process.exit(0);
})();
