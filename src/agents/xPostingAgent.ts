/**
 * xPostingAgent.ts — X (Twitter) Platform Specialist
 *
 * Owns the full X posting flow for a single row:
 *   generate tweet → sanity check → SEO optimize → login → post
 *
 * Does NOT write to Google Sheets — the caller saves results.
 */

import { SheetRow } from '../sheets/sheets.js';
import { XAccount } from '../config/accounts.js';
import { BatchContext } from './sanityAgent.js';
import { generateTweetFromSheetRow } from './contentGenerator.js';
import { runSanityCheck } from './sanityAgent.js';
import { runSeoOptimize } from './seoAgent.js';
import { loginToX, closeBrowser } from '../browser/twitter/login.js';
import { postTweet } from '../browser/twitter/poster.js';
import { humanDelay } from '../browser/stagehand.js';

const MAX_GENERATION_RETRIES = 3;
const MIN_SEO_SCORE_TO_POST = 70;

export interface XPostResult {
  success: boolean;
  tweetUrl: string;
  tweetText: string;
  seoScore: number;
  sanityIssues: string[];
  error?: string;
}

export async function runXPostingAgent(
  row: SheetRow,
  account: XAccount,
  batchCtx?: BatchContext,
): Promise<XPostResult> {
  // ── Step 1: Generate tweet → sanity → SEO (with retry loop) ──────────────
  let tweet = row.xPost || '';
  let finalSeoScore = 0;
  let readyToPost = false;
  let allSanityIssues: string[] = [];

  if (tweet) {
    console.log(`   ♻️  Using existing tweet from sheet`);
    const sanity = await runSanityCheck(tweet, row, batchCtx);
    allSanityIssues = sanity.issues;
    if (!sanity.valid) {
      return { success: false, tweetUrl: '', tweetText: tweet, seoScore: 0, sanityIssues: allSanityIssues, error: `Sanity: ${sanity.issues.join(' | ')}` };
    }
    if (sanity.sanitized) tweet = sanity.sanitized;
    const seo = await runSeoOptimize(tweet, row);
    finalSeoScore = seo.seoScore;
    tweet = seo.optimized;
    readyToPost = true;
  } else {
    for (let attempt = 1; attempt <= MAX_GENERATION_RETRIES; attempt++) {
      if (attempt > 1) console.log(`   🔄 Regenerating tweet (attempt ${attempt}/${MAX_GENERATION_RETRIES})...`);

      try {
        tweet = await generateTweetFromSheetRow({
          targetUrl: row.targetUrl,
          marketValue: row.marketValue,
          title: row.title,
        });
      } catch (err: any) {
        return { success: false, tweetUrl: '', tweetText: '', seoScore: 0, sanityIssues: [], error: `Generation failed: ${err.message}` };
      }

      const sanity = await runSanityCheck(tweet, row, batchCtx);
      allSanityIssues = sanity.issues;
      if (!sanity.valid) {
        console.log(`   ⚠️  Sanity failed (attempt ${attempt}) — retrying...`);
        continue;
      }
      if (sanity.sanitized) tweet = sanity.sanitized;

      const seo = await runSeoOptimize(tweet, row);
      finalSeoScore = seo.seoScore;
      tweet = seo.optimized;

      if (finalSeoScore >= MIN_SEO_SCORE_TO_POST) {
        readyToPost = true;
        break;
      }
      console.log(`   ⚠️  SEO score ${finalSeoScore} < ${MIN_SEO_SCORE_TO_POST} (attempt ${attempt}) — retrying generation...`);
    }
  }

  if (!readyToPost) {
    return {
      success: false,
      tweetUrl: '',
      tweetText: tweet,
      seoScore: finalSeoScore,
      sanityIssues: allSanityIssues,
      error: `SEO score ${finalSeoScore} < ${MIN_SEO_SCORE_TO_POST} after ${MAX_GENERATION_RETRIES} attempts`,
    };
  }

  console.log(`   📊 SEO score: ${finalSeoScore}/100`);

  // ── Step 2: Login to X ────────────────────────────────────────────────────
  let page: any;
  try {
    console.log(`   🔐 Logging in as @${account.handle}...`);
    page = await loginToX(account);
    console.log(`   ✅ Session ready for @${account.handle}`);
  } catch (err: any) {
    await closeBrowser();
    return { success: false, tweetUrl: '', tweetText: tweet, seoScore: finalSeoScore, sanityIssues: allSanityIssues, error: `Login failed: ${err.message}` };
  }

  // ── Step 3: Post tweet ────────────────────────────────────────────────────
  try {
    await humanDelay(2000, 4000);
    console.log(`   📝 Posting tweet for @${account.handle}...`);
    const result = await postTweet(page, tweet, account.handle);
    console.log(`   ✅ Posted!`);
    console.log(`   🔗 URL: ${result.tweetUrl}`);
    return { success: true, tweetUrl: result.tweetUrl, tweetText: tweet, seoScore: finalSeoScore, sanityIssues: allSanityIssues };
  } catch (err: any) {
    return { success: false, tweetUrl: '', tweetText: tweet, seoScore: finalSeoScore, sanityIssues: allSanityIssues, error: `Post failed: ${err.message}` };
  } finally {
    await closeBrowser();
    console.log(`   🔒 Browser closed for @${account.handle}`);
  }
}
