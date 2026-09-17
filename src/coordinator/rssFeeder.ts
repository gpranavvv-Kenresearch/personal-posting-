/**
 * rssFeeder.ts — nightly (6:30 PM IST, after the day's last posting batch)
 * bridge from RSS Extraction into New Logic (blog) and Social Media,
 * combined with a same-run trigger of blog content generation for whatever
 * New Logic just got fed.
 *
 * Priority per channel, each with its own daily quota:
 *   1. Unfed RSS Extraction rows (never re-picked once fed — see
 *      getUnfedRssExtractionRows / markRssExtractionRowsFed).
 *   2. If short of quota, fill the remainder from the Distributed URL pool
 *      (R.P -> R.A -> R.S -> R.V, recycles when exhausted — see
 *      distributedUrlPool.ts). New Logic and Social Media each have their
 *      OWN cursor into that pool, so the same URL can be picked for both —
 *      one becomes a blog post, the other a social post, which is intended.
 *
 * New Logic quota: 100/night. Social Media quota: 200/night.
 * Old backlog already sitting in either tab is left alone — new rows just
 * queue up normally behind it (no priority-jump logic), per explicit
 * decision.
 */
import { runRssReportWatcher } from '../reportDiscovery/watcher.js';
import { pickFromDistributedUrlPool } from '../reportDiscovery/distributedUrlPool.js';
import {
  appendRssExtractionRows,
  getUnfedRssExtractionRows,
  markRssExtractionRowsFed,
  appendNewLogicFeedRows,
  appendSocialMediaFeedRows,
  getNewLogicRowsNeedingSocialPostImage,
  saveNewLogicSocialPostImagePath,
} from '../sheets/sheets.js';
import { runBlogGenBatch } from './blogGenLoop.js';
import { generateSocialPostImageLocalOnly } from '../agents/socialPostImageAgent.js';
import path from 'path';

const NEW_LOGIC_NIGHTLY_QUOTA = 100;
const SOCIAL_MEDIA_NIGHTLY_QUOTA = 200;
const SOCIAL_IMAGE_NIGHTLY_QUOTA = 10;
const SOCIAL_IMAGE_OUTPUT_DIR = path.resolve('generated_images/social-post-cards');

/** Final catch-up poll of the RSS feed right before the nightly feed runs, on top of the existing 30-min daytime cron. */
async function refreshRssExtraction(): Promise<void> {
  try {
    const result = await runRssReportWatcher();
    if (result.new.length > 0) {
      const rows = result.new.map(item => ({
        title: item.title,
        url: item.url,
        type: item.type,
        region: item.region,
        pubDate: item.date,
        rawCategory: item.rawCategory,
        guid: item.guid,
        description: item.description,
      }));
      await appendRssExtractionRows(rows);
    }
    console.log(`   📡 [Nightly Feed] RSS catch-up poll: ${result.new.length} new item(s).`);
  } catch (err: any) {
    console.error(`   ❌ [Nightly Feed] RSS catch-up poll failed: ${err.message}`);
  }
}

async function feedNewLogic(): Promise<number> {
  const unfed = await getUnfedRssExtractionRows('blog', NEW_LOGIC_NIGHTLY_QUOTA);
  const shortfall = NEW_LOGIC_NIGHTLY_QUOTA - unfed.length;
  const fallback = shortfall > 0 ? await pickFromDistributedUrlPool('newLogic', shortfall) : [];

  const feedRows = [
    ...unfed.map(r => ({ url: r.url, title: r.title, sourceTag: 'RSS' })),
    ...fallback.map(r => ({ url: r.url, title: r.title, sourceTag: r.sourceTab })),
  ];

  if (feedRows.length === 0) {
    console.log('   ℹ️  [Nightly Feed] New Logic: nothing to feed (no unfed RSS rows, pool exhausted).');
    return 0;
  }

  const appended = await appendNewLogicFeedRows(feedRows);
  if (unfed.length > 0) {
    await markRssExtractionRowsFed(unfed.map(r => r.rowIndex), 'blog');
  }
  console.log(`   ✅ [Nightly Feed] New Logic: fed ${appended} row(s) (${unfed.length} from RSS, ${fallback.length} from Distributed URL pool).`);
  return appended;
}

async function feedSocialMedia(): Promise<number> {
  const unfed = await getUnfedRssExtractionRows('social', SOCIAL_MEDIA_NIGHTLY_QUOTA);
  const shortfall = SOCIAL_MEDIA_NIGHTLY_QUOTA - unfed.length;
  const fallback = shortfall > 0 ? await pickFromDistributedUrlPool('socialMedia', shortfall) : [];

  const feedRows = [
    ...unfed.map(r => ({ url: r.url, title: r.title })),
    ...fallback.map(r => ({ url: r.url, title: r.title })),
  ];

  if (feedRows.length === 0) {
    console.log('   ℹ️  [Nightly Feed] Social Media: nothing to feed (no unfed RSS rows, pool exhausted).');
    return 0;
  }

  const appended = await appendSocialMediaFeedRows(feedRows);
  if (unfed.length > 0) {
    await markRssExtractionRowsFed(unfed.map(r => r.rowIndex), 'social');
  }
  console.log(`   ✅ [Nightly Feed] Social Media: fed ${appended} row(s) (${unfed.length} from RSS, ${fallback.length} from Distributed URL pool).`);
  return appended;
}

/**
 * Generates a branded social-card image (LI carousel / FB-LI-X text-post
 * card — separate from the blog hero cover) for up to
 * SOCIAL_IMAGE_NIGHTLY_QUOTA pending New Logic rows, via the dedicated
 * "social-image" ChatGPT account (must be logged in once manually — see
 * src/tools/loginChatGpt.ts). Runs one row at a time, same as blog gen.
 */
async function generateSocialImages(): Promise<void> {
  const rows = await getNewLogicRowsNeedingSocialPostImage(SOCIAL_IMAGE_NIGHTLY_QUOTA);
  if (rows.length === 0) {
    console.log('   ℹ️  [Nightly Feed] Social image: no New Logic rows pending.');
    return;
  }
  console.log(`   🖼️  [Nightly Feed] Generating ${rows.length} social-card image(s)...`);
  let done = 0;
  for (const row of rows) {
    try {
      const localPath = await generateSocialPostImageLocalOnly({
        title: row.title,
        reportUrl: row.targetUrl || '',
        outputDir: SOCIAL_IMAGE_OUTPUT_DIR,
      });
      await saveNewLogicSocialPostImagePath({ rowIndex: row.rowIndex }, localPath);
      done++;
    } catch (err: any) {
      console.error(`   ❌ [Nightly Feed] Social image failed for row ${row.rowIndex}: ${err.message}`);
    }
  }
  console.log(`   ✅ [Nightly Feed] Social image: ${done}/${rows.length} generated.`);
}

/**
 * Blog generation (text + cover image) for whatever's pending in New Logic,
 * plus social-card image generation — the two ChatGPT-driven generation
 * steps, with no RSS/Distributed-URL feeding. Safe to call standalone (e.g.
 * manually, if the 18:30 cron tick got missed) since both generation
 * functions already just pick whatever's pending on the sheet, regardless
 * of when or how those rows got there.
 */
export async function runGenerationOnly(): Promise<void> {
  console.log('\n🖊️  [Generation] Starting blog + social-image generation...');
  const genResult = await runBlogGenBatch({ limit: NEW_LOGIC_NIGHTLY_QUOTA, withImage: true });
  console.log(`   🖊️  [Generation] Blog: ${genResult.generated} generated, ${genResult.failed} failed, out of ${genResult.attempted} attempted.`);

  await generateSocialImages();
  console.log('🖊️  [Generation] Complete.');
}

/**
 * The full nightly run: refresh RSS Extraction, feed both channels, then
 * run generation (blog + social-card image) for whatever landed in New
 * Logic. Both generation steps run single-stream for now (~12-15 min/row
 * for blog via account1 text/account2 image, ~9 min/row for social-image
 * via its own dedicated "social-image" account) — not parallelized yet.
 */
export async function runNightlyRssFeed(): Promise<void> {
  console.log('\n🌙 [Nightly Feed] Starting...');
  await refreshRssExtraction();

  await feedNewLogic();
  await feedSocialMedia();

  await runGenerationOnly();

  console.log('🌙 [Nightly Feed] Complete.');
}
