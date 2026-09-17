/**
 * Test posting to LinkedIn WITH an image, using a Blogs-tab row's title,
 * Target URL, and "Social Post Image Path" (from socialPostImageAgent.ts).
 *
 *   npx tsx src/tools/testLinkedinImagePost.ts <rowIndex> [linkedinNickname]
 *
 * Example:
 *   npx tsx src/tools/testLinkedinImagePost.ts 2
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { generateLiPost } from '../agents/contentAgentNew.js';
import { loginToLinkedIn, closeLinkedInBrowser } from '../browser/linkedin/login.js';
import { postToLinkedInWithImage } from '../browser/linkedin/imagePoster.js';

const rowIndex = parseInt(process.argv[2] || '', 10);
const nickname = process.argv[3];

if (!rowIndex) {
  console.error('Usage: npx tsx src/tools/testLinkedinImagePost.ts <rowIndex> [linkedinNickname]');
  process.exit(1);
}

(async () => {
  console.log(`\nFetching Blogs row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'blog');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in Blogs sheet`);
    process.exit(1);
  }

  console.log(`   Title      : ${row.title}`);
  console.log(`   Target URL : ${row.targetUrl || '(none)'}`);
  console.log(`   Image path : ${row.socialPostImagePath || '(none)'}`);

  if (!row.socialPostImagePath) {
    console.error('❌ This row has no "Social Post Image Path" yet — run runSocialPostImageLocal.ts first.');
    process.exit(1);
  }

  console.log('\nGenerating LinkedIn post text...');
  const postText = await generateLiPost({
    url: row.targetUrl || '',
    title: row.title,
    seoRanking: 999,
    priority: row.priority || 'P3',
  });
  console.log(`\n--- POST TEXT (${postText.length} chars) ---\n${postText}\n`);

  console.log('Logging in to LinkedIn...');
  let page;
  try {
    page = await loginToLinkedIn(nickname ? { nickname } : undefined);
  } catch (err: any) {
    console.error(`❌ Login failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\nPosting to LinkedIn with image...\n');
  try {
    const result = await postToLinkedInWithImage(page, postText, row.socialPostImagePath);
    console.log('\n✅ Result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error(`❌ Post failed: ${err.message}`);
  } finally {
    await closeLinkedInBrowser();
  }

  process.exit(0);
})();
