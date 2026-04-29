/**
 * masterCoordinator.ts — Batch Runner
 *
 * No cooldown logic — cron in scheduler-new.ts handles timing.
 * Each platform batch function is called directly by cron.
 *
 * X Batch  : SEO → generateTweet → post → save (seo data + xPostUrl + xBatch)
 * FB Batch : SEO (if not done) → generateFbPost → post → save (seo data + fbPostUrl + fbBatch)
 * LI Batch : SEO (if not done) → generateLiPost → post → save (seo data + liPostUrl + liBatch)
 */

import { recordError } from '../errorInterceptor.js';
import { applyFix } from '../autoFix.js';
import { runSeoAnalysis } from '../agents/seoAgentNew.js';
import { generateTweet, generateXThread, generateFbPost, generateLiPost, generateMediumPost, generateGoogleSitePost, generateDevtoPost, generateLinkedinPulsePost, generateCalisthenicsPost, generateSubstackPost, generateGuffizPost, generateHackmdPost, generateLinkmatePost } from '../agents/contentAgentNew.js';
import { runXAgent, runXThreadAgent } from '../agents/xAgentNew.js';
import { executeBrowserTool } from '../tools/browserTools.js';
import {
  getUnassignedRows,
  getUnassignedRowsAsSheetRows,
  getRowsForContinuousXPosting,
  getRowsForContinuousFbPosting,
  getRowsForContinuousLiPosting,
  getRowsForContinuousMediumPosting,
  getRowsForContinuousLinkmatePosting,
  getRowsForContinuousDevtoPosting,
  getRowsForContinuousGoogleSitePosting,
  getRowsForContinuousLinkedinPulsePosting,
  getRowsForContinuousCalisthenicsPosting,
  getRowsForContinuousSubstackPosting,
  getRowsForContinuousGuffizPosting,
  getRowsForContinuousHackmdPosting,
  savePostingResult,
  saveUnifiedSeoData,
  getUrlsDueForRecheck,
  saveWeeklySerpRecheck,
  getRowsReadyForMedium,
  getRowsReadyForHackmd,
  saveUnifiedMediumResult,
  saveUnifiedLinkmateResult,
  saveUnifiedGoogleSiteResult,
  saveUnifiedDevtoResult,
  saveLinkedinPulseResult,
  saveCalisthenicsResult,
  saveUnifiedSubstackResult,
  saveUnifiedGuffizResult,
  saveUnifiedHackmdResult,
  saveUnifiedWordpressResult,
  saveUnifiedBloggerResult,
  saveUnifiedPenzuResult,
  saveUnifiedWriteupCafeResult,
  getRowsReadyForWriteupCafe,
  getRowsForContinuousWriteupCafePosting,
  examineSundayFailedPosts,
  getSheetRowByIndex,
  SheetRow,
} from '../sheets/sheets.js';
import fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';

// ── Batch counter (persistent, ever-incrementing per platform) ───────────────

const COUNTERS_FILE = '.sessions/batch-counters.json';

interface BatchCounters {
  x: number;
  fb: number;
  li: number;
  medium: number;
  linkmate: number;
  googlesite: number;
  devto: number;
  linkedinpulse: number;
  calisthenics: number;
  substack: number;
  guffiz: number;
  hackmd: number;
  writeupcafe: number;
  // legacy field kept for backwards compat
  date?: string;
}

const ZERO_COUNTERS: BatchCounters = { x: 0, fb: 0, li: 0, medium: 0, linkmate: 0, googlesite: 0, devto: 0, linkedinpulse: 0, calisthenics: 0, substack: 0, guffiz: 0, hackmd: 0, writeupcafe: 0 };

function getCounters(): BatchCounters {
  if (!fs.existsSync(COUNTERS_FILE)) return { ...ZERO_COUNTERS };
  try {
    const saved = JSON.parse(fs.readFileSync(COUNTERS_FILE, 'utf8'));
    // Merge with zeros so any missing platform key starts at 0
    return { ...ZERO_COUNTERS, ...saved };
  } catch {
    return { ...ZERO_COUNTERS };
  }
}

function saveCounters(c: BatchCounters): void {
  fs.mkdirSync('.sessions', { recursive: true });
  // Strip legacy date field
  const { date: _date, ...rest } = c as any;
  fs.writeFileSync(COUNTERS_FILE, JSON.stringify(rest, null, 2));
}

export function resetBatchCounters(): void {
  saveCounters({ ...ZERO_COUNTERS });
  console.log('✅ Batch counters reset');
}

// ── Sunday Examination: Move Failed Posts to End ──────────────────────────────

export async function runSundayExamination(): Promise<void> {
  console.log(`\n[SUNDAY EXAMINATION] Checking for failed posts...`);
  try {
    await examineSundayFailedPosts();
    console.log(`[SUNDAY EXAMINATION] Complete`);
  } catch (err: any) {
    console.error(`[SUNDAY EXAMINATION] Error: ${err.message}`);
  }
}

// ── Reset posting data for retesting ──────────────────────────────────────────

export async function resetMediumPosts(): Promise<void> {
  const sheetModule = await import('../sheets/sheets.js');

  console.log('📄 Fetching all rows...');
  const rows = await sheetModule.getRowsReadyForMedium(999);

  if (rows.length === 0) {
    console.log('✅ No Medium posts to reset');
    return;
  }

  console.log(`📝 Resetting ${rows.length} rows...`);

  for (const row of rows) {
    try {
      await sheetModule.saveUnifiedMediumResult(row, {
        post: '',
        postUrl: '',
        status: '',
        error: '',
        batch: '',
      });
    } catch (err: any) {
      console.warn(`  ⚠️  Could not reset row ${row.rowIndex}: ${err.message}`);
    }
  }

  console.log(`✅ Reset ${rows.length} Medium rows`);
}

// ── AI Error Diagnosis (Claude Brain) ──────────────────────────────────────────

async function diagnoseError(
  errorMessage: string,
  context: {
    rowTitle?: string;
    rowIndex?: number;
    platform?: string;
    stage?: string;
  }
): Promise<string> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return '⚠️ No API key found for error diagnosis';
    }

    const client = new Anthropic({ apiKey });
    const prompt = `You are an expert error diagnosis system. Analyze this error and provide a BRIEF (1-2 sentences) fix suggestion.

Error: ${errorMessage}
Context: Row "${context.rowTitle}" (${context.rowIndex}) during ${context.platform || 'unknown'} ${context.stage || 'processing'}

Respond with ONLY the fix suggestion, nothing else. Example: "This is a timeout. Try increasing the delay between requests to 2 seconds."`;

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const textContent = response.content.find(c => c.type === 'text');
    return textContent && textContent.type === 'text' ? textContent.text.trim() : 'Unable to diagnose';
  } catch (err: any) {
    return `⚠️ Diagnosis failed: ${err.message}`;
  }
}

// ── X Batch ────────────────────────────────────────────────────────────────────

/**
 * Run X batch: pick next unposted rows → generate tweet → post → save
 * SERP check disabled — re-enable by uncommenting runSeoAnalysis calls
 */
export async function runXBatch(batchNum: number = 1): Promise<void> {
  // Sequential pick: next 15 rows where X Post URL is empty
  const batchUrls = await getRowsForContinuousXPosting(15);

  if (batchUrls.length === 0) {
    console.log('[X BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[X BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${batchUrls.length} rows ready for X posting`);
  let posted = 0;

  // Pick 7-8 random indices from the batch to post as threads
  const threadCount = Math.floor(Math.random() * 2) + 7; // 7 or 8
  const indices = Array.from({ length: batchUrls.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const threadIndices = new Set(indices.slice(0, Math.min(threadCount, batchUrls.length)));

  for (let rowIdx = 0; rowIdx < batchUrls.length; rowIdx++) {
    const row = batchUrls[rowIdx];
    try {
      console.log(`  Processing: ${row.title.slice(0, 60)}`);

      // SERP disabled — uncomment to re-enable:
      // const seoData = await runSeoAnalysis(row.targetUrl, row.title);
      // await saveUnifiedSeoData(row, seoData);
      const seoData = { seoRanking: 1, priority: 'P1', rankPosition: -1, rankPage: 0 };

      // 7-8 random rows per batch get thread treatment
      const isThread = threadIndices.has(rowIdx);
      let tweet = '';
      let xResult;

      if (isThread) {
        console.log(`    🧵 Thread mode (X Thread flag set)`);
        const tweets = await generateXThread({
          url: row.targetUrl,
          title: row.title,
          marketValue: row.marketValue,
        });
        tweet = tweets[0];
        xResult = await runXThreadAgent({ tweets, accountHandle: row.name });
      } else {
        // Generate tweet + post (retry with fresh generation if over limit)
        const MAX_REGEN = 3;
        tweet = await generateTweet({
          url: row.targetUrl,
          title: row.title,
          seoRanking: seoData.seoRanking,
          priority: seoData.priority,
          marketValue: row.marketValue,
        });

        xResult = await runXAgent({ tweetText: tweet, accountHandle: row.name });

        for (let regen = 1; regen < MAX_REGEN && !xResult.success && xResult.error?.startsWith('TWEET_OVER_LIMIT:'); regen++) {
          const excess = parseInt(xResult.error.split(':')[1] ?? '0', 10);
          console.log(`    🔄 Regenerating tweet (attempt ${regen + 1}/${MAX_REGEN}) — was ${excess} chars over limit`);
          tweet = await generateTweet({
            url: row.targetUrl,
            title: row.title,
            seoRanking: seoData.seoRanking,
            priority: seoData.priority,
            marketValue: row.marketValue,
            overLimitBy: excess,
          });
          xResult = await runXAgent({ tweetText: tweet, accountHandle: row.name });
        }
      }

      // 3. Save result
      if (xResult.success) {
        await savePostingResult(row, {
          xPost: tweet,
          xPostUrl: xResult.tweetUrl || '',
          xStatus: 'Posted',
          xError: '',
          xBatch: batchLabel,
        });
        posted++;
        console.log(`    ✅ Posted → ${xResult.tweetUrl}`);
      } else {
        await savePostingResult(row, {
          xPost: tweet,
          xPostUrl: '',
          xStatus: 'Failed',
          xError: xResult.error || 'Unknown error',
          xBatch: batchLabel,
        });
        console.log(`    ❌ Failed: ${xResult.error}`);
      }
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'x', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'x', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await savePostingResult(row, {
          xPost: '',
          xPostUrl: '',
          xStatus: 'Error',
          xError: err.message,
          xBatch: batchLabel,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} ALSO FAILED TO SAVE ERROR: ${saveErr.message}`);
      }
    }
  }

  console.log(`[X BATCH] ${batchLabel} complete: ${posted}/${batchUrls.length} posted`);
}

// ── FB Batch ───────────────────────────────────────────────────────────────────

/**
 * Run FB batch: pick rows → SEO check → generate FB post → post → save all
 */
export async function runFbBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsForContinuousFbPosting(15);

  if (rows.length === 0) {
    console.log('[FB BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[FB BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for FB posting`);

  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      // 1. Read SEO data from sheet (X batch writes SEO columns → no re-analysis here)
      const seoData = {
        seoRanking: parseInt(row.seoPage || '99') || 99,
        priority: row.priority || 'P1',
      };
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${seoData.priority}`);

      // 2. Generate FB post
      console.log(`    Generating FB content...`);
      const fbPost = await generateFbPost({
        url: row.targetUrl,
        title: row.title,
        seoRanking: seoData.seoRanking,
        priority: seoData.priority,
      });
      row.fbPost = fbPost;

      // 3. Post to FB
      console.log(`    Posting to FB (account: ${row.name})...`);
      const postResult = await postToFbAccount(row.name, fbPost);

      if (postResult.success) {
        await saveFbBatchResult(row, {
          fbPost,
          fbPostUrl: postResult.postUrl || '',
          fbStatus: 'Posted',
          fbBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveFbBatchResult(row, {
          fbPost,
          fbPostUrl: '',
          fbStatus: 'Failed',
          fbBatch: row.fbBatch || '',
          fbError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'facebook', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'facebook', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveFbBatchResult(row, {
          fbPost: row.fbPost || '',
          fbPostUrl: '',
          fbStatus: 'Error',
          fbBatch: row.fbBatch || '',
          fbError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  console.log(`\n[FB BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// Helper: Post to single FB account
async function postToFbAccount(accountName: string, postText: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_facebook', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Facebook login failed' };
    }

    const postResult = await executeBrowserTool('post_facebook', { postText });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── LI Batch ───────────────────────────────────────────────────────────────────

/**
 * Run LI batch: pick rows → SEO check → generate LI post → post → save all
 */
export async function runLiBatch(options?: { manual?: boolean }, batchNum: number = 1): Promise<void> {
  const rows = await getRowsForContinuousLiPosting(15);

  if (rows.length === 0) {
    console.log('[LI BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[LI BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for LI posting`);

  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      // 1. Read SEO data from sheet (X batch writes SEO columns → no re-analysis here)
      const seoData = {
        seoRanking: parseInt(row.seoPage || '99') || 99,
        priority: row.priority || 'P1',
      };
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${seoData.priority}`);

      // 2. Generate LI post
      console.log(`    Generating LI content...`);
      const liPost = await generateLiPost({
        url: row.targetUrl,
        title: row.title,
        seoRanking: seoData.seoRanking,
        priority: seoData.priority,
      });
      row.linkedinPost = liPost;

      // 3. Post to LI
      console.log(`    Posting to LI (account: ${row.name})...`);
      const postResult = await postToLiAccount(row.name, liPost);

      if (postResult.success) {
        await saveLiBatchResult(row, {
          liPost,
          liPostUrl: postResult.postUrl || '',
          liStatus: 'Posted',
          liBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveLiBatchResult(row, {
          liPost,
          liPostUrl: '',
          liStatus: 'Failed',
          liBatch: row.liBatch || '',
          liError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'linkedin', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'linkedin', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveLiBatchResult(row, {
          liPost: row.linkedinPost || '',
          liPostUrl: '',
          liStatus: 'Error',
          liBatch: row.liBatch || '',
          liError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  console.log(`\n[LI BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// Helper: Post to single LI account
async function postToLiAccount(accountName: string, postText: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_linkedin', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'LinkedIn login failed' };
    }

    const postResult = await executeBrowserTool('post_linkedin', { postText });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Medium Batch ───────────────────────────────────────────────────────────────

/**
 * Run Medium batch: pick rows → SEO check → generate Medium post (HTML) → post → save all
 */
export async function runMediumBatch(batchNum: number = 1): Promise<void> {
  // Medium uses BLOG sheet
  console.log(`\n[MEDIUM BATCH] Checking for rows ready to post...`);

  const rows = await getRowsForContinuousMediumPosting(15);

  if (rows.length === 0) {
    console.log('[MEDIUM BATCH] No rows available (all posted recently, no new rows)');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[MEDIUM BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for Medium posting`);
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      // 1. Read SEO data from sheet (X batch writes SEO columns → no re-analysis here)
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

      // 2. Generate Medium post (uses pre-written Blog Content from sheet)
      console.log(`    Preparing Medium content...`);
      const mediumPost = await generateMediumPost(row);
      row.mediumPost = mediumPost;

      // 3. Post to Medium
      console.log(`    Posting to Medium (account: ${row.name})...`);
      const postResult = await postToMediumAccount(row.name, row.descriptionTitle || '', mediumPost);

      if (postResult.success) {

        await saveMediumBatchResult(row, {
          mediumPost,
          mediumPostUrl: postResult.postUrl || '',
          mediumStatus: 'Posted',
          mediumBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveMediumBatchResult(row, {
          mediumPost,
          mediumPostUrl: '',
          mediumStatus: 'Failed',
          mediumBatch: row.mediumBatch || '',  // Keep existing batch, don't assign new one
          mediumError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'medium', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'medium', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveMediumBatchResult(row, {
          mediumPost: row.mediumPost || '',
          mediumPostUrl: '',
          mediumStatus: 'Error',
          mediumBatch: row.mediumBatch || '',  // Keep existing batch, don't assign new one
          mediumError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  if (posted > 0) {
    console.log(`\n[MEDIUM BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
  } else {
    console.log(`\n[MEDIUM BATCH] No successful posts in this run`);
  }
}

// Helper: Post to single Medium account
async function postToMediumAccount(accountName: string, title: string, htmlContent: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_medium', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Medium login failed' };
    }

    const postResult = await executeBrowserTool('post_medium', {
      title,
      htmlContent
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Linkmate Batch ────────────────────────────────────────────────────────────

/**
 * Run Linkmate batch: pick rows → post HTML content → save all
 *
 * Content Format: HTML (from "Linkmate Content" column)
 * Limit: 3 batches/day (14:45, 16:45, 18:45 IST)
 */
export async function runLinkmateBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[LINKMATE BATCH] Starting...`);

  const rows = await getRowsForContinuousLinkmatePosting(15);

  if (rows.length === 0) {
    console.log('[LINKMATE BATCH] No rows available (all posted recently, no new rows)');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`  Found ${rows.length} rows ready for Linkmate posting (${batchLabel})`);

  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      // Linkmate Content — read from sheet + inject correct platform UTM
      const linkMateContent = await generateLinkmatePost(row);
      if (!linkMateContent) {
        console.warn(`    ⚠️  No Content (HTML) found — skipping`);
        failed++;
        continue;
      }

      // Post to Linkmate
      console.log(`    Posting to Linkmate (account: ${row.name})...`);
      const postResult = await postToLinkmateAccount(row.name, row.descriptionTitle || '', linkMateContent, row.seedKeyword);

      if (postResult.success) {
        await saveLinkmateBatchResult(row, {
          linkMateContent,
          linkMatePostUrl: postResult.postUrl || '',
          linkMateStatus: 'Posted',
          linkmateBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveLinkmateBatchResult(row, {
          linkMateContent,
          linkMatePostUrl: '',
          linkMateStatus: 'Failed',
          linkmateBatch: batchLabel,
          linkMateError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'linkmate', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'linkmate', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveLinkmateBatchResult(row, {
          linkMateContent: row.linkMateContent || '',
          linkMatePostUrl: '',
          linkMateStatus: 'Error',
          linkmateBatch: batchLabel,
          linkMateError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  console.log(`\n[LINKMATE BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// Helper: Post to single Linkmate account
async function postToLinkmateAccount(accountName: string, title: string, htmlContent: string, seedKeyword?: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_linkmate', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Linkmate login failed' };
    }

    const postResult = await executeBrowserTool('post_linkmate', {
      title,
      htmlContent,
      seedKeyword
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Google Sites Batch ─────────────────────────────────────────────────────────

/**
 * Run Google Sites batch: pick rows → SEO check → generate Google Sites post (HTML) → post → save all
 */
export async function runGoogleSiteBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[GOOGLE SITES BATCH] Starting...`);

  const rows = await getRowsForContinuousGoogleSitePosting(15);

  if (rows.length === 0) {
    console.log('[GOOGLE SITES BATCH] No rows available (all posted recently, no new rows)');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`  Found ${rows.length} rows ready for Google Sites posting (${batchLabel})`);

  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      // SEO disabled — uncomment to re-enable:
      // const seoResult = await runSeoAnalysis(row.targetUrl, row.title);
      // await saveUnifiedSeoData(row, seoResult);

      // 1. Generate Google Sites post (uses pre-written Blog Content from sheet)
      console.log(`    Preparing Google Sites content...`);
      const googleSitePost = await generateGoogleSitePost(row);
      row.googleSitePost = googleSitePost;

      // 3. Post to Google Sites
      console.log(`    Posting to Google Sites (account: ${row.name})...`);
      const postResult = await postToGoogleSiteAccount(row.name, row.descriptionTitle || '', googleSitePost, row.seedKeyword);

      if (postResult.success) {
        await saveGoogleSiteBatchResult(row, {
          googleSitePost,
          googleSitePostUrl: postResult.postUrl || '',
          googleSiteStatus: 'Posted',
          googleSiteBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveGoogleSiteBatchResult(row, {
          googleSitePost,
          googleSitePostUrl: '',
          googleSiteStatus: 'Failed',
          googleSiteBatch: row.googleSiteBatch || '',
          googleSiteError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'googlesite', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'googlesite', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveGoogleSiteBatchResult(row, {
          googleSitePost: row.googleSitePost || '',
          googleSitePostUrl: '',
          googleSiteStatus: 'Error',
          googleSiteBatch: row.googleSiteBatch || '',
          googleSiteError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  console.log(`\n[GOOGLE SITES BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// Helper: Post to single Google Sites account
async function postToGoogleSiteAccount(accountName: string, title: string, htmlContent: string, seedKeyword?: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_googlesite', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Google Sites login failed' };
    }

    const postResult = await executeBrowserTool('post_googlesite', {
      title,
      htmlContent,
      seedKeyword
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Dev.to Batch ───────────────────────────────────────────────────────────────

/**
 * Run Dev.to batch: pick rows → SEO check → generate Dev.to post (HTML) → post → save all
 */
export async function runDevtoBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[DEV.TO BATCH] Starting...`);

  const rows = await getRowsForContinuousDevtoPosting(15);

  if (rows.length === 0) {
    console.log('[DEV.TO BATCH] No rows available (all posted recently, no new rows)');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`  Found ${rows.length} rows ready for Dev.to posting (${batchLabel})`);

  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      // 1. Read SEO data from sheet (X batch writes SEO columns → no re-analysis here)
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

      // 2. Generate Dev.to post (uses pre-written Blog Content from sheet)
      console.log(`    Preparing Dev.to content...`);
      const devtoPost = await generateDevtoPost(row);

      // 3. Post to Dev.to
      console.log(`    Posting to Dev.to (account: ${row.name})...`);
      const postResult = await postToDevtoAccount(row.name, row.descriptionTitle || '', devtoPost);

      if (postResult.success) {
        await saveDevtoBatchResult(row, {
          devtoPostUrl: postResult.postUrl || '',
          devtoStatus: 'Posted',
          devtoBatch: batchLabel,
        });
        posted++;
      } else {
        await saveDevtoBatchResult(row, {
          devtoPostUrl: '',
          devtoStatus: 'Failed',
          devtoBatch: row.devtoBatch || '',
          devtoError: postResult.error || 'Unknown error',
        });
        failed++;
      }
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'devto', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'devto', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveDevtoBatchResult(row, {
          devtoPostUrl: '',
          devtoStatus: 'Error',
          devtoBatch: row.devtoBatch || '',
          devtoError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  console.log(`\n[DEV.TO BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// Helper: Post to single Dev.to account
async function postToDevtoAccount(accountName: string, title: string, htmlContent: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_devto', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Dev.to login failed' };
    }

    const postResult = await executeBrowserTool('post_devto', {
      title,
      htmlContent,
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── LinkedIn Pulse Batch ───────────────────────────────────────────────────────

/**
 * Run LinkedIn Pulse batch: pick rows → SEO check → generate Pulse article → post → save all
 * IMPORTANT: LinkedIn account name is read from row.name (must match LinkedIn account nickname in .accounts)
 * Logs in once and reuses session for all posts in the batch
 */
export async function runLinkedinPulseBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[LINKEDIN PULSE BATCH] Starting...`);

  const rows = await getRowsForContinuousLinkedinPulsePosting(15);

  if (rows.length === 0) {
    console.log('[LINKEDIN PULSE BATCH] No rows available (all posted recently, no new rows)');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`  Found ${rows.length} rows ready for LinkedIn Pulse posting (${batchLabel})`);

  // Group rows by account name (each account = separate batch)
  const rowsByAccount = new Map<string, SheetRow[]>();
  for (const row of rows) {
    const accountName = row.name || 'default';
    if (!rowsByAccount.has(accountName)) {
      rowsByAccount.set(accountName, []);
    }
    rowsByAccount.get(accountName)!.push(row);
  }

  let totalPosted = 0;
  let totalFailed = 0;

  // Process each account's batch separately
  for (const [accountName, accountRows] of rowsByAccount) {
    console.log(`\n  Account: ${accountName}`);
    let posted = 0;
    let failed = 0;

    for (const row of accountRows) {
      try {
        console.log(`\n    Processing: ${row.title.slice(0, 60)}`);

        // 1. Read SEO data from sheet (X batch writes SEO columns → no re-analysis here)
        console.log(`      SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

        // 2. Generate LinkedIn Pulse article (uses pre-written content from sheet)
        console.log(`      Preparing LinkedIn Pulse article...`);
        const pulseContent = await generateLinkedinPulsePost(row);

        // 3. Post to LinkedIn Pulse
        console.log(`      Posting to LinkedIn Pulse...`);
        const postResult = await postToPulseAccount(
          accountName,
          pulseContent.title,
          pulseContent.html,
          pulseContent.seoTitle,
          pulseContent.seoDescription
        );

        if (postResult.success) {
          await saveLinkedinPulseBatchResult(row, {
            linkedinPulsePostUrl: postResult.postUrl || '',
            linkedinPulseStatus: 'Posted',
            linkedinPulseBatch: batchLabel,
          });
          console.log(`      ✅ Posted → ${postResult.postUrl}`);
          posted++;
        } else {
          await saveLinkedinPulseBatchResult(row, {
            linkedinPulsePostUrl: '',
            linkedinPulseStatus: 'Failed',
            linkedinPulseBatch: row.linkedinPulseBatch || '',
            linkedinPulseError: postResult.error,
          });
          console.log(`      ❌ Failed: ${postResult.error}`);
          failed++;
        }

        await new Promise(r => setTimeout(r, 1000));
      } catch (err: any) {
        const kbEntry = recordError({ rawError: err.message, platform: 'linkedin', stage: 'pulse-post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
        await applyFix(kbEntry, { platform: 'linkedin', accountName: row.name, rowIndex: row.rowIndex });
        console.error(`      ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
        try {
          await saveLinkedinPulseBatchResult(row, {
            linkedinPulsePostUrl: '',
            linkedinPulseStatus: 'Error',
            linkedinPulseBatch: row.linkedinPulseBatch || '',
            linkedinPulseError: err.message,
          });
        } catch (saveErr: any) {
          console.error(`      ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
        }
        failed++;
      }
    }

    console.log(`\n  Account ${accountName}: ${posted}/${accountRows.length} posted, ${failed} failed`);
    totalPosted += posted;
    totalFailed += failed;
  }

  console.log(`\n[LINKEDIN PULSE BATCH] ${batchLabel} complete: ${totalPosted}/${rows.length} posted, ${totalFailed} failed`);
}

// Helper: Post to single LinkedIn Pulse account (logs in once, posts multiple articles)
async function postToPulseAccount(
  accountName: string,
  title: string,
  htmlContent: string,
  seoTitle?: string,
  seoDescription?: string
): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    // Login via LinkedIn Pulse login (sets linkedinPulsePage, required by post_linkedin_pulse)
    const loginResult = await executeBrowserTool('login_linkedin_pulse', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'LinkedIn Pulse login failed' };
    }

    const postResult = await executeBrowserTool('post_linkedin_pulse', {
      title,
      htmlContent,
      seoTitle,
      seoDescription,
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Calisthenics Batch ────────────────────────────────────────────────────────

/**
 * Run Calisthenics batch: pick rows → post HTML content → save all
 *
 * Content Format: HTML (from "Content" column)
 * Limit: 2 batches/day (11:45, 15:45 IST)
 */
export async function runCalisthenicsNBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[CALISTHENICS BATCH] Starting...`);

  const rows = await getRowsForContinuousCalisthenicsPosting(15);

  if (rows.length === 0) {
    console.log('[CALISTHENICS BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[CALISTHENICS BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for Calisthenics posting`);
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      // 1. Read SEO data from sheet
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

      // 2. Generate Calisthenics article (uses pre-written Blog Content from sheet)
      console.log(`    Preparing Calisthenics content...`);
      const calisthenicsContent = await generateCalisthenicsPost(row);

      // 3. Post to Calisthenics
      console.log(`    Posting to Calisthenics (account: ${row.name})...`);
      const postResult = await postToCalisthenicsAccount(row.name, row.descriptionTitle || '', calisthenicsContent, row.seedKeyword);

      if (postResult.success) {
        await saveCalisthenicsResultBatch(row, {
          calisthenicsPostUrl: postResult.postUrl || '',
          calisthenicsStatus: 'Posted',
          calisthenicssBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveCalisthenicsResultBatch(row, {
          calisthenicsPostUrl: '',
          calisthenicsStatus: 'Failed',
          calisthenicssBatch: row.calisthenicsNBatch || '',
          calisthenicsError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'calisthenics', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'calisthenics', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveCalisthenicsResultBatch(row, {
          calisthenicsPostUrl: '',
          calisthenicsStatus: 'Error',
          calisthenicssBatch: row.calisthenicsNBatch || '',
          calisthenicsError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  if (posted > 0) {
    console.log(`\n[CALISTHENICS BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
  } else {
    console.log(`\n[CALISTHENICS BATCH] No successful posts in this run`);
  }
}

// ──── Substack Batch ──────────────────────────────────────────────────────────
export async function runSubstackBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[SUBSTACK BATCH] Starting...`);

  const rows = await getRowsForContinuousSubstackPosting(15);

  if (rows.length === 0) {
    console.log('[SUBSTACK BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[SUBSTACK BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for Substack posting`);
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

      const substackContent = await generateSubstackPost(row);
      console.log(`    Posting to Substack (account: ${row.name})...`);
      const postResult = await postToSubstackAccount(row.name, row.descriptionTitle || '', substackContent);

      if (postResult.success) {
        await saveSubstackBatchResult(row, {
          substackPostUrl: postResult.postUrl || '',
          substackStatus: 'Posted',
          substackBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveSubstackBatchResult(row, {
          substackPostUrl: '',
          substackStatus: 'Failed',
          substackBatch: row.substackBatch || '',
          substackError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'substack', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'substack', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveSubstackBatchResult(row, {
          substackPostUrl: '',
          substackStatus: 'Error',
          substackBatch: row.substackBatch || '',
          substackError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  if (posted > 0) {
    console.log(`\n[SUBSTACK BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
  } else {
    console.log(`\n[SUBSTACK BATCH] No successful posts in this run`);
  }
}

// ──── Guffiz Batch ──────────────────────────────────────────────────────────
export async function runGuffizBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[GUFFIZ BATCH] Starting...`);

  const rows = await getRowsForContinuousGuffizPosting(15);

  if (rows.length === 0) {
    console.log('[GUFFIZ BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[GUFFIZ BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for Guffiz posting`);
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

      const guffizContent = await generateGuffizPost(row);
      console.log(`    Posting to Guffiz (account: ${row.name})...`);
      const postResult = await postToGuffizAccount(row.name, row.descriptionTitle || '', guffizContent, row.description);

      if (postResult.success) {
        await saveGuffizBatchResult(row, {
          guffizPostUrl: postResult.postUrl || '',
          guffizStatus: 'Posted',
          guffizBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveGuffizBatchResult(row, {
          guffizPostUrl: '',
          guffizStatus: 'Failed',
          guffizBatch: row.guffizBatch || '',
          guffizError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'guffiz', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'guffiz', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveGuffizBatchResult(row, {
          guffizPostUrl: '',
          guffizStatus: 'Error',
          guffizBatch: row.guffizBatch || '',
          guffizError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  if (posted > 0) {
    console.log(`\n[GUFFIZ BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
  } else {
    console.log(`\n[GUFFIZ BATCH] No successful posts in this run`);
  }
}

// ──── HackMD Batch ──────────────────────────────────────────────────────────
export async function runHackmdBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[HACKMD BATCH] Starting...`);

  const rows = await getRowsForContinuousHackmdPosting(15);

  if (rows.length === 0) {
    console.log('[HACKMD BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[HACKMD BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for HackMD posting`);
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

      const hackmdContent = await generateHackmdPost(row);
      console.log(`    Posting to HackMD (account: ${row.name})...`);
      const postResult = await postToHackmdAccount(row.descriptionTitle || row.title || '', hackmdContent, row.name, row.description || '');

      if (postResult.success) {
        await saveHackmdBatchResult(row, {
          hackmdPostUrl: postResult.postUrl || '',
          hackmdStatus: 'Posted',
          hackmdBatch: batchLabel,
        });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveHackmdBatchResult(row, {
          hackmdPostUrl: '',
          hackmdStatus: 'Failed',
          hackmdBatch: row.hackmdBatch || '',
          hackmdError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'hackmd', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'hackmd', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveHackmdBatchResult(row, {
          hackmdPostUrl: '',
          hackmdStatus: 'Error',
          hackmdBatch: row.hackmdBatch || '',
          hackmdError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  if (posted > 0) {
    console.log(`\n[HACKMD BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
  } else {
    console.log(`\n[HACKMD BATCH] No successful posts in this run`);
  }
}

// Helper: Post to single Calisthenics account
async function postToCalisthenicsAccount(
  accountName: string,
  title: string,
  htmlContent: string,
  seedKeyword?: string
): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const postResult = await executeBrowserTool('post_calisthenics', {
      nickname: accountName,
      title,
      htmlContent,
      seedKeyword
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Helper: Post to Substack account
async function postToSubstackAccount(
  accountName: string,
  title: string,
  htmlContent: string
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const postResult = await executeBrowserTool('post_substack', {
      nickname: accountName,
      title,
      htmlContent
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Helper: Post to Guffiz account
async function postToGuffizAccount(
  accountName: string,
  title: string,
  htmlContent: string,
  description?: string
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const postResult = await executeBrowserTool('post_guffiz', {
      nickname: accountName,
      title,
      htmlContent,
      description,
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// Helper: Post to HackMD (no account needed)
async function postToHackmdAccount(
  title: string,
  htmlContent: string,
  accountName?: string,
  description?: string
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    // Login to HackMD first
    if (accountName) {
      const loginResult = await executeBrowserTool('login_hackmd', { nickname: accountName });
      if (!loginResult.success) {
        return { success: false, error: loginResult.error || 'HackMD login failed' };
      }
    }

    const postResult = await executeBrowserTool('post_hackmd', {
      title,
      htmlContent,
      description,
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Save helpers with batch column ──────────────────────────────────────────────

import { saveUnifiedFbResult, saveUnifiedLinkedInResult } from '../sheets/sheets.js';

async function saveFbBatchResult(
  row: SheetRow,
  data: { fbPost: string; fbPostUrl: string; fbStatus: string; fbBatch: string; fbError?: string }
): Promise<void> {
  await saveUnifiedFbResult(row, {
    post: data.fbPost,
    postUrl: data.fbPostUrl,
    status: data.fbStatus,
    error: data.fbError || '',
    batch: data.fbBatch,
  });
}

async function saveLiBatchResult(
  row: SheetRow,
  data: { liPost: string; liPostUrl: string; liStatus: string; liBatch: string; liError?: string }
): Promise<void> {
  await saveUnifiedLinkedInResult(row, {
    post: data.liPost,
    postUrl: data.liPostUrl,
    status: data.liStatus,
    error: data.liError || '',
    batch: data.liBatch,
  });
}

async function saveMediumBatchResult(
  row: SheetRow,
  data: { mediumPost: string; mediumPostUrl: string; mediumStatus: string; mediumBatch: string; mediumError?: string }
): Promise<void> {
  await saveUnifiedMediumResult(row, {
    post: data.mediumPost,
    postUrl: data.mediumPostUrl,
    status: data.mediumStatus,
    error: data.mediumError || '',
    batch: data.mediumBatch,
  });
}

async function saveLinkmateBatchResult(
  row: SheetRow,
  data: { linkMateContent: string; linkMatePostUrl: string; linkMateStatus: string; linkmateBatch: string; linkMateError?: string }
): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await saveUnifiedLinkmateResult(row, {
    content: data.linkMateContent,
    postUrl: data.linkMatePostUrl,
    status: data.linkMateStatus,
    error: data.linkMateError || '',
    batch: data.linkmateBatch,
    lastPosted: data.linkMateStatus === 'Posted' ? today : undefined,
  });
}

async function saveGoogleSiteBatchResult(
  row: SheetRow,
  data: { googleSitePost: string; googleSitePostUrl: string; googleSiteStatus: string; googleSiteBatch: string; googleSiteError?: string }
): Promise<void> {
  await saveUnifiedGoogleSiteResult(row, {
    post: data.googleSitePost,
    postUrl: data.googleSitePostUrl,
    status: data.googleSiteStatus,
    error: data.googleSiteError || '',
    batch: data.googleSiteBatch,
  });
}

async function saveDevtoBatchResult(
  row: SheetRow,
  data: { devtoPostUrl: string; devtoStatus: string; devtoBatch: string; devtoError?: string }
): Promise<void> {
  await saveUnifiedDevtoResult(row, {
    postUrl: data.devtoPostUrl,
    status: data.devtoStatus,
    error: data.devtoError || '',
    batch: data.devtoBatch,
  });
}

async function saveLinkedinPulseBatchResult(
  row: SheetRow,
  data: { linkedinPulsePostUrl: string; linkedinPulseStatus: string; linkedinPulseBatch: string; linkedinPulseError?: string }
): Promise<void> {
  await saveLinkedinPulseResult(row, {
    postUrl: data.linkedinPulsePostUrl,
    status: data.linkedinPulseStatus,
    error: data.linkedinPulseError || '',
    batch: data.linkedinPulseBatch,
  });
}

async function saveCalisthenicsResultBatch(
  row: SheetRow,
  data: { calisthenicsPostUrl: string; calisthenicsStatus: string; calisthenicssBatch: string; calisthenicsError?: string }
): Promise<void> {
  await saveCalisthenicsResult(row, {
    postUrl: data.calisthenicsPostUrl,
    status: data.calisthenicsStatus,
    error: data.calisthenicsError || '',
    batch: data.calisthenicssBatch,
  });
}

async function saveSubstackBatchResult(
  row: SheetRow,
  data: { substackPostUrl: string; substackStatus: string; substackBatch: string; substackError?: string }
): Promise<void> {
  await saveUnifiedSubstackResult(row, {
    postUrl: data.substackPostUrl,
    status: data.substackStatus,
    error: data.substackError || '',
    batch: data.substackBatch,
  });
}

async function saveGuffizBatchResult(
  row: SheetRow,
  data: { guffizPostUrl: string; guffizStatus: string; guffizBatch: string; guffizError?: string }
): Promise<void> {
  await saveUnifiedGuffizResult(row, {
    postUrl: data.guffizPostUrl,
    status: data.guffizStatus,
    error: data.guffizError || '',
    batch: data.guffizBatch,
  });
}

async function saveHackmdBatchResult(
  row: SheetRow,
  data: { hackmdPostUrl: string; hackmdStatus: string; hackmdBatch: string; hackmdError?: string }
): Promise<void> {
  await saveUnifiedHackmdResult(row, {
    postUrl: data.hackmdPostUrl,
    status: data.hackmdStatus,
    error: data.hackmdError || '',
    batch: data.hackmdBatch,
  });
}

async function postToPenzuAccount(
  accountName: string,
  title: string,
  htmlContent: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const loginResult = await executeBrowserTool('login_penzu', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Penzu login failed' };
    }
    const postResult = await executeBrowserTool('post_penzu', { title, htmlContent });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function savePenzuBatchResult(
  row: SheetRow,
  data: { penzuPostUrl: string; penzuStatus: string; penzuBatch: string; penzuError?: string }
): Promise<void> {
  await saveUnifiedPenzuResult(row, {
    postUrl: data.penzuPostUrl,
    status: data.penzuStatus,
    error: data.penzuError || '',
    batch: data.penzuBatch,
  });
}

async function postToWriteupCafeAccount(
  accountName: string,
  title: string,
  htmlContent: string,
  description?: string,
  seedKeyword?: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const loginResult = await executeBrowserTool('login_writeupcafe', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'WriteupCafe login failed' };
    }
    const postResult = await executeBrowserTool('post_writeupcafe', { title, htmlContent, description, seedKeyword });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function saveWriteupCafeBatchResult(
  row: SheetRow,
  data: { writeupcafePostUrl: string; writeupcafeStatus: string; writeupcafeBatch: string; writeupcafeError?: string }
): Promise<void> {
  await saveUnifiedWriteupCafeResult(row, {
    postUrl: data.writeupcafePostUrl,
    status: data.writeupcafeStatus,
    error: data.writeupcafeError || '',
    batch: data.writeupcafeBatch,
  });
}

export async function runWriteupCafeBatch(): Promise<void> {
  const counters = getCounters();
  counters.writeupcafe = (counters.writeupcafe || 0) + 1;
  saveCounters(counters);
  const label = `Batch ${counters.writeupcafe}`;

  console.log(`\n📝 [WriteupCafe] ${label} — fetching rows...`);
  const rows = await getRowsReadyForWriteupCafe(15);
  if (rows.length === 0) {
    console.log(`   ℹ️  No rows ready for WriteupCafe — skipping`);
    return;
  }

  for (const row of rows) {
    const title = row.title || row.descriptionTitle || '';
    const content = row.blogContent || '';
    if (!content) {
      await saveWriteupCafeBatchResult(row, { writeupcafePostUrl: '', writeupcafeStatus: 'Failed', writeupcafeBatch: label, writeupcafeError: 'No blog content' });
      continue;
    }
    const r = await postToWriteupCafeAccount(row.name, title, content, row.description, row.seedKeyword);
    await saveWriteupCafeBatchResult(row, { writeupcafePostUrl: r.postUrl || '', writeupcafeStatus: r.success ? 'Posted' : 'Failed', writeupcafeBatch: label, writeupcafeError: r.error });
    console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
  }
}

async function postToBloggerAccount(
  accountName: string,
  title: string,
  htmlContent: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const loginResult = await executeBrowserTool('login_blogger', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Blogger login failed' };
    }
    const postResult = await executeBrowserTool('post_blogger', { title, htmlContent });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function postToWordpressAccount(
  accountName: string,
  title: string,
  htmlContent: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const loginResult = await executeBrowserTool('login_wordpress', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'WordPress login failed' };
    }
    const postResult = await executeBrowserTool('post_wordpress', { title, htmlContent });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function saveBloggerBatchResult(
  row: SheetRow,
  data: { bloggerPostUrl: string; bloggerStatus: string; bloggerBatch: string; bloggerError?: string }
): Promise<void> {
  await saveUnifiedBloggerResult(row, {
    postUrl: data.bloggerPostUrl,
    status: data.bloggerStatus,
    error: data.bloggerError || '',
    batch: data.bloggerBatch,
  });
}

async function saveWordpressBatchResult(
  row: SheetRow,
  data: { wordpressPostUrl: string; wordpressStatus: string; wordpressBatch: string; wordpressError?: string }
): Promise<void> {
  await saveUnifiedWordpressResult(row, {
    postUrl: data.wordpressPostUrl,
    status: data.wordpressStatus,
    error: data.wordpressError || '',
    batch: data.wordpressBatch,
  });
}

// ── Retry single row on a specific platform ───────────────────────────────────

const BLOG_PLATFORMS  = ['googlesite', 'hackmd', 'devto', 'medium', 'linkmate', 'linkedin-pulse', 'calisthenics', 'substack', 'guffiz', 'wordpress', 'blogger', 'penzu', 'writeupcafe'];
const SOCIAL_PLATFORMS = ['x', 'facebook', 'linkedin'];

export async function runRetryRow(rowIndex: number, platform: string): Promise<void> {
  const p = platform.toLowerCase().replace(/_/g, '-');
  const sheetType = SOCIAL_PLATFORMS.includes(p) ? 'social' : 'blog';

  console.log(`\n🔄 Retry row ${rowIndex} on ${p} (${sheetType} sheet)`);

  const row = await getSheetRowByIndex(rowIndex, sheetType);
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in ${sheetType} sheet`);
    return;
  }

  console.log(`   Title   : ${row.title?.slice(0, 70)}`);
  console.log(`   Account : ${row.name}`);

  const label = 'Retry';

  const title = row.descriptionTitle || row.title || '';

  try {
    switch (p) {
      case 'googlesite': {
        const content = await generateGoogleSitePost(row);
        const r = await postToGoogleSiteAccount(row.name, title, content, row.seedKeyword);
        await saveGoogleSiteBatchResult(row, { googleSitePost: content, googleSitePostUrl: r.postUrl || '', googleSiteStatus: r.success ? 'Posted' : 'Failed', googleSiteBatch: label, googleSiteError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'hackmd': {
        const content = await generateHackmdPost(row);
        const r = await postToHackmdAccount(title, content, row.name, row.description || '');
        await saveHackmdBatchResult(row, { hackmdPostUrl: r.postUrl || '', hackmdStatus: r.success ? 'Posted' : 'Failed', hackmdBatch: label, hackmdError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'devto': {
        const content = await generateDevtoPost(row);
        const r = await postToDevtoAccount(row.name, title, content);
        await saveDevtoBatchResult(row, { devtoPostUrl: r.postUrl || '', devtoStatus: r.success ? 'Posted' : 'Failed', devtoBatch: label, devtoError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'medium': {
        const content = await generateMediumPost(row);
        const r = await postToMediumAccount(row.name, title, content);
        await saveMediumBatchResult(row, { mediumPost: content, mediumPostUrl: r.postUrl || '', mediumStatus: r.success ? 'Posted' : 'Failed', mediumBatch: label, mediumError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'linkmate': {
        const content = await generateLinkmatePost(row);
        const r = await postToLinkmateAccount(row.name, title, content, row.seedKeyword);
        await saveLinkmateBatchResult(row, { linkMateContent: content, linkMatePostUrl: r.postUrl || '', linkMateStatus: r.success ? 'Posted' : 'Failed', linkmateBatch: label, linkMateError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'linkedin-pulse': {
        const pulseContent = await generateLinkedinPulsePost(row);
        const r = await postToPulseAccount(row.name, pulseContent.title, pulseContent.html, pulseContent.seoTitle, pulseContent.seoDescription);
        await saveLinkedinPulseBatchResult(row, { linkedinPulsePostUrl: r.postUrl || '', linkedinPulseStatus: r.success ? 'Posted' : 'Failed', linkedinPulseBatch: label, linkedinPulseError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'calisthenics': {
        const content = await generateCalisthenicsPost(row);
        const r = await postToCalisthenicsAccount(row.name, title, content);
        await saveCalisthenicsResultBatch(row, { calisthenicsPostUrl: r.postUrl || '', calisthenicsStatus: r.success ? 'Posted' : 'Failed', calisthenicssBatch: label, calisthenicsError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'substack': {
        const content = await generateSubstackPost(row);
        const r = await postToSubstackAccount(row.name, title, content);
        await saveSubstackBatchResult(row, { substackPostUrl: r.postUrl || '', substackStatus: r.success ? 'Posted' : 'Failed', substackBatch: label, substackError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'guffiz': {
        const content = await generateGuffizPost(row);
        const r = await postToGuffizAccount(row.name, title, content, row.description);
        await saveGuffizBatchResult(row, { guffizPostUrl: r.postUrl || '', guffizStatus: r.success ? 'Posted' : 'Failed', guffizBatch: label, guffizError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'penzu': {
        const content = row.blogContent || await generateHackmdPost(row);
        const r = await postToPenzuAccount(row.name, title, content);
        await savePenzuBatchResult(row, { penzuPostUrl: r.postUrl || '', penzuStatus: r.success ? 'Posted' : 'Failed', penzuBatch: label, penzuError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'blogger': {
        const content = row.blogContent || await generateHackmdPost(row);
        const r = await postToBloggerAccount(row.name, title, content);
        await saveBloggerBatchResult(row, { bloggerPostUrl: r.postUrl || '', bloggerStatus: r.success ? 'Posted' : 'Failed', bloggerBatch: label, bloggerError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'writeupcafe': {
        const content = row.blogContent || await generateHackmdPost(row);
        const r = await postToWriteupCafeAccount(row.name, title, content, row.description, row.seedKeyword);
        await saveWriteupCafeBatchResult(row, { writeupcafePostUrl: r.postUrl || '', writeupcafeStatus: r.success ? 'Posted' : 'Failed', writeupcafeBatch: label, writeupcafeError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'wordpress': {
        const content = row.blogContent || await generateHackmdPost(row);
        const r = await postToWordpressAccount(row.name, title, content);
        await saveWordpressBatchResult(row, { wordpressPostUrl: r.postUrl || '', wordpressStatus: r.success ? 'Posted' : 'Failed', wordpressBatch: label, wordpressError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'x': {
        const tweets = await generateXThread({ url: row.targetUrl, title: row.title, marketValue: row.marketValue });
        const r = await runXThreadAgent({ tweets, accountHandle: row.name });
        await savePostingResult(row, { xPost: tweets[0], xPostUrl: r.tweetUrl || '', xStatus: r.success ? 'Posted' : 'Failed', xError: r.error || '', xBatch: label });
        console.log(r.success ? `✅ Thread posted → ${r.tweetUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'facebook': {
        const post = await generateFbPost({ url: row.targetUrl, title: row.title, seoRanking: 1, priority: 'P1', marketValue: row.marketValue });
        const r = await postToFbAccount(row.name, post);
        await saveFbBatchResult(row, { fbPost: post, fbPostUrl: r.postUrl || '', fbStatus: r.success ? 'Posted' : 'Failed', fbBatch: label, fbError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'linkedin': {
        const post = await generateLiPost({ url: row.targetUrl, title: row.title, seoRanking: 1, priority: 'P1', marketValue: row.marketValue });
        const r = await postToLiAccount(row.name, post);
        await saveLiBatchResult(row, { liPost: post, liPostUrl: r.postUrl || '', liStatus: r.success ? 'Posted' : 'Failed', liBatch: label, liError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      default:
        console.error(`❌ Unknown platform "${p}". Valid: ${[...BLOG_PLATFORMS, ...SOCIAL_PLATFORMS].join(', ')}`);
    }
  } catch (err: any) {
    console.error(`❌ Retry failed: ${err.message}`);
  }
}

// ── Weekly SERP Recheck ────────────────────────────────────────────────────────

export async function runWeeklySerpRecheck(): Promise<void> {
  try {
    console.log('\n📊 [WEEKLY RECHECK] Starting SERP re-check for old URLs...\n');

    const urlsToRecheck = await getUrlsDueForRecheck();
    if (urlsToRecheck.length === 0) {
      console.log('✅ No URLs due for re-check today\n');
      return;
    }

    console.log(`📄 Found ${urlsToRecheck.length} URLs due for re-check\n`);

    let recheckCount = 0;
    let priorityChangedCount = 0;

    for (const row of urlsToRecheck) {
      try {
        console.log(`\n📈 Re-checking: ${row.targetUrl.substring(0, 60)}...`);

        const newSeoResult = await runSeoAnalysis(row.targetUrl, row.title);
        const oldPriority = row.priority || 'Unknown';
        const priorityChanged = oldPriority !== newSeoResult.priority;

        if (priorityChanged) {
          console.log(`   🔄 Priority changed: ${oldPriority} → ${newSeoResult.priority}`);
          priorityChangedCount++;
        }

        await saveWeeklySerpRecheck(row, newSeoResult);
        recheckCount++;
      } catch (err: any) {
        console.error(`   ❌ Error re-checking row ${row.rowIndex}: ${err.message}`);
      }
    }

    console.log(`\n✅ [WEEKLY RECHECK] Done — ${recheckCount} checked, ${priorityChangedCount} priority changes\n`);
  } catch (err: any) {
    console.error(`❌ [WEEKLY RECHECK] Error: ${err.message}\n`);
  }
}

// ── Save Medium Session (Login + Save Cookies) ─────────────────────────────────

export async function saveMediumSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving Medium session for: ${nickname}\n`);

    const loginResult = await executeBrowserTool('login_medium', { nickname });

    if (!loginResult.success) {
      console.error(`❌ Failed to login: ${loginResult.error}`);
      return;
    }

    console.log(`✅ Login successful — cookies saved to .sessions/medium/`);
    console.log(`\n✅ Session saved. You can now run Medium batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving Medium session: ${err.message}\n`);
  }
}

// ── Save Linkmate Session (Login + Save Cookies) ────────────────────────────────

export async function saveLinkMateSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving Linkmate session for: ${nickname}\n`);

    const loginResult = await executeBrowserTool('login_linkmate', { nickname });

    if (!loginResult.success) {
      console.error(`❌ Failed to login: ${loginResult.error}`);
      return;
    }

    console.log(`✅ Login successful — cookies saved to .sessions/linkmate/`);
    console.log(`\n✅ Session saved. You can now run Linkmate batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving Linkmate session: ${err.message}\n`);
  }
}

// ── Save Google Sites Session (Manual Login + Save Session) ──────────────────

export async function saveGoogleSiteSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving Google Sites session for: ${nickname}\n`);

    const { loginToGoogleSite, getGoogleSiteAccountByNickname } = await import('../browser/googlesite/login.js');

    const account = getGoogleSiteAccountByNickname(nickname);
    if (!account) {
      console.error(`❌ Account not found: ${nickname}`);
      return;
    }

    console.log(`🔐 Email: ${account.email}`);
    console.log(`\n🌐 Opening browser for manual login...\n`);

    await loginToGoogleSite({ nickname });

    console.log(`\n✅ Login detected!`);
    console.log(`✅ Session saved to ${account.sessionDir}`);
    console.log(`\n👉 You can now close the browser manually.`);
    console.log(`\n✅ You can now run Google Sites batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving Google Sites session: ${err.message}\n`);
  }
}

// ── Save Calisthenics Session ────────────────────────────────────────────────

export async function saveCalisthenicsSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving Calisthenics session for: ${nickname}\n`);

    const { loginCalisthenics } = await import('../browser/calisthenics/login.js');
    await loginCalisthenics(nickname, true);

    console.log(`\n✅ Session saved. You can now run Calisthenics batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving Calisthenics session: ${err.message}\n`);
  }
}

// ── Save Substack Session ────────────────────────────────────────────────────

export async function saveSubstackSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving Substack session for: ${nickname}\n`);

    const { loginToSubstack } = await import('../browser/substack/login.js');
    await loginToSubstack({ nickname, manualMode: true });

    console.log(`\n✅ Login detected!`);
    console.log(`✅ Session saved.`);
    console.log(`\n✅ You can now run Substack batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving Substack session: ${err.message}\n`);
  }
}

// ── Save Guffiz Session ──────────────────────────────────────────────────────

export async function saveGuffizSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving Guffiz session for: ${nickname}\n`);

    const { loginToGuffiz } = await import('../browser/guffiz/login.js');
    await loginToGuffiz({ nickname, manualMode: true });

    console.log(`\n✅ Login detected!`);
    console.log(`✅ Session saved.`);
    console.log(`\n✅ You can now run Guffiz batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving Guffiz session: ${err.message}\n`);
  }
}

// ── Save HackMD Session ──────────────────────────────────────────────────────

export async function saveHackmdSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving HackMD session for: ${nickname}\n`);

    const { loginToHackMD } = await import('../browser/hackmd/login.js');
    await loginToHackMD({ nickname });

    console.log(`\n✅ Login detected!`);
    console.log(`✅ Session saved.`);
    console.log(`\n✅ You can now run HackMD batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving HackMD session: ${err.message}\n`);
  }
}
