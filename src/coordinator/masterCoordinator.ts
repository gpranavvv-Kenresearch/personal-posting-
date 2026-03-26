/**
 * masterCoordinator.ts — Master Batch Coordinator
 * Decides which platform batch to run next based on time, capacity, cooldowns
 *
 * Called every 30 minutes by scheduler
 */

import { runSeoAnalysis } from '../agents/seoAgentNew.js';
import { runContentAgent } from '../agents/contentAgentNew.js';
import { runXAgent } from '../agents/xAgentNew.js';
import { runFbBatchAgent } from '../agents/fbBatchAgentNew.js';
import { runLiBatchAgent } from '../agents/liBatchAgentNew.js';
import {
  getUnassignedRows,
  savePostingResult,
  saveUnifiedFbResult,
  saveUnifiedLinkedInResult,
  saveUnifiedSeoData,
  getRowByIndex,
  getUrlsDueForRecheck,
  saveWeeklySerpRecheck,
  getRowsWithoutFbUrl,
  getRowsWithoutLiUrl,
  SheetRow,
} from '../sheets/sheets.js';
import { incrementCount, getCount } from '../config/accountTracker.js';
import fs from 'fs';

const CAPACITY = {
  x: { max: 195, batchSize: 15, cooldownMs: 30 * 60 * 1000 }, // 13 batches × 15, 30 min cooldown
  facebook: { max: 75, batchSize: 15, cooldownMs: 60 * 60 * 1000 }, // 5 batches × 15, 1 hr cooldown
  linkedin: { max: 45, batchSize: 15, cooldownMs: 120 * 60 * 1000 }, // 3 batches × 15, 2 hr cooldown
};

const STATE_FILE = '.sessions/coordinator-state.json';
const BATCH_STATE_FILE = '.sessions/batch-state.json';

interface BatchState {
  facebook: { nextRowIndex: number; currentBatchSize: number; lastRunDate: string };
  linkedin: { nextRowIndex: number; currentBatchSize: number; lastRunDate: string };
}

function getBatchState(): BatchState {
  if (!fs.existsSync(BATCH_STATE_FILE)) {
    return {
      facebook: { nextRowIndex: 1, currentBatchSize: 15, lastRunDate: '' },
      linkedin: { nextRowIndex: 1, currentBatchSize: 15, lastRunDate: '' },
    };
  }
  return JSON.parse(fs.readFileSync(BATCH_STATE_FILE, 'utf8'));
}

function saveBatchState(state: BatchState): void {
  fs.writeFileSync(BATCH_STATE_FILE, JSON.stringify(state, null, 2));
}

export interface CoordinatorState {
  date: string;
  x: { used: number; lastBatchTime: number | null; batchNum: number };
  facebook: { used: number; lastBatchTime: number | null; batchNum: number };
  linkedin: { used: number; lastBatchTime: number | null; batchNum: number };
}

/**
 * Get or initialize coordinator state
 */
function getState(): CoordinatorState {
  const today = new Date().toISOString().split('T')[0];

  if (!fs.existsSync(STATE_FILE)) {
    return {
      date: today,
      x: { used: 0, lastBatchTime: null, batchNum: 0 },
      facebook: { used: 0, lastBatchTime: null, batchNum: 0 },
      linkedin: { used: 0, lastBatchTime: null, batchNum: 0 },
    };
  }

  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  // Reset if new day
  if (state.date !== today) {
    return {
      date: today,
      x: { used: 0, lastBatchTime: null, batchNum: 0 },
      facebook: { used: 0, lastBatchTime: null, batchNum: 0 },
      linkedin: { used: 0, lastBatchTime: null, batchNum: 0 },
    };
  }

  return state;
}

/**
 * Save coordinator state
 */
function saveState(state: CoordinatorState): void {
  fs.mkdirSync('.sessions', { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Check if cooldown elapsed
 */
function isCooldownElapsed(lastTime: number | null, cooldownMs: number): boolean {
  if (!lastTime) return true;
  return Date.now() - lastTime > cooldownMs;
}

/**
 * Check if time is in posting window (11 AM - 6 PM IST)
 */
function isInPostingWindow(): boolean {
  const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const hour = istDate.getHours();
  return hour >= 11 && hour < 18; // 11 AM to 5:59 PM
}

/**
 * Main coordinator loop - called every 30 minutes
 */
export async function runMasterCoordinator(): Promise<void> {
  if (!isInPostingWindow()) {
    console.log('[COORDINATOR] Outside posting window (11 AM - 6 PM IST)');
    return;
  }

  const state = getState();

  console.log(`\n[COORDINATOR] Checking batch schedule...`);
  console.log(`  X: ${state.x.used}/${CAPACITY.x.max} | FB: ${state.facebook.used}/${CAPACITY.facebook.max} | LI: ${state.linkedin.used}/${CAPACITY.linkedin.max}`);

  // Try to run batches (priority: X → FB → LI)
  const xReady = state.x.used < CAPACITY.x.max &&
                 isCooldownElapsed(state.x.lastBatchTime, CAPACITY.x.cooldownMs);
  const fbReady = state.facebook.used < CAPACITY.facebook.max &&
                  isCooldownElapsed(state.facebook.lastBatchTime, CAPACITY.facebook.cooldownMs);
  const liReady = state.linkedin.used < CAPACITY.linkedin.max &&
                  isCooldownElapsed(state.linkedin.lastBatchTime, CAPACITY.linkedin.cooldownMs);

  if (xReady) {
    await runXBatch(state);
    saveState(state);
  }

  if (fbReady) {
    await runFbBatch(state);
    saveState(state);
  }

  if (liReady) {
    await runLiBatch(state);
    saveState(state);
  }

  if (!xReady && !fbReady && !liReady) {
    console.log('[COORDINATOR] All platforms on cooldown or at capacity');
  }
}

/**
 * Run X batch
 */
async function runXBatch(state: CoordinatorState): Promise<void> {
  try {
    console.log(`\n[X BATCH] Starting batch ${state.x.batchNum + 1}...`);

    const urlsToProcess = await getUnassignedRows();
    if (urlsToProcess.length === 0) {
      console.log('[X BATCH] No unassigned URLs');
      return;
    }

    const batchUrls = urlsToProcess.slice(0, 15);
    let posted = 0;

    for (const row of batchUrls) {
      try {
        console.log(`  Processing: ${row.title.slice(0, 60)}`);

        // 1. SEO Analysis
        const seoData = await runSeoAnalysis(row.targetUrl, row.title);
        await saveUnifiedSeoData(row, seoData);
        console.log(`    Priority: ${seoData.priority}`);

        // 2. Content Generation
        const content = await runContentAgent({
          url: row.targetUrl,
          title: row.title,
          seoRanking: seoData.seoRanking,
          priority: seoData.priority,
          marketValue: row.marketValue,
        });

        // 3. Save content to sheet columns (TODO: implement in sheets.ts)
        // await updateRowContent(row, content);

        // 4. Post to X
        const xResult = await runXAgent({
          tweetText: content.tweet,
          accountHandle: row.name,
          seoScore: content.seoScore,
          sanityIssues: content.sanityIssues,
        });

        if (xResult.success) {
          await savePostingResult(row, {
            xPost: content.tweet,
            xPostUrl: xResult.tweetUrl || '',
            xStatus: 'Posted',
            xError: '',
            seoScore: content.seoScore.toString(),
            sanityIssues: content.sanityIssues,
          });
          incrementCount('x', row.name);
          posted++;
          state.x.used++;
        } else {
          console.log(`    ❌ X post failed: ${xResult.error}`);
          await savePostingResult(row, {
            xPost: content.tweet,
            xPostUrl: '',
            xStatus: 'Failed',
            xError: xResult.error || 'Unknown error',
          });
        }
      } catch (err: any) {
        console.error(`  Error processing row: ${err.message}`);
      }
    }

    state.x.batchNum++;
    state.x.lastBatchTime = Date.now();

    console.log(`[X BATCH] Completed: ${posted}/${batchUrls.length} posted`);
  } catch (err: any) {
    console.error(`[X BATCH] Error: ${err.message}`);
  }
}

/**
 * Run FB batch
 */
async function runFbBatch(state: CoordinatorState): Promise<void> {
  try {
    console.log(`\n[FB BATCH] Starting batch ${state.facebook.batchNum + 1}...`);

    // Get rows where fbPostUrl is empty, ordered by priority P1 > P2 > P3
    const rowsToPost = await getRowsForFb(15);
    if (rowsToPost.length === 0) {
      console.log('[FB BATCH] No rows ready for FB posting');
      return;
    }

    const result = await runFbBatchAgent({
      rows: rowsToPost,
      batchNum: state.facebook.batchNum + 1,
    });

    // Save results
    for (let i = 0; i < result.results.length; i++) {
      const res = result.results[i];
      if (res.success && rowsToPost[i]) {
        await saveUnifiedFbResult(rowsToPost[i], {
          post: rowsToPost[i].fbPost || '',
          postUrl: res.postUrl || '',
          status: 'Posted',
          error: '',
        });
        incrementCount('facebook', rowsToPost[i].name);
        state.facebook.used++;
      }
    }

    state.facebook.batchNum++;
    state.facebook.lastBatchTime = Date.now();

    console.log(`[FB BATCH] Completed: ${result.posted}/${result.results.length} posted`);
  } catch (err: any) {
    console.error(`[FB BATCH] Error: ${err.message}`);
  }
}

/**
 * Run LI batch
 */
async function runLiBatch(state: CoordinatorState): Promise<void> {
  try {
    console.log(`\n[LI BATCH] Starting batch ${state.linkedin.batchNum + 1}...`);

    const rowsToPost = await getRowsForLi(15);
    if (rowsToPost.length === 0) {
      console.log('[LI BATCH] No rows ready for LI posting');
      return;
    }

    const result = await runLiBatchAgent({
      rows: rowsToPost,
      batchNum: state.linkedin.batchNum + 1,
    });

    // Save results
    for (let i = 0; i < result.results.length; i++) {
      const res = result.results[i];
      if (res.success && rowsToPost[i]) {
        await saveUnifiedLinkedInResult(rowsToPost[i], {
          post: rowsToPost[i].liPost || '',
          postUrl: res.postUrl || '',
          status: 'Posted',
          error: '',
        });
        incrementCount('linkedin', rowsToPost[i].name);
        state.linkedin.used++;
      }
    }

    state.linkedin.batchNum++;
    state.linkedin.lastBatchTime = Date.now();

    console.log(`[LI BATCH] Completed: ${result.posted}/${result.results.length} posted`);
  } catch (err: any) {
    console.error(`[LI BATCH] Error: ${err.message}`);
  }
}

/**
 * Get rows for FB posting (continuous picking - Feature 1)
 * Picks rows sequentially: 1-15, then 16-30, etc. No daily reset.
 */
async function getRowsForFb(limit: number): Promise<SheetRow[]> {
  const batchState = getBatchState();
  const today = new Date().toISOString().split('T')[0];

  // Reset nextRowIndex if it's a new day
  if (batchState.facebook.lastRunDate !== today) {
    // Don't reset - continue from where we left off
    // This enables week-long continuous posting
  }

  const rows = await getRowsWithoutFbUrl(batchState.facebook.nextRowIndex, limit);

  // Update next row index for next batch
  if (rows.length > 0) {
    batchState.facebook.nextRowIndex += rows.length;
    batchState.facebook.lastRunDate = today;
    saveBatchState(batchState);
    console.log(`   📍 FB: Next batch will start at row ${batchState.facebook.nextRowIndex}`);
  }

  return rows;
}

/**
 * Get rows for LI posting (continuous picking - Feature 1)
 * Picks rows sequentially: 1-15, then 16-30, etc. No daily reset.
 */
async function getRowsForLi(limit: number): Promise<SheetRow[]> {
  const batchState = getBatchState();
  const today = new Date().toISOString().split('T')[0];

  // Reset nextRowIndex if it's a new day
  if (batchState.linkedin.lastRunDate !== today) {
    // Don't reset - continue from where we left off
    // This enables week-long continuous posting
  }

  const rows = await getRowsWithoutLiUrl(batchState.linkedin.nextRowIndex, limit);

  // Update next row index for next batch
  if (rows.length > 0) {
    batchState.linkedin.nextRowIndex += rows.length;
    batchState.linkedin.lastRunDate = today;
    saveBatchState(batchState);
    console.log(`   📍 LI: Next batch will start at row ${batchState.linkedin.nextRowIndex}`);
  }

  return rows;
}

/**
 * Weekly SERP Re-check (Feature 2)
 * Runs Saturday 10 PM IST
 * Re-checks URLs > 7 days old and regenerates content if priority changed
 */
export async function runWeeklySerpRecheck(): Promise<void> {
  try {
    console.log('\n📊 [WEEKLY RECHECK] Starting SERP re-check for old URLs...\n');

    const today = new Date();
    const todayIso = today.toISOString().split('T')[0];

    // Step 1: Get URLs due for re-check (> 7 days old)
    const urlsToRecheck = await getUrlsDueForRecheck();

    if (urlsToRecheck.length === 0) {
      console.log('✅ No URLs due for re-check today\n');
      return;
    }

    console.log(`📊 Found ${urlsToRecheck.length} URLs due for re-check\n`);

    let recheckCount = 0;
    let priorityChangedCount = 0;

    // Step 2: For each URL, re-run SEO analysis
    for (const row of urlsToRecheck) {
      try {
        console.log(`\n🔄 Re-checking: ${row.targetUrl.substring(0, 60)}...`);

        // Re-run SEO analysis
        const newSeoResult = await runSeoAnalysis({
          url: row.targetUrl,
          title: row.title,
        });

        // Get old priority
        const oldPriority = row.seoRanking || 'Unknown';

        // Check if priority changed
        const priorityChanged = oldPriority !== newSeoResult.priority;

        if (priorityChanged) {
          console.log(`   📈 Priority changed: ${oldPriority} → ${newSeoResult.priority}`);
          priorityChangedCount++;

          // Regenerate content with new priority
          console.log(`   📝 Regenerating content...`);
          const newContent = await runContentAgent({
            url: row.targetUrl,
            title: row.title,
            seoRanking: newSeoResult.seoRanking,
            priority: newSeoResult.priority,
          });

          // Save re-check with new content
          await saveWeeklySerpRecheck(row, newSeoResult, newContent);
          console.log(`   ✅ Content regenerated and saved`);
        } else {
          console.log(`   ✅ Priority unchanged: ${oldPriority}`);
          // Save re-check without new content
          await saveWeeklySerpRecheck(row, newSeoResult);
        }

        recheckCount++;
      } catch (err: any) {
        console.error(`   ❌ Error re-checking row ${row.rowIndex}: ${err.message}`);
      }
    }

    console.log(`\n✅ [WEEKLY RECHECK] Completed`);
    console.log(`   Re-checked: ${recheckCount}/${urlsToRecheck.length}`);
    console.log(`   Priority changed: ${priorityChangedCount}\n`);
  } catch (err: any) {
    console.error(`❌ [WEEKLY RECHECK] Error: ${err.message}\n`);
  }
}
