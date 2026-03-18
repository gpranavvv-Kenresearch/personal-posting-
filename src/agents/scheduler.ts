/**
 * scheduler.ts — The Agentic Scheduler
 * Replaces all 12 n8n IF nodes + SplitInBatches + Wait logic
 *
 * Every 5 minutes:
 *   1. Check if current IST time matches a batch slot
 *   2. If yes → fetch that batch's rows from Google Sheet
 *   3. For each row → generate tweet → login → post → write result back
 *   4. 8-second delay between each account (matches n8n Wait node)
 */

import { getCurrentBatch, printSchedule, BATCH_SCHEDULE } from '../config/schedule.js';
import { getTodaysBatchRows, savePostingResult, SheetRow } from '../sheets/sheets.js';
import { createBatchContext, BatchContext } from './sanityAgent.js';
import { moveLeftoversToQueue } from './leftoverPriorityAgent.js';
import { getAccountByHandle } from '../config/accounts.js';
import { supervisedRun } from './supervisor.js';
import { runDistributionAgent } from './distributionAgent.js';
import { runDailyPlannerAgent } from './dailyPlannerAgent.js';
import type { Platform } from './seoAgent.js';

const DELAY_BETWEEN_ACCOUNTS_MS = 8000; // matches n8n Wait node (8s)

// Lock — prevents a new cron from opening browsers while a batch is still running
let isProcessing = false;

// ── Process one row: generate + login + post + write back ─────────────────

async function processRow(row: SheetRow, batchCtx?: BatchContext, forcePlatforms?: Platform[]): Promise<void> {
  console.log(`\n  📌 Row ${row.rowIndex}: @${row.name} → ${row.title || row.targetUrl}`);

  // 1. Look up account credentials
  console.log(`   👤 Sheet name: "${row.name}" → looking up in .accounts/accounts.json...`);
  const account = getAccountByHandle(row.name);
  if (!account) {
    console.log(`   ⚠️  No credentials found for "${row.name}" — skipping`);
    await savePostingResult(row, {
      xPostUrl: '',
      xStatus: 'Failed',
      xError: `Account "${row.name}" not configured in .accounts/accounts.json`,
    });
    return;
  }
  console.log(`   🔑 Credentials found → @${account.handle} | session: ${account.sessionDir}`);

  if (!account.active) {
    console.log(`   ⏸️  Account @${account.handle} is disabled — skipping`);
    return;
  }

  // 2. Delegate to supervisor — it runs SEO analysis, dispatches to all platforms, saves results
  await supervisedRun(row, account, batchCtx ?? createBatchContext(), forcePlatforms);
}

// ── Run the current batch ──────────────────────────────────────────────────

export async function runScheduledBatch(firedToday: Set<number> = new Set()): Promise<{
  batch: number | null;
  processed: number;
  skipped: boolean;
}> {
  const batch = getCurrentBatch(firedToday);

  if (batch === null) {
    return { batch: null, processed: 0, skipped: true };
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`🕐 BATCH ${batch} — Starting posting cycle`);
  console.log('='.repeat(50));

  // Fetch today's rows for this batch
  const rows = await getTodaysBatchRows(batch);

  if (rows.length === 0) {
    console.log(`   No rows found for batch ${batch} today.`);
    return { batch, processed: 0, skipped: false };
  }

  console.log(`   Processing ${rows.length} accounts sequentially (1 browser at a time)...\n`);

  const batchCtx = createBatchContext();
  let processed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`  [${i + 1}/${rows.length}] @${row.name} — row ${row.rowIndex}`);
    console.log(`${'─'.repeat(40)}`);

    await processRow(row, batchCtx);
    processed++;

    // Delay between accounts (skip after last one)
    if (i < rows.length - 1) {
      console.log(`\n   ⏳ Waiting ${DELAY_BETWEEN_ACCOUNTS_MS / 1000}s before next account...`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_ACCOUNTS_MS));
    }
  }

  console.log(`\n✅ Batch ${batch} complete. Processed ${processed}/${rows.length} rows.`);
  return { batch, processed, skipped: false };
}

// ── Run X flow for a specific account + batch (manual trigger) ───────────

export async function runXFlowForAccount(nickname: string, batch: number): Promise<void> {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🎯 X Flow — @${nickname} | Batch ${batch}`);
  console.log('='.repeat(50));

  // Resolve account by nickname or handle
  const account = getAccountByHandle(nickname);
  if (!account) {
    throw new Error(`Account "${nickname}" not found. Check .accounts/accounts.json`);
  }

  // Fetch today's rows for this batch, then filter to this account
  const rows = await getTodaysBatchRows(batch);
  const row = rows.find(r =>
    r.name.toLowerCase() === nickname.toLowerCase() ||
    r.name.toLowerCase() === account.handle.toLowerCase()
  );

  if (!row) {
    console.log(`   ⚠️  No row found for @${nickname} in batch ${batch} today.`);
    console.log(`   Rows in batch ${batch}: ${rows.map(r => r.name).join(', ') || 'none'}`);
    return;
  }

  console.log(`   Found row ${row.rowIndex}: ${row.title || row.targetUrl}`);
  await processRow(row);
  console.log(`\n✅ X flow complete for @${nickname} batch ${batch}.`);
}

// ── Run a specific batch by number (manual trigger, ignores schedule time) ─
// platform: 'x' | 'fb' | 'linkedin' | undefined (all)

export async function runBatchNow(batchNum: number, platform?: string): Promise<void> {
  const platformLabel = platform ? ` [${platform.toUpperCase()}]` : ' [ALL]';
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🎯 Manual Run — Batch ${batchNum}${platformLabel}`);
  console.log('='.repeat(50));

  const forcePlatforms = resolveForcePlatforms(platform);

  const rows = await getTodaysBatchRows(batchNum);

  if (rows.length === 0) {
    console.log(`   No rows found for batch ${batchNum} today.`);
    return;
  }

  console.log(`   Processing ${rows.length} accounts...\n`);

  for (let i = 0; i < rows.length; i++) {
    await processRow(rows[i], undefined, forcePlatforms);
    if (i < rows.length - 1) {
      console.log(`   ⏳ Waiting ${DELAY_BETWEEN_ACCOUNTS_MS / 1000}s before next account...`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_ACCOUNTS_MS));
    }
  }

  console.log(`\n✅ Batch ${batchNum}${platformLabel} complete. Processed ${rows.length} rows.`);
}

// ── Map CLI platform alias → Platform[] ───────────────────────────────────

function resolveForcePlatforms(platform?: string): Platform[] | undefined {
  if (!platform) return undefined;
  const p = platform.toLowerCase();
  if (p === 'x' || p === 'twitter')    return ['x'];
  if (p === 'fb' || p === 'facebook')  return ['facebook'];
  if (p === 'li' || p === 'linkedin')  return ['linkedin'];
  if (p === 'all')                     return undefined;
  console.warn(`   ⚠️  Unknown platform "${platform}" — running all platforms`);
  return undefined;
}

// ── Dynamic batch schedule (set at 10:30 AM, cleared at midnight) ─────────
// Maps batchNum → UTC Date when it should fire today
let dynamicXSchedule: Map<number, Date> = new Map();
let firedXBatches: Set<number> = new Set();

/**
 * Given the batch numbers actually assigned by distributionAgent,
 * spread them evenly between 11:00 AM and 6:00 PM IST.
 *
 * Min gap = accountsPerBatch × 3 min (time for all 15 accounts to finish)
 * so that the next batch never starts before the current one completes.
 */
function calculateDynamicSchedule(batchNums: number[], accountsPerBatch = 15): Map<number, Date> {
  const schedule = new Map<number, Date>();
  if (batchNums.length === 0) return schedule;

  // Window: 11:00 AM → 5:30 PM IST = 390 minutes
  const START_MINUTES = 11 * 60;
  const END_MINUTES   = 17 * 60 + 30;
  const TOTAL_MINUTES = END_MINUTES - START_MINUTES;

  // Each account needs ~3 min (login + generate + post + 8s delay)
  // Add 5 min buffer so next batch starts fresh
  const MIN_GAP = Math.max(accountsPerBatch * 3 + 5, 30);

  // How many batches actually fit in the window?
  const maxBatchesThatFit = Math.floor(TOTAL_MINUTES / MIN_GAP) + 1;
  const sorted = [...batchNums].sort((a, b) => a - b).slice(0, maxBatchesThatFit);

  if (batchNums.length > maxBatchesThatFit) {
    console.warn(`   ⚠️  ${batchNums.length} row batches assigned but only ${maxBatchesThatFit} fit in 11:00–17:30 window. Scheduling first ${maxBatchesThatFit} only.`);
  }

  const n = sorted.length;
  const gap = n > 1
    ? Math.max(MIN_GAP, Math.floor(TOTAL_MINUTES / (n - 1)))
    : 0;

  // Build today's date at 11:00 AM IST, converted to UTC
  const nowUTC = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(nowUTC.getTime() + istOffsetMs + nowUTC.getTimezoneOffset() * 60 * 1000);

  // Start of window in IST
  const istStart = new Date(istNow);
  istStart.setHours(11, 0, 0, 0);

  console.log(`\n📅 Daily schedule (${sorted.length} row batches, ${gap} min apart, 11:00–17:30 IST):`);
  console.log(`   Each batch schedules rows for X accounts.`);
  console.log(`   Facebook / LinkedIn may also post for a subset of those rows if SEO selects them.`);
  for (let i = 0; i < sorted.length; i++) {
    const minutesFromStart = i * gap;
    const istFireTime = new Date(istStart.getTime() + minutesFromStart * 60 * 1000);

    // Convert IST fire time back to UTC for JS Date comparison
    const utcFireTime = new Date(istFireTime.getTime() - istOffsetMs - nowUTC.getTimezoneOffset() * 60 * 1000);
    schedule.set(sorted[i], utcFireTime);

    const h = istFireTime.getHours();
    const m = istFireTime.getMinutes();
    console.log(`  Batch ${String(sorted[i]).padStart(2, ' ')} → ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST  [row batch]`);
  }

  return schedule;
}

// ── Main daemon loop ───────────────────────────────────────────────────────

export async function startSchedulerDaemon(): Promise<void> {
  const cron = (await import('node-cron')).default;

  console.log('🤖 Social Posting Scheduler Started');
  console.log('⚡ Row batch times are calculated dynamically after 10:30 AM distribution.\n');

  // ── 10:30 AM IST — planner → distribution → dynamic schedule ─────────
  cron.schedule('30 10 * * *', async () => {
    if (isProcessing) {
      console.log('\n[PLANNER] Skipped — batch still running');
      return;
    }
    console.log(`\n[${new Date().toISOString()}] 🧠 Daily planner + distribution (10:30 IST)`);
    try {
      // Step 1: AI decides today's targets per platform
      const plan = await runDailyPlannerAgent();

      // Step 2: Distribute using AI targets (only X runs today, FB/LI assigned but not fired)
      const result = await runDistributionAgent({
        x:        plan.x,
        facebook: plan.facebook,
        linkedin: plan.linkedin,
      });

      // Step 3: Build dynamic X schedule — pass account count so gap is correct
      const xAccountCount = result.x > 0 && result.xBatchesUsed.length > 0
        ? Math.ceil(result.x / result.xBatchesUsed.length)
        : 15;
      dynamicXSchedule = calculateDynamicSchedule(result.xBatchesUsed, xAccountCount);
      firedXBatches.clear();

      console.log(`\n✅ Plan complete — ${plan.x} rows selected for processing today`);
      console.log(`   Dynamic row schedule: ${dynamicXSchedule.size} batch slots queued`);
    } catch (err: any) {
      console.error(`[PLANNER] Error: ${err.message}`);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('  [DISTRIBUTE]  Auto-distribute  → 10:30 IST');

  // ── 10:45 AM IST — leftover requeue ───────────────────────────────────
  cron.schedule('45 10 * * *', async () => {
    if (isProcessing) {
      console.log('\n[LEFTOVER] Skipped — batch still running');
      return;
    }
    console.log(`\n[${new Date().toISOString()}] ♻️  Leftover requeue (10:45 IST)`);
    try {
      await processLeftovers();
    } catch (err: any) {
      console.error(`[LEFTOVER] Error: ${err.message}`);
    }
  }, { timezone: 'Asia/Kolkata' });
  console.log('  [LEFTOVER]    Daily requeue    → 10:45 IST');

  // ── Midnight IST — reset fired batches for the new day ────────────────
  cron.schedule('0 0 * * *', () => {
    dynamicXSchedule.clear();
    firedXBatches.clear();
    console.log(`\n[${new Date().toISOString()}] 🔄 Midnight reset — schedule cleared for new day`);
  }, { timezone: 'Asia/Kolkata' });
  console.log('  [RESET]       Daily reset      → 00:00 IST');

  // ── Every minute — check if any X batch should fire now ───────────────
  cron.schedule('* * * * *', async () => {
    if (dynamicXSchedule.size === 0) return;   // no schedule yet
    if (isProcessing) return;                   // previous batch still running

    const now = new Date();

    for (const [batchNum, fireAt] of dynamicXSchedule) {
      if (firedXBatches.has(batchNum)) continue;

      const diffMs = now.getTime() - fireAt.getTime();
      // Fire if within a 90-second window (handles slight tick delay)
      if (diffMs >= 0 && diffMs < 90_000) {
        firedXBatches.add(batchNum);
        isProcessing = true;
        console.log(`\n[${new Date().toISOString()}] ⏰ Batch ${batchNum} firing now`);
        try {
          await runBatchNow(batchNum);
          console.log(`[BATCH] Batch ${batchNum} → done`);
        } catch (err: any) {
          console.error(`[BATCH] Batch ${batchNum} error: ${err.message}`);
        } finally {
          isProcessing = false;
        }
        break; // only one batch per minute tick
      }
    }
  });
  console.log('  [TICKER]      Batch fire check → every minute');

  // ── Startup catch-up: if daemon started after 10:30 AM, run immediately ──
  // The 10:30 cron already passed today — dynamicXSchedule is empty.
  // Detect this by checking current IST time.
  const nowUTC = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(nowUTC.getTime() + istOffsetMs + nowUTC.getTimezoneOffset() * 60 * 1000);
  const istMinutes = istNow.getHours() * 60 + istNow.getMinutes();
  const DISTRIBUTION_MINUTE = 10 * 60 + 30; // 10:30 AM
  const MIDNIGHT_MINUTE = 0;

  if (istMinutes >= DISTRIBUTION_MINUTE) {
    console.log(`\n⚡ Daemon started after 10:30 AM IST (now ${istNow.getHours()}:${String(istNow.getMinutes()).padStart(2,'0')} IST)`);
    console.log('   Running distribution immediately to catch up...\n');
    try {
      const plan = await runDailyPlannerAgent();
      const result = await runDistributionAgent({
        x:        plan.x,
        facebook: plan.facebook,
        linkedin: plan.linkedin,
      });
      const xAccountCount = result.x > 0 && result.xBatchesUsed.length > 0
        ? Math.ceil(result.x / result.xBatchesUsed.length)
        : 15;
      dynamicXSchedule = calculateDynamicSchedule(result.xBatchesUsed, xAccountCount);
      firedXBatches.clear();
      console.log(`\n✅ Catch-up complete — ${dynamicXSchedule.size} row batches scheduled from now.\n`);
    } catch (err: any) {
      console.error(`[STARTUP] Distribution failed: ${err.message}`);
    }
  } else {
    console.log(`\n⏳ Waiting for 10:30 AM IST to run distribution (now ${istNow.getHours()}:${String(istNow.getMinutes()).padStart(2,'0')} IST)...\n`);
  }
}

// ── Move leftover rows to end of sheet (no posting) ──────────────────────

export async function processLeftovers(): Promise<void> {
  console.log('\n' + '='.repeat(50));
  console.log('♻️  LEFTOVER MODE — Requeueing unposted rows');
  console.log('='.repeat(50));

  const result = await moveLeftoversToQueue();

  if (result.moved === 0) {
    console.log('\n✅ No leftover rows found. All caught up!');
  } else {
    console.log(`\n✅ Leftover requeue complete. Moved ${result.moved} rows to end of sheet.`);
    console.log('   ℹ️  Fill in name/batch/date on new rows for scheduler to pick them up.');
  }
}
