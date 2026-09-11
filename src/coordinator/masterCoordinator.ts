/**
 * masterCoordinator.ts — Batch Runner
 *
 * No cooldown logic — cron in scheduler-new.ts handles timing.
 * Each platform batch function is called directly by cron.
 *
 * X Batch  : pick today's Content from sheet → post → save (xPostUrl + xBatch)
 * FB Batch : pick today's Content from sheet → post → save (fbPostUrl + fbBatch)
 * LI Batch : pick today's Content from sheet → post → save (liPostUrl + liBatch)
 */

/**
 * Parse date-prefixed sheet content and return today's entry (stripped of date prefix).
 *
 * Formats supported:
 *   "2026-05-05: post text..."
 *   "2026-05-04: post1..." | "2026-05-05: post2..."
 *
 * Returns null if no entry matches today (row should be skipped).
 * If content has no date prefix at all, returns the whole string as-is.
 */
function getTodayIST(): string {
  // IST = UTC + 5:30 — use IST date so cron (Asia/Kolkata) and date-tags stay aligned
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return ist.toISOString().split('T')[0];
}

function extractTodayPost(rawContent: string | undefined): string | null {
  if (!rawContent?.trim()) return null;
  const today = getTodayIST();

  // Split on pipe separator — handles both ` | ` and `" | "` formats
  const entries = rawContent.split(/["']?\s*\|\s*["']?/);

  // Strip surrounding quotes/whitespace from each entry
  const cleaned = entries.map(e => e.replace(/^["'\s]+|["'\s]+$/g, '').trim()).filter(Boolean);

  // Find today's entry
  const datePrefix = new RegExp(`^${today}:\\s*`);
  const todayEntry = cleaned.find(e => datePrefix.test(e));

  if (todayEntry) {
    return todayEntry.replace(datePrefix, '').trim();
  }

  // No date prefix at all — use entire content as-is (backward compat)
  if (!cleaned[0]?.match(/^\d{4}-\d{2}-\d{2}:/)) {
    return cleaned[0] ?? null;
  }

  return null; // has date prefix but not today's
}

// For X/FB/LI: strip any date prefix (YYYY-MM-DD:) and return content as-is
function extractSocialPost(rawContent: string | undefined): string | null {
  if (!rawContent?.trim()) return null;
  const content = rawContent.replace(/^["'\s]+|["'\s]+$/g, '').trim();
  return content.replace(/^\d{4}-\d{2}-\d{2}:\s*/, '').trim() || null;
}

import { ensureTargetUrl, injectUTM, UTM_PARAMS } from '../utils/utm.js';
import { recordError } from '../errorInterceptor.js';
import { applyFix } from '../autoFix.js';
import { postToHackMDApi } from '../browser/hackmd/apiPoster.js';
import { getHackMDAccounts } from '../browser/hackmd/login.js';
import { runSeoAnalysis } from '../agents/seoAgentNew.js';
import { generateTweet, generateXThread, generateFbPost, generateTumblrPost, generateLiPost, generateMediumPost, generateGoogleSitePost, generateDevtoPost, generateLinkedinPulsePost, generateCalisthenicsPost, generateSubstackPost, generateHackmdPost, generateLinkmatePost, generateMastodonPost, generateTelegraphPost, generateBookmarkNote, MAX_POST_LENGTH, hasUnfilledPlaceholder } from '../agents/contentAgentNew.js';
import { postToTelegraph } from '../browser/telegraph/poster.js';
import { runXAgent, runXThreadAgent } from '../agents/xAgentNew.js';
import { xAccountHasCapacity, incrementCount as incrementXCount } from '../config/accountTracker.js';
import { executeBrowserTool, closeFbSession, closeLiSession } from '../tools/browserTools.js';
import {
  getUnassignedRows,
  getUnassignedRowsAsSheetRows,
  getRowsNeedingSocialSlot,
  saveSocialSlotResult,
  getRowsForContinuousMediumPosting,
  getRowsForContinuousLinkmatePosting,
  getRowsForContinuousDevtoPosting,
  getRowsForContinuousGoogleSitePosting,
  getRowsForContinuousLinkedinPulsePosting,
  getRowsForContinuousCalisthenicsPosting,
  getRowsForContinuousSubstackPosting,
  getRowsForContinuousPatreonPosting,
  getRowsForContinuousNotionPosting,
  getRowsForContinuousNotePosting,
  getRowsForContinuousNaverPosting,
  getRowsForContinuousVelogPosting,
  getRowsForContinuousCodaPosting,
  getRowsForContinuousPdfhostPosting,
  getRowsForContinuousFourSharedPosting,
  getRowsForContinuousScribdPosting,
  getRowsForContinuousMastodonPosting,
  saveUnifiedMastodonResult,
  saveUnifiedPatreonResult,
  saveUnifiedNotionResult,
  saveUnifiedNoteResult,
  saveUnifiedNaverResult,
  saveUnifiedCodaResult,
  getRowsForContinuousHackmdPosting,
  saveUnifiedSeoData,
  getUrlsDueForRecheck,
  saveWeeklySerpRecheck,
  getRowsReadyForMedium,
  getRowsReadyForHackmd,
  saveUnifiedMediumResult,
  saveUnifiedLinkmateResult,
  saveUnifiedDevtoResult,
  saveLinkedinPulseResult,
  saveCalisthenicsResult,
  saveUnifiedSubstackResult,
  saveUnifiedHackmdResult,
  saveUnifiedWordpressResult,
  saveUnifiedBloggerResult,
  getRowsForContinuousWordpressPosting,
  getRowsForContinuousBloggerPosting,
  claimNextRowsForGroup,
  unclaimGroupRow,
  examineSundayFailedPosts,
  getSheetRowByIndex,
  SheetRow,
  getRowsForContinuousParagraphPosting,
  saveUnifiedParagraphResult,
  saveSlotResult,
  savePdfPath,
} from '../sheets/sheets.js';
import { htmlToPdf, makeSlug } from '../utils/contentConverter.js';
import { loginToPdfHost, closePdfHostBrowser } from '../browser/pdfhost/login.js';
import { postToPdfHost } from '../browser/pdfhost/poster.js';
import { loginToFourShared, closeFourSharedBrowser } from '../browser/fourshared/login.js';
import { postToFourShared } from '../browser/fourshared/poster.js';
import { loginToScribd, closeScribdBrowser } from '../browser/scribd/login.js';
import { postToScribd } from '../browser/scribd/poster.js';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

// ── Batch counter (persistent, ever-incrementing per platform) ───────────────

const COUNTERS_FILE = '.sessions/batch-counters.json';
const ROW_PROGRESS_FILE = path.resolve('.sessions/blog-row-progress.json');

interface BlogRowProgress {
  blogger: number;
  wordpress: number;
  [key: string]: number;
}

function getBlogRowProgress(): BlogRowProgress {
  try {
    if (fs.existsSync(ROW_PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROW_PROGRESS_FILE, 'utf8'));
      console.log(`   📂 blog-row-progress: ${JSON.stringify(data)}`);
      return data;
    }
  } catch (e: any) {
    console.warn(`   ⚠️ Could not read blog-row-progress.json: ${e.message}`);
  }
  return { blogger: 0, wordpress: 0 };
}

function saveBlogRowProgress(p: BlogRowProgress): void {
  try {
    fs.mkdirSync(path.dirname(ROW_PROGRESS_FILE), { recursive: true });
    fs.writeFileSync(ROW_PROGRESS_FILE, JSON.stringify(p, null, 2));
    console.log(`   💾 blog-row-progress saved: ${JSON.stringify(p)}`);
  } catch (e: any) {
    console.error(`   ❌ FAILED to save blog-row-progress.json: ${e.message}`);
  }
}

interface BatchCounters {
  x: number;
  fb: number;
  tumblr: number;
  li: number;
  medium: number;
  linkmate: number;
  googlesite: number;
  devto: number;
  linkedinpulse: number;
  calisthenics: number;
  substack: number;
  hackmd: number;
  patreon: number;
  notion: number;
  note: number;
  naver: number;
  velog: number;
  coda: number;
  wordpress: number;
  blogger: number;
  ameba: number;
  paragraph: number;
  pearltrees: number;
  pdfhost: number;
  instapaper: number;
  raindrop: number;
  scribd: number;
  fourshared: number;
  telegraph: number;
  // legacy field kept for backwards compat
  date?: string;
}

const ZERO_COUNTERS: BatchCounters = {
  x: 0, fb: 0, tumblr: 0, li: 0, medium: 0, linkmate: 0, googlesite: 0, devto: 0, linkedinpulse: 0,
  calisthenics: 0, substack: 0, hackmd: 0, patreon: 0, notion: 0, note: 0,
  naver: 0, velog: 0, coda: 0,
  wordpress: 0, blogger: 0, ameba: 0, paragraph: 0,
  pearltrees: 0, pdfhost: 0, instapaper: 0, raindrop: 0,
  scribd: 0, fourshared: 0, telegraph: 0,
};

// Display order + labels for the daily posting summary (mirrors the reporting sheet layout).
const PLATFORM_LABELS: [keyof Omit<BatchCounters, 'date'>, string][] = [
  ['x', 'X'],
  ['fb', 'Facebook'],
  ['tumblr', 'Tumblr'],
  ['li', 'LinkedIn'],
  ['hackmd', 'HackMD'],
  ['googlesite', 'Google Sites'],
  ['devto', 'Dev.to'],
  ['linkmate', 'Linkmate'],
  ['calisthenics', 'Calisthenics'],
  ['wordpress', 'WordPress'],
  ['blogger', 'Blogger'],
  ['linkedinpulse', 'LinkedIn Pulse'],
  ['medium', 'Medium'],
  ['notion', 'Notion'],
  ['paragraph', 'Paragraph'],
  ['ameba', 'Ameblo'],
  ['substack', 'Substack'],
  ['patreon', 'Patreon'],
  ['note', 'Note'],
  ['naver', 'Naver'],
  ['velog', 'Velog'],
  ['coda', 'Coda'],
  ['pearltrees', 'Pearltrees'],
  ['pdfhost', 'PdfHost'],
  ['instapaper', 'Instapaper'],
  ['raindrop', 'Raindrop'],
  ['scribd', 'Scribd'],
  ['fourshared', '4shared'],
  ['telegraph', 'Telegraph'],
];

function getCounters(): BatchCounters {
  const today = getTodayIST();
  if (!fs.existsSync(COUNTERS_FILE)) return { ...ZERO_COUNTERS, date: today };
  try {
    const saved = JSON.parse(fs.readFileSync(COUNTERS_FILE, 'utf8'));
    // Self-heal: if the persisted date isn't today (missed midnight cron —
    // e.g. daemon restart/crash/downtime spanning 00:00 IST), reset instead
    // of silently accumulating across days.
    if (saved.date !== today) {
      console.log(`   ℹ️  Batch counters stale (saved date: ${saved.date ?? 'unknown'}, today: ${today}) — resetting`);
      const fresh = { ...ZERO_COUNTERS, date: today };
      saveCounters(fresh);
      return fresh;
    }
    // Merge with zeros so any missing platform key starts at 0
    return { ...ZERO_COUNTERS, ...saved, date: today };
  } catch {
    return { ...ZERO_COUNTERS, date: today };
  }
}

function saveCounters(c: BatchCounters): void {
  fs.mkdirSync('.sessions', { recursive: true });
  const withDate = { ...c, date: getTodayIST() };
  fs.writeFileSync(COUNTERS_FILE, JSON.stringify(withDate, null, 2));
}

/** Increment the daily successful-post count for a platform. Call once per confirmed post URL. */
function recordPost(platform: keyof Omit<BatchCounters, 'date'>): void {
  const c = getCounters();
  c[platform] = (c[platform] ?? 0) + 1;
  saveCounters(c);
}

/** Build the "Daily Post Count" table — same shape as the manual screenshot report. */
function buildDailySummary(): { platform: string; posts: number }[] {
  const c = getCounters();
  return PLATFORM_LABELS
    .map(([key, label]) => ({ platform: label, posts: c[key] ?? 0 }))
    .filter(r => r.posts > 0);
}

/** Build the plain-text version of the summary — this exact text is what gets written to the sheet. */
function buildDailySummaryText(dateIST: string, rows: { platform: string; posts: number }[], total: number): string {
  const lines = [`Daily Post Count: ${dateIST}`, ''];
  for (const r of rows) lines.push(`${r.platform}: ${r.posts}`);
  lines.push('', `TOTAL: ${total}`);
  return lines.join('\n');
}

/** Print + persist the end-of-day posting summary, and write the full breakdown log to Algo Reports!F. */
export async function runDailyPostingSummary(): Promise<void> {
  const rows = buildDailySummary();
  const total = rows.reduce((sum, r) => sum + r.posts, 0);
  const dateIST = getTodayIST();

  console.log(`\n┌─ Daily Post Count: ${dateIST} ──────────────`);
  console.log('│ Platform          │ Posts');
  console.log('├────────────────────┼───────');
  for (const r of rows) {
    console.log(`│ ${r.platform.padEnd(18)} │ ${r.posts}`);
  }
  console.log('├────────────────────┼───────');
  console.log(`│ ${'TOTAL'.padEnd(18)} │ ${total}`);
  console.log('└────────────────────┴───────\n');

  const summaryText = buildDailySummaryText(dateIST, rows, total);

  try {
    const { saveDailyPostingCount } = await import('../sheets/sheets.js');
    await saveDailyPostingCount(dateIST, summaryText);
  } catch (err: any) {
    console.error(`   ❌ Failed to write daily posting count to Algo Reports: ${err.message}`);
  }
}

// ── Hard timeout wrapper ──────────────────────────────────────────────────────
// Prevents a hung Playwright call from freezing the entire Node process.
// NOTE: this does NOT cancel `promise` — it keeps running in the background.
// browserTools.ts now keys FB/LI sessions per-account (fbPages/liPages maps) so an
// abandoned call finishing late can no longer clobber a different account's live
// browser. Still pass `onTimeout` to force-close the hung account's own browser
// immediately, so the abandoned call dies fast instead of limping along for the
// rest of the timeout window.
// Usage: await withTimeout(loginToX(...), 60 * 1000, 'X login', () => closeXBrowser())
function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation', onTimeout?: () => void): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        try { onTimeout?.(); } catch { /* best effort */ }
        reject(new Error(`${label} timed out after ${ms / 1000}s`));
      }, ms)
    ),
  ]);
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

async function diagnoseError(
  _errorMessage: string,
  _context: { rowTitle?: string; rowIndex?: number; platform?: string; stage?: string }
): Promise<string> {
  return '';
}

// ── X Batch ────────────────────────────────────────────────────────────────────

/**
 * Run X batch: pick next unposted rows → generate tweet → post → save
 * SERP check disabled — re-enable by uncommenting runSeoAnalysis calls
 */
export async function runXBatch(batchNum: number = 1): Promise<void> {
  const batchUrls = await getRowsNeedingSocialSlot(1, 15);

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

      if (!xAccountHasCapacity(row.name)) {
        console.log(`    ⏭ Skipping — @${row.name} already hit daily X post limit`);
        continue;
      }

      // Use sheet content if available, otherwise generate
      let tweet = row.xPost?.trim() || '';
      if (!tweet) {
        console.log(`    ℹ️  No sheet content — generating tweet for: ${row.title.slice(0, 50)}`);
        try {
          tweet = await generateTweet({ url: row.targetUrl, title: row.title, seoRanking: 999, priority: row.priority ?? 'P3', marketValue: row.marketValue });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — generation failed: ${genErr.message}`);
          continue;
        }
        if (!tweet?.trim()) { console.log(`    ⏭ Skipping — generated content empty`); continue; }
      }
      const xResult = await runXAgent({ tweetText: tweet, accountHandle: row.name });

      // 3. Save result
      if (xResult.success) {
        incrementXCount('x', row.name);
        await saveSocialSlotResult(row.rowIndex, 1, 'X', {
          url: xResult.tweetUrl || '',
          status: 'Posted',
          batch: batchLabel,
        });
        posted++;
        recordPost('x');
        console.log(`    ✅ Posted → ${xResult.tweetUrl}`);
      } else {
        await saveSocialSlotResult(row.rowIndex, 1, 'X', {
          url: '',
          status: 'Failed',
          error: xResult.error || 'Unknown error',
          batch: batchLabel,
        });
        console.log(`    ❌ Failed: ${xResult.error}`);
      }
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'x', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'x', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveSocialSlotResult(row.rowIndex, 1, 'X', {
          url: '',
          status: 'Error',
          error: err.message,
          batch: batchLabel,
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
  const rows = await getRowsNeedingSocialSlot(2, 15);

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

      // Use sheet content if available, otherwise generate — but never
      // regenerate when FB Status already says "Generated" (content was
      // prepared ahead of time by the standalone generate script).
      let fbPost = row.fbPost?.trim() || '';
      const fbAlreadyGenerated = (row.fbStatus || '').trim().toLowerCase() === 'generated';
      if (!fbPost) {
        if (fbAlreadyGenerated) {
          console.log(`    ⏭ Skipping — FB Status is "Generated" but FB Post is empty (row ${row.rowIndex})`);
          continue;
        }
        console.log(`    ℹ️  No sheet content — generating FB post for: ${row.title.slice(0, 50)}`);
        try {
          fbPost = await generateFbPost({ url: row.targetUrl, title: row.title, seoRanking: 999, priority: row.priority ?? 'P3' });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — generation failed: ${genErr.message}`);
          continue;
        }
        if (!fbPost?.trim()) { console.log(`    ⏭ Skipping — generated content empty`); continue; }
      } else if (fbPost.length > MAX_POST_LENGTH || hasUnfilledPlaceholder(fbPost)) {
        console.log(`    ⚠️  Sanity: sheet FB post ${hasUnfilledPlaceholder(fbPost) ? 'has an unfilled placeholder' : `is ${fbPost.length} chars (over ${MAX_POST_LENGTH})`} — regenerating`);
        try {
          fbPost = await generateFbPost({ url: row.targetUrl, title: row.title, seoRanking: 999, priority: row.priority ?? 'P3' });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — regeneration failed: ${genErr.message}`);
          continue;
        }
        if (!fbPost?.trim()) { console.log(`    ⏭ Skipping — regenerated content empty`); continue; }
      }
      row.fbPost = fbPost;

      // 3. Post to FB
      console.log(`    Posting to FB (account: ${row.name})...`);
      const postResult = await postToFbAccount(row.name, fbPost);

      if (postResult.success) {
        fbPost = postResult.postText || fbPost;
        row.fbPost = fbPost;
        await saveFbBatchResult(row, {
          fbPost,
          fbPostUrl: postResult.postUrl || '',
          fbStatus: 'Posted',
          fbBatch: batchLabel,
        });
        recordPost('fb');
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
  postText?: string;
  error?: string;
}> {
  try {
    const loginResult = await withTimeout(
      executeBrowserTool('login_facebook', { nickname: accountName }),
      2 * 60 * 1000, `FB login:${accountName}`,
      () => closeFbSession(accountName)
    );
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Facebook login failed' };
    }

    const postResult = await withTimeout(
      executeBrowserTool('post_facebook', { nickname: accountName, postText }),
      2 * 60 * 1000, `FB post:${accountName}`,
      () => closeFbSession(accountName)
    );
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      postText: postResult.postText,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Tumblr Batch ─────────────────────────────────────────────────────────────

// Helper: Post to single Tumblr account
function removeTumblrHashtags(text: string): string {
  return text
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/:\s*$/, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function postToTumblrAccount(accountName: string, postText: string, targetUrl: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_tumblr', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Tumblr login failed' };
    }
    const postResult = await executeBrowserTool('post_tumblr', { postText, targetUrl });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function runTumblrBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsNeedingSocialSlot(2, 15);

  if (rows.length === 0) {
    console.log('[TUMBLR BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;

  console.log(`\n[TUMBLR BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for Tumblr posting`);

  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      let tumblrPost = row.tumblrPost?.trim() || '';
      if (!tumblrPost) {
        console.log(`    ℹ️  No sheet content — generating Tumblr caption for: ${row.title.slice(0, 50)}`);
        try {
          tumblrPost = await generateTumblrPost({ url: row.targetUrl, title: row.title, seoRanking: 999, priority: row.priority ?? 'P3', marketValue: row.marketValue });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — generation failed: ${genErr.message}`);
          continue;
        }
        if (!tumblrPost?.trim()) { console.log(`    ⏭ Skipping — generated content empty`); continue; }
      }
      const hashtagFreePost = removeTumblrHashtags(tumblrPost);
      if (hashtagFreePost !== tumblrPost) {
        console.log('    Removed hashtags from Tumblr caption');
      }
      tumblrPost = hashtagFreePost;
      if (!tumblrPost) { console.log(`    ⏭ Skipping — caption empty after hashtag removal`); continue; }
      row.tumblrPost = tumblrPost;

      console.log(`    Posting to Tumblr (account: ${row.name})...`);
      const postResult = await postToTumblrAccount(row.name, tumblrPost, row.targetUrl);

      if (postResult.success) {
        await saveTumblrBatchResult(row, {
          tumblrPost,
          tumblrPostUrl: postResult.postUrl || '',
          tumblrStatus: 'Posted',
          tumblrBatch: batchLabel,
        });
        recordPost('tumblr');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveTumblrBatchResult(row, {
          tumblrPost,
          tumblrPostUrl: '',
          tumblrStatus: 'Failed',
          tumblrBatch: row.tumblrBatch || '',
          tumblrError: postResult.error,
        });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'tumblr', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'tumblr', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveTumblrBatchResult(row, {
          tumblrPost: row.tumblrPost || '',
          tumblrPostUrl: '',
          tumblrStatus: 'Error',
          tumblrBatch: row.tumblrBatch || '',
          tumblrError: err.message,
        });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }

  console.log(`\n[TUMBLR BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Instapaper Batch ─────────────────────────────────────────────────────────

async function postToInstapaperAccount(accountName: string, title: string, targetUrl: string, note: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_instapaper', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Instapaper login failed' };
    }
    const postResult = await executeBrowserTool('post_instapaper', { title, targetUrl, note });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function runInstapaperBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsNeedingSocialSlot(1, 15);
  if (rows.length === 0) { console.log('[INSTAPAPER BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[INSTAPAPER BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let note = row.instapaperNote?.trim() || '';
      if (!note) {
        try {
          note = await generateBookmarkNote({ url: row.targetUrl, title: row.title, marketValue: row.marketValue });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — generation failed: ${genErr.message}`);
          continue;
        }
      }
      row.instapaperNote = note;

      const postResult = await postToInstapaperAccount(row.name, row.title, row.targetUrl, note);
      if (postResult.success) {
        await saveSocialSlotResult(row.rowIndex, 1, 'Instapaper', { url: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        recordPost('instapaper');
        posted++;
      } else {
        await saveSocialSlotResult(row.rowIndex, 1, 'Instapaper', { url: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'instapaper', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'instapaper', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      failed++;
    }
  }
  console.log(`\n[INSTAPAPER BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Raindrop Batch ───────────────────────────────────────────────────────────

async function postToRaindropAccount(accountName: string, title: string, targetUrl: string, note: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_raindrop', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Raindrop login failed' };
    }
    const postResult = await executeBrowserTool('post_raindrop', { title, targetUrl, note });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function runRaindropBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsNeedingSocialSlot(1, 15);
  if (rows.length === 0) { console.log('[RAINDROP BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[RAINDROP BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let note = row.raindropNote?.trim() || '';
      if (!note) {
        try {
          note = await generateBookmarkNote({ url: row.targetUrl, title: row.title, marketValue: row.marketValue });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — generation failed: ${genErr.message}`);
          continue;
        }
      }
      row.raindropNote = note;

      const postResult = await postToRaindropAccount(row.name, row.title, row.targetUrl, note);
      if (postResult.success) {
        await saveSocialSlotResult(row.rowIndex, 1, 'Raindrop', { url: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        recordPost('raindrop');
        posted++;
      } else {
        await saveSocialSlotResult(row.rowIndex, 1, 'Raindrop', { url: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'raindrop', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'raindrop', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      failed++;
    }
  }
  console.log(`\n[RAINDROP BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Pearltrees Batch ─────────────────────────────────────────────────────────

async function postToPearltreesAccount(accountName: string, title: string, targetUrl: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_pearltrees', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Pearltrees login failed' };
    }
    const postResult = await executeBrowserTool('post_pearltrees', { title, targetUrl });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function runPearltreesBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsNeedingSocialSlot(2, 15);
  if (rows.length === 0) { console.log('[PEARLTREES BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[PEARLTREES BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      const postResult = await postToPearltreesAccount(row.name, row.title, row.targetUrl);
      if (postResult.success) {
        await saveSocialSlotResult(row.rowIndex, 2, 'Pearltrees', { url: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        recordPost('pearltrees');
        posted++;
      } else {
        await saveSocialSlotResult(row.rowIndex, 2, 'Pearltrees', { url: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'pearltrees', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'pearltrees', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      failed++;
    }
  }
  console.log(`\n[PEARLTREES BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Mastodon Batch ───────────────────────────────────────────────────────────

async function postToMastodonAccount(accountName: string, postText: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_mastodon', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Mastodon login failed' };
    }
    const postResult = await executeBrowserTool('post_mastodon', { postText });
    return { success: postResult.success ?? false, postUrl: postResult.postUrl, error: postResult.error };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function runMastodonBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsForContinuousMastodonPosting(15);
  if (rows.length === 0) { console.log('[MASTODON BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[MASTODON BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let mastodonPost = row.mastodonPost?.trim() || '';
      if (!mastodonPost) {
        try {
          mastodonPost = await generateMastodonPost({ url: row.targetUrl, title: row.title, marketValue: row.marketValue });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — generation failed: ${genErr.message}`);
          continue;
        }
      }
      row.mastodonPost = mastodonPost;

      const postResult = await postToMastodonAccount(row.name, mastodonPost);
      if (postResult.success) {
        await saveUnifiedMastodonResult(row, { postUrl: postResult.postUrl || '', post: mastodonPost, status: 'Posted', batch: batchLabel });
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveUnifiedMastodonResult(row, { postUrl: '', post: mastodonPost, status: 'Failed', batch: batchLabel, error: postResult.error });
        console.log(`    ❌ Failed: ${postResult.error}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'mastodon', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'mastodon', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      failed++;
    }
  }
  console.log(`\n[MASTODON BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Telegraph Batch ──────────────────────────────────────────────────────────
// No accounts, no login — telegra.ph opens straight into a live editor and
// Publish mints the page instantly (confirmed live 2026-09-08, see
// browser/telegraph/poster.ts). Shares Slot 2 of the Social Media tab with
// Facebook/Tumblr/Pearltrees (see saveSocialSlotResult) — same
// "Social Platform 2"/"Social URL 2" columns, no dedicated Telegraph columns.

export async function runTelegraphBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsNeedingSocialSlot(2, 15);
  if (rows.length === 0) { console.log('[TELEGRAPH BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[TELEGRAPH BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);

      let { title, html } = await generateTelegraphPost(row);
      html = ensureTargetUrl(html, row.targetUrl);

      console.log(`    Posting to Telegraph...`);
      const page = await postToTelegraph(title, 'Ken Research', html);

      await saveSocialSlotResult(row.rowIndex, 2, 'Telegraph', { url: page.url, status: 'Posted', batch: batchLabel });
      recordPost('telegraph');
      console.log(`    ✅ Posted → ${page.url}`);
      posted++;
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'telegraph', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveSocialSlotResult(row.rowIndex, 2, 'Telegraph', { url: '', status: 'Failed', batch: batchLabel, error: err.message });
      } catch (saveErr: any) {
        console.error(`  ⚠️ Row ${row.rowIndex} SHEET SAVE ALSO FAILED: ${saveErr.message}`);
      }
      failed++;
    }
  }
  console.log(`\n[TELEGRAPH BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── PdfHost Batch ─────────────────────────────────────────────────────────────

export async function runPdfhostBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsForContinuousPdfhostPosting(15);
  if (rows.length === 0) { console.log('[PDFHOST BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[PDFHOST BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    const pdfTitle = row.title || row.descriptionTitle || '';
    const content = row.blogContent || '';
    if (!content) { console.log(`  ⏭ Skipping row ${row.rowIndex} — no blog content`); continue; }

    try {
      let pdfPath = row.pdfPath?.trim();
      if (!pdfPath) {
        pdfPath = await htmlToPdf(content, makeSlug(pdfTitle), row.rowIndex);
        await savePdfPath(row, pdfPath, undefined, 'newLogic').catch(() => {});
      }
      const page = await loginToPdfHost({ nickname: row.name });
      const r = await postToPdfHost(page, pdfPath, pdfTitle, pdfTitle);
      await saveSlotResult(row.rowIndex, 2, 'PdfHost', { url: r.postUrl, status: 'Posted', batch: batchLabel });
      console.log(`  ✅ Posted → ${r.postUrl}`);
      recordPost('pdfhost');
      posted++;
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'pdfhost', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'pdfhost', accountName: row.name, rowIndex: row.rowIndex });
      await saveSlotResult(row.rowIndex, 2, 'PdfHost', { url: '', status: 'Failed', batch: batchLabel, error: err.message });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      failed++;
    } finally {
      await closePdfHostBrowser();
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[PDFHOST BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Scribd Batch ──────────────────────────────────────────────────────────────

export async function runScribdBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsForContinuousScribdPosting(15);
  if (rows.length === 0) { console.log('[SCRIBD BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[SCRIBD BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    const pdfTitle = row.title || row.descriptionTitle || '';
    const content = row.blogContent || '';
    if (!content) { console.log(`  ⏭ Skipping row ${row.rowIndex} — no blog content`); continue; }

    try {
      let pdfPath = row.pdfPath?.trim();
      if (!pdfPath) {
        pdfPath = await htmlToPdf(content, makeSlug(pdfTitle), row.rowIndex);
        await savePdfPath(row, pdfPath, undefined, 'newLogic').catch(() => {});
      }
      const page = await loginToScribd({ nickname: row.name });
      const r = await postToScribd(page, pdfPath, pdfTitle, row.targetUrl);
      await saveSlotResult(row.rowIndex, 1, 'Scribd', { url: r.postUrl, status: 'Posted', batch: batchLabel });
      console.log(`  ✅ Posted → ${r.postUrl}`);
      recordPost('scribd');
      posted++;
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'scribd', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'scribd', accountName: row.name, rowIndex: row.rowIndex });
      await saveSlotResult(row.rowIndex, 1, 'Scribd', { url: '', status: 'Failed', batch: batchLabel, error: err.message });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      failed++;
    } finally {
      await closeScribdBrowser();
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[SCRIBD BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── 4shared Batch ─────────────────────────────────────────────────────────────

export async function runFourSharedBatch(batchNum: number = 1): Promise<void> {
  const rows = await getRowsForContinuousFourSharedPosting(15);
  if (rows.length === 0) { console.log('[4SHARED BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[4SHARED BATCH] Starting ${batchLabel}... Found ${rows.length} rows`);

  let posted = 0, failed = 0;
  for (const row of rows) {
    const pdfTitle = row.title || row.descriptionTitle || '';
    const content = row.blogContent || '';
    if (!content) { console.log(`  ⏭ Skipping row ${row.rowIndex} — no blog content`); continue; }

    try {
      let pdfPath = row.pdfPath?.trim();
      if (!pdfPath) {
        pdfPath = await htmlToPdf(content, makeSlug(pdfTitle), row.rowIndex);
        await savePdfPath(row, pdfPath, undefined, 'newLogic').catch(() => {});
      }
      const page = await loginToFourShared({ nickname: row.name });
      const r = await postToFourShared(page, pdfPath, row.targetUrl);
      await saveSlotResult(row.rowIndex, 3, '4shared', { url: r.postUrl, status: 'Posted', batch: batchLabel });
      console.log(`  ✅ Posted → ${r.postUrl}`);
      recordPost('fourshared');
      posted++;
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'fourshared', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'fourshared', accountName: row.name, rowIndex: row.rowIndex });
      await saveSlotResult(row.rowIndex, 3, '4shared', { url: '', status: 'Failed', batch: batchLabel, error: err.message });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      failed++;
    } finally {
      await closeFourSharedBrowser();
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[4SHARED BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── LI Batch ───────────────────────────────────────────────────────────────────

/**
 * Run LI batch: pick rows → SEO check → generate LI post → post → save all
 */
export async function runLiBatch(options?: { manual?: boolean }, batchNum: number = 1): Promise<void> {
  const rows = await getRowsNeedingSocialSlot(1, 15);

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

      // Use sheet content if available, otherwise generate — but never
      // regenerate when LinkedIn Status already says "Generated" (content
      // was prepared ahead of time by the standalone generate script).
      let liPost = row.linkedinPost?.trim() || '';
      const liAlreadyGenerated = (row.linkedinStatus || '').trim().toLowerCase() === 'generated';
      if (!liPost) {
        if (liAlreadyGenerated) {
          console.log(`    ⏭ Skipping — LinkedIn Status is "Generated" but LinkedIn Post is empty (row ${row.rowIndex})`);
          continue;
        }
        console.log(`    ℹ️  No sheet content — generating LI post for: ${row.title.slice(0, 50)}`);
        try {
          liPost = await generateLiPost({ url: row.targetUrl, title: row.title, seoRanking: 999, priority: row.priority ?? 'P3' });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — generation failed: ${genErr.message}`);
          continue;
        }
        if (!liPost?.trim()) { console.log(`    ⏭ Skipping — generated content empty`); continue; }
      } else if (liPost.length > MAX_POST_LENGTH || hasUnfilledPlaceholder(liPost)) {
        console.log(`    ⚠️  Sanity: sheet LI post ${hasUnfilledPlaceholder(liPost) ? 'has an unfilled placeholder' : `is ${liPost.length} chars (over ${MAX_POST_LENGTH})`} — regenerating`);
        try {
          liPost = await generateLiPost({ url: row.targetUrl, title: row.title, seoRanking: 999, priority: row.priority ?? 'P3' });
        } catch (genErr: any) {
          console.log(`    ⏭ Skipping — regeneration failed: ${genErr.message}`);
          continue;
        }
        if (!liPost?.trim()) { console.log(`    ⏭ Skipping — regenerated content empty`); continue; }
      }
      row.linkedinPost = liPost;

      // 3. Inject UTM into post content
      liPost = injectUTM(liPost, UTM_PARAMS.LinkedIn);
      row.linkedinPost = liPost;

      // 4. Post to LI — carousel if Images URL present, else normal
      const pdfPath = (row.imagesUrl || '').trim();
      console.log(`    Posting to LI (account: ${row.name})${pdfPath ? ' [CAROUSEL]' : ''}...`);
      const postResult = pdfPath
        ? await postToLiAccountCarousel(row.name, liPost, pdfPath)
        : await postToLiAccount(row.name, liPost);

      if (postResult.success) {
        liPost = postResult.postText || liPost;
        row.linkedinPost = liPost;
        await saveLiBatchResult(row, {
          liPost,
          liPostUrl: postResult.postUrl || '',
          liStatus: 'Posted',
          liBatch: batchLabel,
        });
        recordPost('li');
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
  postText?: string;
  error?: string;
}> {
  try {
    const loginResult = await withTimeout(
      executeBrowserTool('login_linkedin', { nickname: accountName }),
      2 * 60 * 1000, `LI login:${accountName}`,
      () => closeLiSession(accountName)
    );
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'LinkedIn login failed' };
    }

    const postResult = await withTimeout(
      executeBrowserTool('post_linkedin', { nickname: accountName, postText }),
      3 * 60 * 1000, `LI post:${accountName}`,
      () => closeLiSession(accountName)
    );
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      postText: postResult.postText,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function postToLiAccountCarousel(accountName: string, postText: string, pdfPath: string): Promise<{
  success: boolean;
  postUrl?: string;
  postText?: string;
  error?: string;
}> {
  try {
    const loginResult = await withTimeout(
      executeBrowserTool('login_linkedin', { nickname: accountName }),
      2 * 60 * 1000, `LI login:${accountName}`,
      () => closeLiSession(accountName)
    );
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'LinkedIn login failed' };
    }

    const postResult = await withTimeout(
      executeBrowserTool('post_linkedin_carousel', { nickname: accountName, postText, pdfPath }),
      3 * 60 * 1000, `LI carousel post:${accountName}`,
      () => closeLiSession(accountName)
    );
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      postText: postResult.postText,
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
export async function runMediumBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  // Medium uses BLOG sheet
  console.log(`\n[MEDIUM BATCH] Checking for rows ready to post...`);

  const rows = rowsOverride ?? await getRowsForContinuousMediumPosting(25);

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
      let mediumPost = await generateMediumPost(row);
      mediumPost = ensureTargetUrl(mediumPost, row.targetUrl);
      row.mediumPost = mediumPost;

      // 3. Post to Medium — always use "New Name" column, never Name.
      const mediumNickname = (row.newName || '').trim();
      if (!mediumNickname) {
        throw new Error(`Row ${row.rowIndex}: "New Name" column is empty — cannot post to Medium`);
      }
      console.log(`    Posting to Medium (account: ${mediumNickname})...`);
      const postResult = await postToMediumAccount(mediumNickname, row.title || '', mediumPost);

      if (postResult.success) {

        await saveMediumBatchResult(row, {
          mediumPost,
          mediumPostUrl: postResult.postUrl || '',
          mediumStatus: 'Posted',
          mediumBatch: batchLabel,
        });
        recordPost('medium');
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
        await unclaimGroupRow(row.rowIndex, row.sheetType === 'pool' ? 'pool' : 'newLogic').catch(() => {});
        console.log(`    ❌ Failed: ${postResult.error} — row unclaimed for retry`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'medium', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'medium', accountName: row.newName, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveMediumBatchResult(row, {
          mediumPost: row.mediumPost || '',
          mediumPostUrl: '',
          mediumStatus: 'Error',
          mediumBatch: row.mediumBatch || '',  // Keep existing batch, don't assign new one
          mediumError: err.message,
        });
        await unclaimGroupRow(row.rowIndex, row.sheetType === 'pool' ? 'pool' : 'newLogic').catch(() => {});
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
export async function runLinkmateBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[LINKMATE BATCH] Starting...`);

  const rows = rowsOverride ?? await getRowsForContinuousLinkmatePosting(15);

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
      let linkMateContent = await generateLinkmatePost(row);
      linkMateContent = ensureTargetUrl(linkMateContent, row.targetUrl);
      if (!linkMateContent) {
        console.warn(`    ⚠️  No Content (HTML) found — skipping`);
        failed++;
        continue;
      }

      // Post to Linkmate
      console.log(`    Posting to Linkmate (account: ${row.name})...`);
      const postResult = await postToLinkmateAccount(row.name, row.title || '', linkMateContent, row.seedKeyword);

      if (postResult.success) {
        await saveSlotResult(row.rowIndex, 1, 'Linkmate', {
          url: postResult.postUrl || '',
          status: 'Posted',
          batch: batchLabel,
        });
        recordPost('linkmate');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 1, 'Linkmate', {
          url: '',
          status: 'Failed',
          batch: batchLabel,
          error: postResult.error,
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
        await saveSlotResult(row.rowIndex, 1, 'Linkmate', {
          url: '',
          status: 'Error',
          batch: batchLabel,
          error: err.message,
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
export async function runGoogleSiteBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[GOOGLE SITES BATCH] Starting...`);

  const rows = rowsOverride ?? await getRowsForContinuousGoogleSitePosting(25);

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
      let googleSitePost = await generateGoogleSitePost(row);
      googleSitePost = ensureTargetUrl(googleSitePost, row.targetUrl);
      row.googleSitePost = googleSitePost;

      // 3. Post to Google Sites — always use "New Name" column, never Name
      const googleSiteNickname = (row.newName || '').trim();
      if (!googleSiteNickname) {
        throw new Error(`Row ${row.rowIndex}: "New Name" column is empty — cannot post to Google Sites`);
      }
      console.log(`    Posting to Google Sites (account: ${googleSiteNickname})...`);
      const postResult = await postToGoogleSiteAccount(googleSiteNickname, row.title || '', googleSitePost, row.seedKeyword);

      if (postResult.success) {
        await saveGoogleSiteBatchResult(row, {
          googleSitePost,
          googleSitePostUrl: postResult.postUrl || '',
          googleSiteStatus: 'Posted',
          googleSiteBatch: batchLabel,
        });
        recordPost('googlesite');
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
      await applyFix(kbEntry, { platform: 'googlesite', accountName: row.newName, rowIndex: row.rowIndex });
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

// Google Sites is now tracked per-account (googleSitePages map in
// browserTools.ts + contexts map in browser/googlesite/login.ts), the same
// pattern Facebook/LinkedIn already use — so two accounts posting at the same
// moment (e.g. Group4's tail end overlapping Group4b, or a manual retry
// landing mid-batch) each get their own browser and can never touch each
// other's session. No queue/lock needed here.

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

// ── Dev.to Batch ───────────────────────────────────────────────────────────────

/**
 * Run Dev.to batch: pick rows → SEO check → generate Dev.to post (HTML) → post → save all
 */
export async function runDevtoBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[DEV.TO BATCH] Starting...`);

  const rows = rowsOverride ?? await getRowsForContinuousDevtoPosting(15);

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
      let devtoPost = await generateDevtoPost(row);
      devtoPost = ensureTargetUrl(devtoPost, row.targetUrl);

      // 3. Post to Dev.to
      console.log(`    Posting to Dev.to (account: ${row.name})...`);
      const postResult = await postToDevtoAccount(row.name, row.title || '', devtoPost);

      if (postResult.success) {
        await saveSlotResult(row.rowIndex, 3, 'Dev.to', {
          url: postResult.postUrl || '',
          status: 'Posted',
          batch: batchLabel,
        });
        recordPost('devto');
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 3, 'Dev.to', {
          url: '',
          status: 'Failed',
          batch: batchLabel,
          error: postResult.error || 'Unknown error',
        });
        failed++;
      }
    } catch (err: any) {
      const kbEntry = recordError({ rawError: err.message, platform: 'devto', stage: 'post', rowIndex: row.rowIndex, rowTitle: row.title, batchRun: batchNum });
      await applyFix(kbEntry, { platform: 'devto', accountName: row.name, rowIndex: row.rowIndex });
      console.error(`  ❌ Row ${row.rowIndex} [${kbEntry.classification}]: ${err.message}`);
      try {
        await saveSlotResult(row.rowIndex, 3, 'Dev.to', {
          url: '',
          status: 'Error',
          batch: batchLabel,
          error: err.message,
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
export async function runLinkedinPulseBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[LINKEDIN PULSE BATCH] Starting...`);

  const rows = rowsOverride ?? await getRowsForContinuousLinkedinPulsePosting(15);

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
        let pulseContent = await generateLinkedinPulsePost(row);
        pulseContent.html = ensureTargetUrl(pulseContent.html, row.targetUrl);

        // Title → Blog Title column; SEO title → same Blog Title column; Share box → Blog Caption
        const pulseTitle = (row.title || '').trim() || pulseContent.title;
        const pulseCaption = (row.blogCaption || '').trim() || pulseContent.seoDescription;

        // 3. Post to LinkedIn Pulse
        console.log(`      Posting to LinkedIn Pulse...`);
        const postResult = await postToPulseAccount(
          accountName,
          pulseTitle,
          pulseContent.html,
          pulseTitle,
          pulseContent.seoDescription,
          pulseCaption
        );

        if (postResult.success) {
          await saveSlotResult(row.rowIndex, 2, 'LinkedIn Pulse', {
            url: postResult.postUrl || '',
            status: 'Posted',
            batch: batchLabel,
          });
          recordPost('linkedinpulse');
          console.log(`      ✅ Posted → ${postResult.postUrl}`);
          posted++;
        } else {
          await saveSlotResult(row.rowIndex, 2, 'LinkedIn Pulse', {
            url: '',
            status: 'Failed',
            batch: batchLabel,
            error: postResult.error,
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
          await saveSlotResult(row.rowIndex, 2, 'LinkedIn Pulse', {
            url: '',
            status: 'Error',
            batch: batchLabel,
            error: err.message,
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
  seoDescription?: string,
  shareCaption?: string
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
      shareCaption,
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
export async function runCalisthenicsNBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[CALISTHENICS BATCH] Starting...`);

  const rows = rowsOverride ?? await getRowsForContinuousCalisthenicsPosting(15);

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
      let calisthenicsContent = await generateCalisthenicsPost(row);
      calisthenicsContent = ensureTargetUrl(calisthenicsContent, row.targetUrl);

      // 3. Post to Calisthenics
      console.log(`    Posting to Calisthenics (account: ${row.name})...`);
      const postResult = await postToCalisthenicsAccount(row.name, row.title || '', calisthenicsContent, row.seedKeyword);

      if (postResult.success) {
        await saveSlotResult(row.rowIndex, 2, 'Calisthenics', {
          url: postResult.postUrl || '',
          status: 'Posted',
          batch: batchLabel,
        });
        recordPost('calisthenics');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 2, 'Calisthenics', {
          url: '',
          status: 'Failed',
          batch: batchLabel,
          error: postResult.error,
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
        await saveSlotResult(row.rowIndex, 2, 'Calisthenics', {
          url: '',
          status: 'Error',
          batch: batchLabel,
          error: err.message,
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

      let substackContent = await generateSubstackPost(row);
      substackContent = ensureTargetUrl(substackContent, row.targetUrl);
      console.log(`    Posting to Substack (account: ${row.name})...`);
      const postResult = await postToSubstackAccount(row.name, row.title || '', substackContent);

      if (postResult.success) {
        await saveSubstackBatchResult(row, {
          substackPostUrl: postResult.postUrl || '',
          substackStatus: 'Posted',
          substackBatch: batchLabel,
        });
        recordPost('substack');
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

// ──── WordPress Batch ───────────────────────────────────────────────────────
export async function runWordpressBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[WORDPRESS BATCH] Starting...`);
  const progress = getBlogRowProgress();
  console.log(`  [WordPress] Last posted row index: ${progress.wordpress}`);
  const rows = rowsOverride ?? await getRowsForContinuousWordpressPosting(15, progress.wordpress);
  if (rows.length === 0) { console.log('[WORDPRESS BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for WordPress posting (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing [row ${row.rowIndex}]: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || await generateHackmdPost(row);
      content = ensureTargetUrl(content, row.targetUrl);
      const title = row.title;
      const r = await postToWordpressAccount(row.name, title, content);
      if (r.success) {
        await saveSlotResult(row.rowIndex, 3, 'WordPress', { url: r.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('wordpress');
        console.log(`    ✅ Posted → ${r.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 3, 'WordPress', { url: '', status: 'Failed', batch: batchLabel, error: r.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveSlotResult(row.rowIndex, 3, 'WordPress', { url: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    // Always advance progress regardless of success/failure (skip when posting from Content Pool —
    // pool rowIndex values are on a different sheet and would corrupt the Blogs-tab cursor)
    if (!rowsOverride) {
      try {
        const prog = getBlogRowProgress();
        if (row.rowIndex > (prog.wordpress || 0)) {
          saveBlogRowProgress({ ...prog, wordpress: row.rowIndex });
        }
      } catch (progErr: any) {
        console.error(`   ❌ Progress save error: ${progErr.message}`);
      }
    }
  }
  console.log(`\n[WORDPRESS BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ──── Blogger Batch ─────────────────────────────────────────────────────────
export async function runBloggerBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[BLOGGER BATCH] Starting...`);
  const progress = getBlogRowProgress();
  console.log(`  [Blogger] Last posted row index: ${progress.blogger}`);
  const rows = rowsOverride ?? await getRowsForContinuousBloggerPosting(15, progress.blogger);
  if (rows.length === 0) { console.log('[BLOGGER BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Blogger posting (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing [row ${row.rowIndex}]: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || await generateHackmdPost(row);
      const title = row.title;
      if (row.targetUrl && !content.includes(row.targetUrl)) {
        content += `\n\n<p><a href="${row.targetUrl}">Read the full report on Ken Research</a></p>`;
      }
      const r = await postToBloggerAccount(row.name, title, content);
      if (r.success) {
        await saveSlotResult(row.rowIndex, 1, 'Blogger', { url: r.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('blogger');
        console.log(`    ✅ Posted → ${r.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 1, 'Blogger', { url: '', status: 'Failed', batch: batchLabel, error: r.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveSlotResult(row.rowIndex, 1, 'Blogger', { url: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    // Always advance progress regardless of success/failure so we never re-pick same rows
    // (skip when posting from Content Pool — pool rowIndex values are on a different sheet)
    if (!rowsOverride) {
      try {
        const prog = getBlogRowProgress();
        if (row.rowIndex > (prog.blogger || 0)) {
          saveBlogRowProgress({ ...prog, blogger: row.rowIndex });
        }
      } catch (progErr: any) {
        console.error(`   ❌ Progress save error: ${progErr.message}`);
      }
    }
  }
  console.log(`\n[BLOGGER BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ──── HackMD Batch ──────────────────────────────────────────────────────────
export async function runHackmdBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[HACKMD BATCH] Starting...`);

  const rows = rowsOverride ?? await getRowsForContinuousHackmdPosting(15);

  if (rows.length === 0) {
    console.log('[HACKMD BATCH] No rows available');
    return;
  }

  const batchLabel = `Batch ${batchNum}`;
  const BATCH_DEADLINE = Date.now() + 5 * 60 * 1000; // 5-minute hard limit (API-only, fast)

  console.log(`\n[HACKMD BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for HackMD posting`);
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    if (Date.now() > BATCH_DEADLINE) {
      console.warn(`\n[HACKMD BATCH] 5-minute deadline reached — stopping early (${posted} posted so far)`);
      break;
    }
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      console.log(`    SEO (from sheet): Page ${row.seoPage || 'N/A'} | Priority: ${row.priority || 'N/A'}`);

      let hackmdContent = await generateHackmdPost(row);
      hackmdContent = ensureTargetUrl(hackmdContent, row.targetUrl);
      console.log(`    Posting to HackMD (account: ${row.name})...`);
      const postResult = await postToHackmdAccount(row.title || '', hackmdContent, row.name, row.description || '');

      if (postResult.success) {
        await saveSlotResult(row.rowIndex, 3, 'HackMD', {
          url: postResult.postUrl || '',
          status: 'Posted',
          batch: batchLabel,
        });
        recordPost('hackmd');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 3, 'HackMD', {
          url: '',
          status: 'Failed',
          batch: batchLabel,
          error: postResult.error,
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
        await saveSlotResult(row.rowIndex, 3, 'HackMD', {
          url: '',
          status: 'Error',
          batch: batchLabel,
          error: err.message,
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

// Helper: Post to HackMD via API only (no browser — fast, fits 5-min batch budget)
async function postToHackmdAccount(
  title: string,
  htmlContent: string,
  accountName?: string,
  _description?: string
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const apiKey = getHackMDApiKey(accountName);
    if (!apiKey) {
      return { success: false, error: `No HackMD API key for account: ${accountName || 'unknown'}` };
    }
    return await postToHackMDApi(apiKey, title, htmlContent);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

function getHackMDApiKey(nickname?: string): string | null {
  if (!nickname) return null;
  try {
    const accounts = getHackMDAccounts();
    const account = accounts.find(
      a => a.nickname?.toLowerCase() === nickname.toLowerCase()
        || a.username?.toLowerCase() === nickname.toLowerCase()
        || a.email?.toLowerCase() === nickname.toLowerCase(),
    );
    return (account as any)?.apiKey || null;
  } catch {
    return null;
  }
}

// ── Save helpers with batch column ──────────────────────────────────────────────

// Facebook, Tumblr, LinkedIn now share the Social Media tab's slot columns
// (see saveSocialSlotResult) instead of their own dedicated Fb/Tumblr/LI
// columns — Facebook+Tumblr+Pearltrees share slot 2, LinkedIn+X+Instapaper+
// Raindrop share slot 1. Only url/status/error/batch are tracked per slot
// (no post-body-text column), matching the New Logic slot pattern.
async function saveFbBatchResult(
  row: SheetRow,
  data: { fbPost: string; fbPostUrl: string; fbStatus: string; fbBatch: string; fbError?: string }
): Promise<void> {
  await saveSocialSlotResult(row.rowIndex, 2, 'Facebook', {
    url: data.fbPostUrl,
    status: data.fbStatus,
    error: data.fbError || '',
    batch: data.fbBatch,
  });
}

async function saveTumblrBatchResult(
  row: SheetRow,
  data: { tumblrPost: string; tumblrPostUrl: string; tumblrStatus: string; tumblrBatch: string; tumblrError?: string }
): Promise<void> {
  await saveSocialSlotResult(row.rowIndex, 2, 'Tumblr', {
    url: data.tumblrPostUrl,
    status: data.tumblrStatus,
    error: data.tumblrError || '',
    batch: data.tumblrBatch,
  });
}

async function saveLiBatchResult(
  row: SheetRow,
  data: { liPost: string; liPostUrl: string; liStatus: string; liBatch: string; liError?: string }
): Promise<void> {
  await saveSocialSlotResult(row.rowIndex, 1, 'LinkedIn', {
    url: data.liPostUrl,
    status: data.liStatus,
    error: data.liError || '',
    batch: data.liBatch,
  });
}

// Medium now shares slot 1 on the New Logic tab (see getRowsForContinuousMediumPosting).
async function saveMediumBatchResult(
  row: SheetRow,
  data: { mediumPost: string; mediumPostUrl: string; mediumStatus: string; mediumBatch: string; mediumError?: string }
): Promise<void> {
  await saveSlotResult(row.rowIndex, 1, 'Medium', {
    url: data.mediumPostUrl,
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

// Google Sites now shares slot 2 on the New Logic tab (see getRowsForContinuousGoogleSitePosting).
async function saveGoogleSiteBatchResult(
  row: SheetRow,
  data: { googleSitePost: string; googleSitePostUrl: string; googleSiteStatus: string; googleSiteBatch: string; googleSiteError?: string }
): Promise<void> {
  await saveSlotResult(row.rowIndex, 2, 'Google Sites', {
    url: data.googleSitePostUrl,
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

// ──── Patreon Batch ───────────────────────────────────────────────────────────

export async function runPatreonBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[PATREON BATCH] Starting...`);
  const rows = await getRowsForContinuousPatreonPosting(15);
  if (rows.length === 0) { console.log('[PATREON BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Patreon (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title;
      if (!content) {
        await saveUnifiedPatreonResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_patreon', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_patreon', { title, htmlContent: content });
      if (postResult.success) {
        await saveUnifiedPatreonResult(row, { postUrl: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('patreon');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveUnifiedPatreonResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveUnifiedPatreonResult(row, { postUrl: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[PATREON BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ──── Notion Batch ─────────────────────────────────────────────────────────────

export async function runNotionBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[NOTION BATCH] Starting...`);
  const rows = rowsOverride ?? await getRowsForContinuousNotionPosting(15);
  if (rows.length === 0) { console.log('[NOTION BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Notion (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title || row.descriptionTitle || '';
      if (!content) {
        await saveSlotResult(row.rowIndex, 2, 'Notion', { url: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_notion', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_notion', { title, htmlContent: content });
      if (postResult.success) {
        await saveSlotResult(row.rowIndex, 2, 'Notion', { url: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('notion');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 2, 'Notion', { url: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveSlotResult(row.rowIndex, 2, 'Notion', { url: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[NOTION BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ──── Note Batch ───────────────────────────────────────────────────────────────

export async function runNoteBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[NOTE BATCH] Starting...`);
  const rows = await getRowsForContinuousNotePosting(15);
  if (rows.length === 0) { console.log('[NOTE BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Note (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title || row.descriptionTitle || '';
      if (!content) {
        await saveUnifiedNoteResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_note', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_note', { title, htmlContent: content });
      if (postResult.success) {
        await saveUnifiedNoteResult(row, { postUrl: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('note');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveUnifiedNoteResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveUnifiedNoteResult(row, { postUrl: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[NOTE BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ──── Naver Batch ──────────────────────────────────────────────────────────────

export async function runNaverBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[NAVER BATCH] Starting...`);
  const rows = rowsOverride ?? await getRowsForContinuousNaverPosting(15);
  if (rows.length === 0) { console.log('[NAVER BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Naver (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title || row.descriptionTitle || '';
      if (!content) {
        await saveUnifiedNaverResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_naver', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_naver', { title, htmlContent: content });
      if (postResult.success) {
        await saveUnifiedNaverResult(row, { postUrl: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('naver');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveUnifiedNaverResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveUnifiedNaverResult(row, { postUrl: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[NAVER BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ──── Velog Batch ──────────────────────────────────────────────────────────────

export async function runVelogBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[VELOG BATCH] Starting...`);
  const rows = await getRowsForContinuousVelogPosting(15);
  if (rows.length === 0) { console.log('[VELOG BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Velog (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title || row.descriptionTitle || '';
      if (!content) {
        await saveSlotResult(row.rowIndex, 1, 'Velog', { url: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_velog', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_velog', { title, htmlContent: content });
      if (postResult.success) {
        await saveSlotResult(row.rowIndex, 1, 'Velog', { url: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('velog');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 1, 'Velog', { url: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveSlotResult(row.rowIndex, 1, 'Velog', { url: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[VELOG BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ──── Coda Batch ───────────────────────────────────────────────────────────────

export async function runCodaBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[CODA BATCH] Starting...`);
  const rows = rowsOverride ?? await getRowsForContinuousCodaPosting(15);
  if (rows.length === 0) { console.log('[CODA BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Coda (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title || row.descriptionTitle || '';
      if (!content) {
        await saveSlotResult(row.rowIndex, 1, 'Coda', { url: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_coda', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_coda', { title, htmlContent: content });
      if (postResult.success) {
        await saveSlotResult(row.rowIndex, 1, 'Coda', { url: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('coda');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveSlotResult(row.rowIndex, 1, 'Coda', { url: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveSlotResult(row.rowIndex, 1, 'Coda', { url: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[CODA BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Ameba Batch ───────────────────────────────────────────────────────────────

export async function runAmebaBatch(batchNum: number = 1): Promise<void> {
  const { getRowsForContinuousAmebaPosting, saveUnifiedAmebaResult } = await import('../sheets/sheets.js');
  const { loginToAmeba, closeAmebaBrowser } = await import('../browser/ameba/login.js');
  const { postToAmeba } = await import('../browser/ameba/poster.js');

  const rows = await getRowsForContinuousAmebaPosting(15);
  if (rows.length === 0) { console.log('[AMEBA BATCH] No rows available'); return; }

  const batchLabel = `Batch ${batchNum}`;
  console.log(`\n[AMEBA BATCH] Starting ${batchLabel}...`);
  console.log(`  Found ${rows.length} rows ready for Ameba posting`);
  let posted = 0, failed = 0;

  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || await generateHackmdPost(row);
      content = ensureTargetUrl(content, row.targetUrl);
      const title = row.title || row.descriptionTitle || '';

      let r: { success: boolean; postUrl: string; postedAt: Date } | null = null;
      try {
        const page = await withTimeout(
          loginToAmeba({ nickname: row.name }),
          2 * 60 * 1000, `Ameba login:${row.name}`
        );
        r = await withTimeout(
          postToAmeba(page, title, content),
          2 * 60 * 1000, `Ameba post:${row.name}`
        );
      } finally {
        await closeAmebaBrowser();
      }

      if (r?.success) {
        await saveUnifiedAmebaResult(row, { postUrl: r.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('ameba');
        console.log(`    ✅ Posted → ${r.postUrl}`);
        posted++;
      } else {
        await saveUnifiedAmebaResult(row, { postUrl: '', status: 'Failed', batch: batchLabel });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveUnifiedAmebaResult(row, { postUrl: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[AMEBA BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Retry single row on a specific platform ───────────────────────────────────

const BLOG_PLATFORMS  = ['googlesite', 'hackmd', 'devto', 'medium', 'linkmate', 'linkedin-pulse', 'calisthenics', 'substack', 'wordpress', 'blogger', 'patreon', 'notion', 'note', 'naver', 'velog', 'coda'];
const SOCIAL_PLATFORMS = ['x', 'facebook', 'linkedin'];

// Verified against each platform's real getRowsForContinuousXPosting() in
// sheets.ts — most New Logic 3-slot platforms (getRowsNeedingSlot) live on
// the 'newLogic' sheet, not 'blog' as a naive default would assume. Only
// Substack/Naver/Paragraph genuinely read the 'blog' sheet; X/Facebook/
// LinkedIn read 'social'. Getting this wrong silently fails column lookups
// rather than erroring clearly, so keep this map in sync with sheets.ts
// whenever a platform's picker function changes sheets.
const RETRY_ROW_SHEET_TYPE: Record<string, 'social' | 'blog' | 'newLogic'> = {
  x: 'social', facebook: 'social', linkedin: 'social',
  googlesite: 'newLogic', medium: 'newLogic', linkmate: 'newLogic', devto: 'newLogic',
  'linkedin-pulse': 'newLogic', calisthenics: 'newLogic', wordpress: 'newLogic',
  blogger: 'newLogic', hackmd: 'newLogic', notion: 'newLogic', velog: 'newLogic',
  coda: 'newLogic',
  substack: 'blog', naver: 'blog', paragraph: 'blog',
};

export async function runRetryRow(rowIndex: number, platform: string): Promise<void> {
  const p = platform.toLowerCase().replace(/_/g, '-');
  const sheetType = RETRY_ROW_SHEET_TYPE[p] ?? 'blog';

  console.log(`\n🔄 Retry row ${rowIndex} on ${p} (${sheetType} sheet)`);

  const row = await getSheetRowByIndex(rowIndex, sheetType);
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in ${sheetType} sheet`);
    return;
  }

  console.log(`   Title   : ${row.title?.slice(0, 70)}`);
  console.log(`   Account : ${(p === 'medium' || p === 'googlesite') ? row.newName : row.name}`);

  const label = 'Retry';

  const title = row.title || '';

  try {
    switch (p) {
      case 'googlesite': {
        let content = await generateGoogleSitePost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const gsNick = (row.newName || '').trim();
        if (!gsNick) throw new Error(`Row ${row.rowIndex}: "New Name" column empty — cannot post to Google Sites`);
        const r = await postToGoogleSiteAccount(gsNick, title, content, row.seedKeyword);
        await saveGoogleSiteBatchResult(row, { googleSitePost: content, googleSitePostUrl: r.postUrl || '', googleSiteStatus: r.success ? 'Posted' : 'Failed', googleSiteBatch: label, googleSiteError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'hackmd': {
        let content = await generateHackmdPost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const r = await postToHackmdAccount(title, content, row.name, row.description || '');
        await saveHackmdBatchResult(row, { hackmdPostUrl: r.postUrl || '', hackmdStatus: r.success ? 'Posted' : 'Failed', hackmdBatch: label, hackmdError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'devto': {
        let content = await generateDevtoPost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const r = await postToDevtoAccount(row.name, title, content);
        await saveDevtoBatchResult(row, { devtoPostUrl: r.postUrl || '', devtoStatus: r.success ? 'Posted' : 'Failed', devtoBatch: label, devtoError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'medium': {
        const mediumNick = (row.newName || '').trim();
        if (!mediumNick) throw new Error(`Row ${row.rowIndex}: "New Name" column empty — cannot post to Medium`);
        let content = await generateMediumPost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const r = await postToMediumAccount(mediumNick, title, content);
        await saveMediumBatchResult(row, { mediumPost: content, mediumPostUrl: r.postUrl || '', mediumStatus: r.success ? 'Posted' : 'Failed', mediumBatch: label, mediumError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'linkmate': {
        let content = await generateLinkmatePost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const r = await postToLinkmateAccount(row.name, title, content, row.seedKeyword);
        await saveLinkmateBatchResult(row, { linkMateContent: content, linkMatePostUrl: r.postUrl || '', linkMateStatus: r.success ? 'Posted' : 'Failed', linkmateBatch: label, linkMateError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'linkedin-pulse': {
        const pulseContent = await generateLinkedinPulsePost(row);
        pulseContent.html = ensureTargetUrl(pulseContent.html, row.targetUrl);
        const retryPulseTitle = (row.title || '').trim() || pulseContent.title;
        const retryPulseCaption = (row.blogCaption || '').trim() || pulseContent.seoDescription;
        const r = await postToPulseAccount(row.name, retryPulseTitle, pulseContent.html, retryPulseTitle, pulseContent.seoDescription, retryPulseCaption);
        await saveLinkedinPulseBatchResult(row, { linkedinPulsePostUrl: r.postUrl || '', linkedinPulseStatus: r.success ? 'Posted' : 'Failed', linkedinPulseBatch: label, linkedinPulseError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'calisthenics': {
        let content = await generateCalisthenicsPost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const r = await postToCalisthenicsAccount(row.name, title, content);
        await saveCalisthenicsResultBatch(row, { calisthenicsPostUrl: r.postUrl || '', calisthenicsStatus: r.success ? 'Posted' : 'Failed', calisthenicssBatch: label, calisthenicsError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'substack': {
        let content = await generateSubstackPost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const r = await postToSubstackAccount(row.name, title, content);
        await saveSubstackBatchResult(row, { substackPostUrl: r.postUrl || '', substackStatus: r.success ? 'Posted' : 'Failed', substackBatch: label, substackError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'blogger': {
        let content = row.blogContent || await generateHackmdPost(row);
        content = ensureTargetUrl(content, row.targetUrl);
        const r = await postToBloggerAccount(row.name, title, content);
        await saveBloggerBatchResult(row, { bloggerPostUrl: r.postUrl || '', bloggerStatus: r.success ? 'Posted' : 'Failed', bloggerBatch: label, bloggerError: r.error });
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
      case 'notion': {
        const content = row.blogContent || '';
        if (!content) { console.log('⏭ Skipping — no blog content'); break; }
        const notionTitle = row.title || row.descriptionTitle || title;
        const loginResult = await executeBrowserTool('login_notion', { nickname: row.name });
        if (!loginResult.success) throw new Error(loginResult.error || 'Notion login failed');
        const r = await executeBrowserTool('post_notion', { title: notionTitle, htmlContent: ensureTargetUrl(content, row.targetUrl) });
        await saveUnifiedNotionResult(row, { postUrl: r.postUrl || '', status: r.success ? 'Posted' : 'Failed', batch: label, error: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'naver': {
        const content = row.blogContent || '';
        if (!content) { console.log('⏭ Skipping — no blog content'); break; }
        const naverTitle = row.title || row.descriptionTitle || title;
        const loginResult = await executeBrowserTool('login_naver', { nickname: row.name });
        if (!loginResult.success) throw new Error(loginResult.error || 'Naver login failed');
        const r = await executeBrowserTool('post_naver', { title: naverTitle, htmlContent: ensureTargetUrl(content, row.targetUrl) });
        await saveUnifiedNaverResult(row, { postUrl: r.postUrl || '', status: r.success ? 'Posted' : 'Failed', batch: label, error: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'velog': {
        const content = row.blogContent || '';
        if (!content) { console.log('⏭ Skipping — no blog content'); break; }
        const velogTitle = row.title || row.descriptionTitle || title;
        const loginResult = await executeBrowserTool('login_velog', { nickname: row.name });
        if (!loginResult.success) throw new Error(loginResult.error || 'Velog login failed');
        const r = await executeBrowserTool('post_velog', { title: velogTitle, htmlContent: ensureTargetUrl(content, row.targetUrl) });
        await saveSlotResult(row.rowIndex, 1, 'Velog', { url: r.postUrl || '', status: r.success ? 'Posted' : 'Failed', batch: label, error: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'coda': {
        const content = row.blogContent || '';
        if (!content) { console.log('⏭ Skipping — no blog content'); break; }
        const codaTitle = row.title || row.descriptionTitle || title;
        const loginResult = await executeBrowserTool('login_coda', { nickname: row.name });
        if (!loginResult.success) throw new Error(loginResult.error || 'Coda login failed');
        const r = await executeBrowserTool('post_coda', { title: codaTitle, htmlContent: ensureTargetUrl(content, row.targetUrl) });
        await saveUnifiedCodaResult(row, { postUrl: r.postUrl || '', status: r.success ? 'Posted' : 'Failed', batch: label, error: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'x': {
        let tweet = row.xPost?.trim() || '';
        if (!tweet) tweet = await generateTweet({ url: row.targetUrl, title: row.title, seoRanking: 999, priority: row.priority ?? 'P3', marketValue: row.marketValue });
        if (!tweet?.trim()) { console.log('⏭ Skipping — no content'); break; }
        const r = await runXAgent({ tweetText: tweet, accountHandle: row.name });
        await saveSocialSlotResult(row.rowIndex, 1, 'X', { url: r.tweetUrl || '', status: r.success ? 'Posted' : 'Failed', error: r.error || '', batch: label });
        console.log(r.success ? `✅ Posted → ${r.tweetUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'facebook': {
        let fbPost = row.fbPost?.trim() || '';
        const fbAlreadyGenerated = (row.fbStatus || '').trim().toLowerCase() === 'generated';
        if (!fbPost && fbAlreadyGenerated) { console.log(`⏭ Skipping — FB Status is "Generated" but FB Post is empty (row ${row.rowIndex})`); break; }
        if (!fbPost) fbPost = await generateFbPost({ url: row.targetUrl, title: row.title, seoRanking: 1, priority: 'P1' });
        else if (fbPost.length > MAX_POST_LENGTH || hasUnfilledPlaceholder(fbPost)) {
          console.log(`⚠️  Sanity: sheet FB post ${hasUnfilledPlaceholder(fbPost) ? 'has an unfilled placeholder' : `is ${fbPost.length} chars (over ${MAX_POST_LENGTH})`} — regenerating`);
          fbPost = await generateFbPost({ url: row.targetUrl, title: row.title, seoRanking: 1, priority: 'P1' });
        }
        if (!fbPost?.trim()) { console.log('⏭ Skipping — no content'); break; }
        const r = await postToFbAccount(row.name, fbPost);
        fbPost = r.postText || fbPost;
        await saveFbBatchResult(row, { fbPost, fbPostUrl: r.postUrl || '', fbStatus: r.success ? 'Posted' : 'Failed', fbBatch: label, fbError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'linkedin': {
        let liPost = row.linkedinPost?.trim() || '';
        const liAlreadyGenerated = (row.linkedinStatus || '').trim().toLowerCase() === 'generated';
        if (!liPost && liAlreadyGenerated) { console.log(`⏭ Skipping — LinkedIn Status is "Generated" but LinkedIn Post is empty (row ${row.rowIndex})`); break; }
        if (!liPost) liPost = await generateLiPost({ url: row.targetUrl, title: row.title, seoRanking: 1, priority: 'P1' });
        else if (liPost.length > MAX_POST_LENGTH || hasUnfilledPlaceholder(liPost)) {
          console.log(`⚠️  Sanity: sheet LI post ${hasUnfilledPlaceholder(liPost) ? 'has an unfilled placeholder' : `is ${liPost.length} chars (over ${MAX_POST_LENGTH})`} — regenerating`);
          liPost = await generateLiPost({ url: row.targetUrl, title: row.title, seoRanking: 1, priority: 'P1' });
        }
        if (!liPost?.trim()) { console.log('⏭ Skipping — no content'); break; }
        const r = await postToLiAccount(row.name, liPost);
        liPost = r.postText || liPost;
        await saveLiBatchResult(row, { liPost, liPostUrl: r.postUrl || '', liStatus: r.success ? 'Posted' : 'Failed', liBatch: label, liError: r.error });
        console.log(r.success ? `✅ Posted → ${r.postUrl}` : `❌ Failed: ${r.error}`);
        break;
      }
      case 'paragraph': {
        let content = row.blogContent || '';
        if (!content) { console.log('⏭ Skipping — no blog content'); break; }
        content = ensureTargetUrl(content, row.targetUrl);
        const paraTitle = row.title || row.descriptionTitle || title;
        const loginResult = await executeBrowserTool('login_paragraph', { nickname: row.name });
        if (!loginResult.success) throw new Error(loginResult.error || 'Paragraph login failed');
        const r = await executeBrowserTool('post_paragraph', { title: paraTitle, htmlContent: content });
        await saveUnifiedParagraphResult(row, { postUrl: r.postUrl || '', status: r.success ? 'Posted' : 'Failed', batch: label, error: r.error });
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

    await loginToGoogleSite({ nickname, headless: false });

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

// ── Save Note Session ────────────────────────────────────────────────────────

export async function saveNoteSession(nickname: string): Promise<void> {
  try {
    console.log(`\n📝 Saving Note session for: ${nickname}\n`);

    const { loginToNote, getNoteAccountByNickname } = await import('../browser/note/login.js');

    const account = getNoteAccountByNickname(nickname);
    if (!account) {
      console.error(`❌ Account not found: ${nickname}`);
      return;
    }

    console.log(`🔐 Email: ${account.email}`);
    console.log(`\n🌐 Opening browser — complete login then press Y + Enter...\n`);

    await loginToNote({ nickname });

    console.log(`\n✅ Login detected!`);
    console.log(`✅ Session saved to .sessions/note/`);
    console.log(`\n✅ You can now run Note batches without re-login.\n`);

  } catch (err: any) {
    console.error(`❌ Error saving Note session: ${err.message}\n`);
  }
}

// ── Paragraph Batch ───────────────────────────────────────────────────────────

export async function runParagraphBatch(batchNum: number = 1): Promise<void> {
  console.log(`\n[PARAGRAPH BATCH] Starting...`);
  const rows = await getRowsForContinuousParagraphPosting(15);
  if (rows.length === 0) { console.log('[PARAGRAPH BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Paragraph (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title || row.descriptionTitle || '';
      if (!content) {
        await saveUnifiedParagraphResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_paragraph', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_paragraph', { title, htmlContent: content });
      if (postResult.success) {
        await saveUnifiedParagraphResult(row, { postUrl: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        recordPost('paragraph');
        console.log(`    ✅ Posted → ${postResult.postUrl}`);
        posted++;
      } else {
        await saveUnifiedParagraphResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveUnifiedParagraphResult(row, { postUrl: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[PARAGRAPH BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}

// ── Content Pool Group Batches ────────────────────────────────────────────────
// Claims a fresh block of rows from the "Content Pool" tab and posts that same
// block to every platform in the group, using account nicknames that already
// exist in .accounts/*.json (round-robin, row order → account order).

const ACCOUNT_NAMES_15 = [
  'aniket', 'krishi', 'sameeksha', 'hritika', 'meenakshi', 'vansh', 'kamakshi',
  'vishal', 'pranav', 'shrey', 'sanya', 'shivani', 'vijay', 'avdhesh', 'abhinav',
];

const ACCOUNT_NAMES_25 = [
  ...ACCOUNT_NAMES_15,
  'saksham', 'yash', 'nandika', 'mahi', 'manik', 'gautam', 'ananya', 'arnav', 'snehal', 'piyush',
];

type GroupPlatform =
  | 'linkedinPulse' | 'linkmate' | 'calisthenics'
  | 'devto' | 'hackmd' | 'wordpress'
  | 'blogger' | 'notion' | 'naver' | 'coda'
  | 'medium' | 'googleSite';

const GROUP_PLATFORM_RUNNERS: Record<GroupPlatform, (batchNum: number, rowsOverride?: SheetRow[]) => Promise<void>> = {
  linkedinPulse: runLinkedinPulseBatch,
  linkmate: runLinkmateBatch,
  calisthenics: runCalisthenicsNBatch,
  devto: runDevtoBatch,
  hackmd: runHackmdBatch,
  wordpress: runWordpressBatch,
  blogger: runBloggerBatch,
  notion: runNotionBatch,
  naver: runNaverBatch,
  coda: runCodaBatch,
  medium: runMediumBatch,
  googleSite: runGoogleSiteBatch,
};

// Medium + Google Site only — unchanged from before, own dedicated columns,
// still using the block-claim + post-every-platform-to-every-row model.
// (Naver deliberately excluded from all grouping for now.)
// Medium and Google Sites now post via their own standalone slot-based cron
// entries (slot 1 and slot 2 on New Logic) instead of through this group —
// Group4/Group4b still run and still claim rows + assign "New Name" via
// claimNextRowsForGroup (that rotation is still needed), but no longer post
// anything themselves, hence the empty platforms lists below.
export const GROUP_DEFS: Record<string, { platforms: GroupPlatform[]; accountCount: 15 | 25; batchNum: number }> = {
  Group4:  { platforms: [],                      accountCount: 25, batchNum: 1 },
  Group4b: { platforms: [],                                 accountCount: 25, batchNum: 2 },
};

export async function runGroupBatch(
  groupName: string,
  platforms: GroupPlatform[],
  accountCount: 15 | 25,
  batchNum: number = 1
): Promise<void> {
  console.log(`\n[GROUP BATCH: ${groupName}] Starting — platforms: ${platforms.join(', ')} (${accountCount} rows)`);

  const accountNames = accountCount === 25 ? ACCOUNT_NAMES_25 : ACCOUNT_NAMES_15;
  // Medium and Google Sites exclusively use New Name; never read or write Name.
  const rows = await claimNextRowsForGroup(groupName, accountCount, accountNames, 'newLogic', 'newName');
  if (rows.length === 0) {
    console.log(`[GROUP BATCH: ${groupName}] No unclaimed rows available — skipping.`);
    return;
  }

  rows.forEach(row => { row.sheetType = 'newLogic'; });

  console.log(`[GROUP BATCH: ${groupName}] Claimed ${rows.length} rows — posting sequentially to: ${platforms.join(', ')}`);

  for (const platform of platforms) {
    const runner = GROUP_PLATFORM_RUNNERS[platform];
    if (!runner) {
      console.warn(`[GROUP BATCH: ${groupName}] Unknown platform "${platform}" — skipping.`);
      continue;
    }
    try {
      await runner(batchNum, rows);
    } catch (err: any) {
      console.error(`[GROUP BATCH: ${groupName}] Platform "${platform}" batch threw: ${err.message}`);
    }
  }

  console.log(`\n[GROUP BATCH: ${groupName}] Complete.`);
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
