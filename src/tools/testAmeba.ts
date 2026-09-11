/**
 * Test Ameba posting for a single blog sheet row.
 *   npx tsx src/tools/testAmeba.ts 10
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { loginToAmeba, closeAmebaBrowser } from '../browser/ameba/login.js';
import { postToAmeba } from '../browser/ameba/poster.js';
import { generateHackmdPost } from '../agents/contentAgentNew.js';
import { injectUTM, UTM_PARAMS, ensureTargetUrl } from '../utils/utm.js';

const rowIndex = parseInt(process.argv[2] || '10', 10);

(async () => {
  console.log(`\nFetching blog sheet row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'blog');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in Blogs sheet`);
    process.exit(1);
  }

  console.log(`   Title   : ${row.title}`);
  console.log(`   Account : ${row.name}`);
  console.log(`   Content : ${row.blogContent ? row.blogContent.slice(0, 80) + '...' : '(empty — will generate)'}`);

  let content = row.blogContent || await generateHackmdPost(row);
  content = ensureTargetUrl(content, row.targetUrl);
  content = injectUTM(content, UTM_PARAMS.Ameba);

  const title = row.title || row.descriptionTitle || '';

  console.log('\nLogging in to Ameba (nickname: pranav)...');
  let page;
  try {
    page = await loginToAmeba({ nickname: 'pranav' });
  } catch (err: any) {
    console.error(`❌ Login failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\nPosting to Ameba...\n');
  try {
    const result = await postToAmeba(page, title, content);
    console.log('\n✅ Result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error(`❌ Post failed: ${err.message}`);
  } finally {
    await closeAmebaBrowser();
  }

  process.exit(0);
})();
