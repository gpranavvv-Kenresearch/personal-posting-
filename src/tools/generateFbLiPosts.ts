/**
 * generateFbLiPosts.ts — one-shot FB + LinkedIn content generator
 *
 * Run manually from the terminal:
 *   npx tsx src/tools/generateFbLiPosts.ts [limit]
 *
 * Generates ONE post per row via ChatGPT (the Facebook prompt/style) and
 * reuses that exact text for LinkedIn too — the only difference between the
 * two saved versions is the UTM query string on the URL (utm_source=facebook
 * vs utm_source=linkedin; utm_medium/utm_campaign are identical for both).
 * This halves ChatGPT calls compared to generating FB and LI separately, and
 * keeps both platforms' content consistent.
 *
 * Does NOT post to Facebook/LinkedIn — that still happens later via the
 * normal batch run, which already skips regeneration when it finds
 * non-empty content in the row.
 */

import 'dotenv/config';
import {
  getRowsForContinuousFbPosting,
  saveUnifiedFbResult,
  saveUnifiedLinkedInResult,
} from '../sheets/sheets.js';
import { generateFbPostFromFivePrompts } from '../agents/contentAgentNew.js';
import { closeChatGptBrowser } from '../browser/chatgpt/login.js';

function fbPostToLiPost(fbPost: string): string {
  return fbPost.replace(/utm_source=facebook/gi, 'utm_source=linkedin');
}

async function run(): Promise<void> {
  const limit = Number(process.argv[2]) || 15;

  const rows = await getRowsForContinuousFbPosting(limit);

  if (rows.length === 0) {
    console.log('[FB+LI] No pending rows found.');
    return;
  }

  console.log(`[FB+LI] ${rows.length} row(s) picked.\n`);

  let fbGenerated = 0, fbSkipped = 0, fbFailed = 0;
  let liGenerated = 0, liSkipped = 0;

  try {
    for (const row of rows) {
      console.log(`Row ${row.rowIndex}: ${row.title.slice(0, 60)}`);

      let fbPost = (row.fbPost || '').trim();
      const fbAlreadyHadContent = !!fbPost;

      if (fbAlreadyHadContent) {
        console.log('  ⏭  FB already has generated content — reusing it for LI derivation.');
        fbSkipped++;
      } else {
        try {
          fbPost = await generateFbPostFromFivePrompts({ url: row.targetUrl, title: row.title });
          if (!fbPost?.trim()) {
            console.log('  ⚠️  FB generation came back empty — skipping row.\n');
            fbFailed++;
            continue;
          }
          await saveUnifiedFbResult(row, { post: fbPost, postUrl: '', status: 'Generated', error: '' });
          console.log('  ✅ FB generated and saved.');
          fbGenerated++;
        } catch (err: any) {
          console.log(`  ❌ FB generation failed: ${err.message}\n`);
          fbFailed++;
          continue;
        }
      }

      const liExisting = (row.linkedinPost || '').trim();
      if (liExisting) {
        console.log('  ⏭  LI already has generated content — leaving it as-is.\n');
        liSkipped++;
        continue;
      }

      const liPost = fbPostToLiPost(fbPost);
      await saveUnifiedLinkedInResult(row, { post: liPost, postUrl: '', status: 'Generated', error: '' });
      console.log('  ✅ LI derived from FB post (UTM swapped) and saved.\n');
      liGenerated++;
    }
  } finally {
    // Always release the ChatGPT browser profile — leaving it open blocks the
    // next run of this script (or any other) from launching against the same
    // persistent session directory.
    await closeChatGptBrowser();
  }

  console.log(`[FB+LI] Done — FB: ${fbGenerated} generated, ${fbSkipped} already had content, ${fbFailed} failed. LI: ${liGenerated} derived, ${liSkipped} already had content.`);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
