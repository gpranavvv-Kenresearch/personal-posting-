/**
 * generateSocialPosts.ts — standalone content generator for FB / LinkedIn
 *
 * Run manually from the terminal:
 *   npx tsx src/tools/generateSocialPosts.ts fb [limit]
 *   npx tsx src/tools/generateSocialPosts.ts li [limit]
 *
 * Picks the next pending rows (same sequential picker the real batch uses),
 * generates a post for any row that doesn't already have one, and writes it
 * straight back to the sheet. Does NOT post to Facebook/LinkedIn — that still
 * happens later via the normal batch run, which already skips regeneration
 * when it finds non-empty content in the row.
 */

import 'dotenv/config';
import {
  getRowsForContinuousFbPosting,
  getRowsForContinuousLiPosting,
  saveUnifiedFbResult,
  saveUnifiedLinkedInResult,
} from '../sheets/sheets.js';
import { generateFbPostFromFivePrompts, generateLiPostFromFivePrompts } from '../agents/contentAgentNew.js';
import { closeChatGptBrowser } from '../browser/chatgpt/login.js';

type Platform = 'fb' | 'li';

async function run(): Promise<void> {
  const platform = (process.argv[2] || '').toLowerCase() as Platform;
  if (platform !== 'fb' && platform !== 'li') {
    console.error('Usage: npx tsx src/tools/generateSocialPosts.ts <fb|li> [limit]');
    process.exit(1);
  }
  const limit = Number(process.argv[3]) || 15;

  const rows = platform === 'fb'
    ? await getRowsForContinuousFbPosting(limit)
    : await getRowsForContinuousLiPosting(limit);

  if (rows.length === 0) {
    console.log(`[${platform.toUpperCase()}] No pending rows found.`);
    return;
  }

  console.log(`[${platform.toUpperCase()}] ${rows.length} row(s) picked.\n`);

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const row of rows) {
      const existing = (platform === 'fb' ? row.fbPost : row.linkedinPost)?.trim() || '';
      console.log(`Row ${row.rowIndex}: ${row.title.slice(0, 60)}`);

      if (existing) {
        console.log('  ⏭  Already has generated content — skipping.\n');
        skipped++;
        continue;
      }

      try {
        const post = platform === 'fb'
          ? await generateFbPostFromFivePrompts({ url: row.targetUrl, title: row.title })
          : await generateLiPostFromFivePrompts({ url: row.targetUrl, title: row.title });

        if (!post?.trim()) {
          console.log('  ⚠️  Generated content was empty — not saving.\n');
          failed++;
          continue;
        }

        if (platform === 'fb') {
          await saveUnifiedFbResult(row, { post, postUrl: '', status: 'Generated', error: '' });
        } else {
          await saveUnifiedLinkedInResult(row, { post, postUrl: '', status: 'Generated', error: '' });
        }

        console.log('  ✅ Generated and saved to sheet.\n');
        generated++;
      } catch (err: any) {
        console.log(`  ❌ Generation failed: ${err.message}\n`);
        failed++;
      }
    }
  } finally {
    // Always release the ChatGPT browser profile — leaving it open blocks the
    // next run of this script (or any other) from launching against the same
    // persistent session directory.
    await closeChatGptBrowser();
  }

  console.log(`[${platform.toUpperCase()}] Done — ${generated} generated, ${skipped} already had content, ${failed} failed.`);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
