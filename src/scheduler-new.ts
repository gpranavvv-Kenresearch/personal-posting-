/**
 * scheduler-new.ts — Static Cron Scheduler (Asia/Kolkata)
 *
 * Rules:
 *   1. ALL batches fire between 10:30 and 18:00 IST (7.5-hour window).
 *   2. LinkedIn (LI) gets protected windows.
 *   3. All New Logic platforms are permanently assigned to exactly one of 3
 *      shared slot columns ("Blog Platform N"/"Blog URL N") and each runs on
 *      its OWN independent cron trigger — no group orchestration for these:
 *        Slot 1: Linkmate, Blogger, Coda, Medium, Velog
 *        Slot 2: Calisthenics, Notion, LinkedIn Pulse, Google Sites, PdfHost
 *        Slot 3: HackMD, WordPress, Dev.to, 4shared
 *      Whenever a platform's cron fires it independently scans New Logic for
 *      the next row where its own slot is still empty, posts, and writes
 *      there — skipping rows a sibling in the same slot already filled.
 *      Daily run counts: Linkmate/Calisthenics = 3/day each, HackMD/Blogger/
 *      Notion/Dev.to/WordPress/Velog/Google Sites(→3)/4shared = 2/day
 *      each (Google Sites is 3/day), Coda/LinkedIn Pulse/Medium = 1/day each.
 *      Scribd removed from cron (2026-08-27) — headless posting kept hitting
 *      an unsolvable recaptcha and its manual-login fallback blocked the
 *      whole daemon; agent/browser code left in place, just not scheduled.
 *      Group4/Group4b still run (still claim rows + assign "New Name" via
 *      the 25-name roster) but no longer post to Medium/Google Sites
 *      themselves — see the empty GROUP_DEFS platforms lists in
 *      masterCoordinator.ts. Naver and Paragraph are excluded from cron.
 *   4. FB×5, LI×3, X×2 remain independent, unchanged.
 *   5. SBM/PPT-PDF platforms (Pearltrees, PdfHost, Instapaper, Raindrop ×3/day
 *      each; Tumblr ×2/day) run at :05/:35 minute offsets, and the new slot
 *      platforms above run at :10/:20/:25/:40/:50 offsets — both interleaved
 *      with the :00/:15/:30/:45 grid below so nothing collides.
 *   6. Telegraph (×2/day, 11:20 & 13:50) shares the Social Media tab's slot 2
 *      columns with Facebook/Tumblr/Pearltrees (see runTelegraphBatch in
 *      masterCoordinator.ts) — no login/accounts, browser-only, added
 *      2026-09-08.
 *
 * Full timeline (IST) — see the printed schedule at daemon startup for the
 * complete, currently-accurate list; kept brief here to avoid drift.
 */

import cron from 'node-cron';
import { DailySlot, cronExprFor, runSlotOnce, startCatchUpSweeper, startHeartbeat, seedIfOldDaemonRanToday } from './batchLedger.js';
import {
  runXBatch, runFbBatch, runLiBatch,
  runGroupBatch, GROUP_DEFS,
  runLinkmateBatch, runCalisthenicsNBatch, runHackmdBatch,
  runBloggerBatch, runNotionBatch, runDevtoBatch,
  runCodaBatch, runLinkedinPulseBatch, runWordpressBatch,
  runWeeklySerpRecheck, runSundayExamination, resetBatchCounters,
  runDailyPostingSummary,
  runPearltreesBatch, runPdfhostBatch, runInstapaperBatch,
  runRaindropBatch, runTumblrBatch, runTelegraphBatch,
  runMediumBatch, runVelogBatch, runGoogleSiteBatch,
  runFourSharedBatch,
} from './coordinator/masterCoordinator.js';

function runGroup(name: string) {
  const def = GROUP_DEFS[name];
  return () => runGroupBatch(name, def.platforms, def.accountCount, def.batchNum);
}

function nowIst(): string {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }) + ' IST';
}

function wrap(label: string, fn: () => Promise<void>) {
  return async () => {
    console.log(`\n[${nowIst()}] ▶ ${label}`);
    try {
      await fn();
    } catch (err: any) {
      console.error(`[${label}] Error: ${err.message}`);
    }
  };
}

// ── Daily posting slots (IST) ─────────────────────────────────────────────
// One table drives BOTH the node-cron triggers and the missed-slot catch-up
// sweeper (see batchLedger.ts). node-cron silently skips any slot it misses
// (event-loop block, sleep/hibernate, restart) — the sweeper re-runs those
// from this same list, and the ledger guarantees each label runs once/day.
// Grid: :00/:15/:30/:45 = FB/LI/X/New-Logic slots; :05/:35 = SBM/PDF;
// :10/:20 = Medium/Velog/Google Sites/4shared. LI slots are protected windows.
export const DAILY_SLOTS: DailySlot[] = [
  { time: '10:20', label: 'Medium 1/1',            run: () => runMediumBatch(1) },
  { time: '10:30', label: 'FB Batch 1',            run: () => runFbBatch(1) },
  { time: '10:35', label: 'Pearltrees 1/3',        run: () => runPearltreesBatch(1) },
  { time: '10:40', label: 'Velog 1/2',             run: () => runVelogBatch(1) },
  { time: '10:45', label: 'Linkmate 1/2',          run: () => runLinkmateBatch(1) },
  { time: '11:00', label: 'Calisthenics 1/2',      run: () => runCalisthenicsNBatch(1) },
  { time: '11:05', label: 'PdfHost 1/3',           run: () => runPdfhostBatch(1) },
  { time: '11:10', label: 'Google Sites 1/3',      run: () => runGoogleSiteBatch(1) },
  { time: '11:15', label: 'HackMD 1/2',            run: () => runHackmdBatch(1) },
  { time: '11:20', label: 'Telegraph 1/2',         run: () => runTelegraphBatch(1) },
  { time: '11:30', label: 'LI Batch 1',            run: () => runLiBatch(undefined, 1) },
  { time: '11:35', label: 'Instapaper 1/3',        run: () => runInstapaperBatch(1) },
  { time: '11:45', label: 'Blogger 1/2',           run: () => runBloggerBatch(1) },
  { time: '12:00', label: 'FB Batch 2',            run: () => runFbBatch(2) },
  { time: '12:05', label: 'Raindrop 1/3',          run: () => runRaindropBatch(1) },
  { time: '12:10', label: '4shared 1/2',           run: () => runFourSharedBatch(1) },
  { time: '12:15', label: 'X Batch 1',             run: () => runXBatch(1) },
  { time: '12:30', label: 'Notion 1/2',            run: () => runNotionBatch(1) },
  { time: '12:35', label: 'Tumblr 1/2',            run: () => runTumblrBatch(1) },
  { time: '12:45', label: 'Dev.to 1/2',            run: () => runDevtoBatch(1) },
  { time: '13:00', label: 'Coda 1/1',              run: () => runCodaBatch(1) },
  { time: '13:05', label: 'Pearltrees 2/3',        run: () => runPearltreesBatch(2) },
  { time: '13:15', label: 'LinkedIn Pulse 1/1',    run: () => runLinkedinPulseBatch(1) },
  { time: '13:20', label: 'Google Sites 2/3',      run: () => runGoogleSiteBatch(2) },
  { time: '13:30', label: 'WordPress 1/1',         run: () => runWordpressBatch(1) },
  { time: '13:35', label: 'PdfHost 2/3',           run: () => runPdfhostBatch(2) },
  { time: '13:45', label: 'FB Batch 3',            run: () => runFbBatch(3) },
  { time: '13:50', label: 'Telegraph 2/2',         run: () => runTelegraphBatch(2) },
  { time: '14:00', label: 'LI Batch 2',            run: () => runLiBatch(undefined, 2) },
  { time: '14:05', label: 'Instapaper 2/3',        run: () => runInstapaperBatch(2) },
  { time: '14:15', label: 'Linkmate 2/2',          run: () => runLinkmateBatch(2) },
  { time: '14:20', label: 'Velog 2/2',             run: () => runVelogBatch(2) },
  { time: '14:30', label: 'Calisthenics 2/2',      run: () => runCalisthenicsNBatch(2) },
  { time: '14:35', label: 'Raindrop 2/3',          run: () => runRaindropBatch(2) },
  { time: '14:45', label: 'X Batch 2',             run: () => runXBatch(2) },
  { time: '15:00', label: 'HackMD 2/2',            run: () => runHackmdBatch(2) },
  { time: '15:05', label: 'Tumblr 2/2',            run: () => runTumblrBatch(2) },
  { time: '15:15', label: 'Group4',                run: runGroup('Group4') },
  { time: '15:30', label: 'FB Batch 4',            run: () => runFbBatch(4) },
  { time: '15:35', label: 'Pearltrees 3/3',        run: () => runPearltreesBatch(3) },
  { time: '15:45', label: 'Group4b',               run: runGroup('Group4b') },
  { time: '16:00', label: 'Blogger 2/2',           run: () => runBloggerBatch(2) },
  { time: '16:05', label: 'PdfHost 3/3',           run: () => runPdfhostBatch(3) },
  { time: '16:10', label: 'Google Sites 3/3',      run: () => runGoogleSiteBatch(3) },
  { time: '16:15', label: 'Notion 2/2',            run: () => runNotionBatch(2) },
  { time: '16:20', label: '4shared 2/2',           run: () => runFourSharedBatch(2) },
  { time: '16:30', label: 'Dev.to 2/2',            run: () => runDevtoBatch(2) },
  { time: '16:35', label: 'Instapaper 3/3',        run: () => runInstapaperBatch(3) },
  { time: '16:45', label: 'LI Batch 3',            run: () => runLiBatch(undefined, 3) },
  { time: '17:00', label: 'FB Batch 5',            run: () => runFbBatch(5) },
  { time: '17:05', label: 'Raindrop 3/3',          run: () => runRaindropBatch(3) },
  { time: '17:15', label: 'WordPress 2/2',         run: () => runWordpressBatch(2) },
  { time: '17:30', label: 'Calisthenics 3/3',      run: () => runCalisthenicsNBatch(3) },
  { time: '17:45', label: 'Linkmate 3/3',          run: () => runLinkmateBatch(3) },
  { time: '18:20', label: 'Daily Posting Summary', run: runDailyPostingSummary },
];

export async function startCoordinatorDaemon(): Promise<void> {
  const tz = 'Asia/Kolkata';


  for (const slot of DAILY_SLOTS) {
    cron.schedule(cronExprFor(slot.time), () => { runSlotOnce(slot).catch((e: any) => console.error(`[${slot.label}] Error: ${e.message}`)); }, { timezone: tz });
  }

  // Liveness heartbeat (watched by supervisor.ts) + catch-up sweeper for slots
  // missed while the process was blocked, asleep, or not running.
  startHeartbeat();
  seedIfOldDaemonRanToday(DAILY_SLOTS);
  startCatchUpSweeper(DAILY_SLOTS);

  // ── Daily reset at midnight IST ───────────────────────────────────────────
  cron.schedule('0 0 * * *', () => {
    console.log(`\n[${nowIst()}] Midnight — resetting daily batch counters`);
    resetBatchCounters();
  }, { timezone: tz });

  // ── Weekly SERP recheck: Saturday 10 PM IST ───────────────────────────────
  cron.schedule('0 22 * * 6', wrap('Weekly SERP Recheck', runWeeklySerpRecheck), { timezone: tz });

  // ── Sunday Examination: Move failed posts to end of sheet ─────────────────
  cron.schedule('0 10 * * 0', wrap('Sunday Failed Posts Examination', runSundayExamination), { timezone: tz });

  // ── Print schedule ────────────────────────────────────────────────────────
  console.log('Coordinator Scheduler Started — New Logic 3-slot independent posting, 10:30–18:00 IST\n');
  console.log('  Time  │ Batch');
  console.log('  ──────┼─────────────────────────────────────────────────────');
  console.log('  10:30 │ FB-1');
  console.log('  10:45 │ Linkmate        (1/2, slot 1)');
  console.log('  11:00 │ Calisthenics    (1/2, slot 2)');
  console.log('  11:15 │ HackMD          (1/2, slot 3)');
  console.log('  11:30 │ LI-1            [PROTECTED → next at 11:45]');
  console.log('  11:45 │ Blogger         (1/2, slot 1)');
  console.log('  12:00 │ FB-2');
  console.log('  12:15 │ X-1');
  console.log('  12:30 │ Notion          (1/2, slot 2)');
  console.log('  12:45 │ Dev.to          (1/2, slot 3)');
  console.log('  13:00 │ Coda            (1/1, slot 1)');
  console.log('  13:15 │ LinkedIn Pulse  (1/1, slot 2)');
  console.log('  13:30 │ WordPress       (1/1, slot 3)');
  console.log('  13:45 │ FB-3');
  console.log('  14:00 │ LI-2            [PROTECTED → next at 14:15]');
  console.log('  14:15 │ Linkmate        (2/2, slot 1)');
  console.log('  14:30 │ Calisthenics    (2/2, slot 2)');
  console.log('  14:45 │ X-2');
  console.log('  15:00 │ HackMD          (2/2, slot 3)');
  console.log('  15:15 │ Group4 [PROTECTED → next at 15:30] — claims rows/assigns New Name only, no posting');
  console.log('  15:30 │ FB-4');
  console.log('  15:45 │ Group4b — claims rows/assigns New Name only, no posting');
  console.log('  16:00 │ Blogger         (2/2, slot 1)');
  console.log('  16:15 │ Notion          (2/2, slot 2)');
  console.log('  16:30 │ Dev.to          (2/2, slot 3)');
  console.log('  16:45 │ LI-3            [PROTECTED → next at 17:00]');
  console.log('  17:00 │ FB-5');
  console.log('  17:05 │ Raindrop        (3/3)');
  console.log('  17:15 │ WordPress       (2/2, slot 3)');
  console.log('  17:30 │ Calisthenics    (3/3, slot 2)');
  console.log('  17:45 │ Linkmate        (3/3, slot 1)');
  console.log('  18:20 │ Daily Posting Summary (report + Algo Reports!F write)');
  console.log('  ──────┼─────────────────────────────────────────────────────');
  console.log('  New SBM/PPT-PDF platforms (:05/:35 offsets, interleaved with the grid above):');
  console.log('  10:35 Pearltrees 1/3 │ 11:05 PdfHost 1/3 │ 11:20 Telegraph 1/2 │ 11:35 Instapaper 1/3 │ 12:05 Raindrop 1/3 │ 12:35 Tumblr 1/2');
  console.log('  13:05 Pearltrees 2/3 │ 13:35 PdfHost 2/3 │ 13:50 Telegraph 2/2 │ 14:05 Instapaper 2/3 │ 14:35 Raindrop 2/3 │ 15:05 Tumblr 2/2');
  console.log('  15:35 Pearltrees 3/3 │ 16:05 PdfHost 3/3 │ 16:35 Instapaper 3/3 │ 17:05 Raindrop 3/3');
  console.log('  ──────┼─────────────────────────────────────────────────────');
  console.log('  Medium/Velog (slot 1), Google Sites/PdfHost (slot 2), 4shared (slot 3) — :10/:20/:25/:40/:50 offsets:');
  console.log('  10:20 Medium 1/1      │ 10:40 Velog 1/2       │ 11:10 Google Sites 1/3');
  console.log('  12:10 4shared 1/2     │ 13:20 Google Sites 2/3 │ 14:20 Velog 2/2');
  console.log('  16:10 Google Sites 3/3 │ 16:20 4shared 2/2');
  console.log('  ──────┼─────────────────────────────────────────────────────');
  console.log('  Slot 1: Linkmate, Blogger, Coda, Medium, Velog');
  console.log('  Slot 2: Calisthenics, Notion, LinkedIn Pulse, Google Sites, PdfHost');
  console.log('  Slot 3: HackMD, WordPress, Dev.to, 4shared');
  console.log('  Each platform independently claims the next "New Logic" row where its own slot is still empty.\n');

  const now = new Date();
  const istMin = parseInt(now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: 'numeric', hour12: false }).replace(':', '')) || 0;
  // window: 10:30 (1030) → 18:00 (1800)
  if (istMin >= 1030 && istMin <= 1800) {
    console.log(`Now: ${nowIst()} — posting window OPEN`);
  } else {
    console.log(`Now: ${nowIst()} — posting window CLOSED (opens 10:30 IST)`);
  }
}

export async function runCoordinatorOnce(): Promise<void> {
  console.log('Running all batches once...\n');
  await runXBatch();
  await runFbBatch();
  await runLiBatch();
  console.log('\nDone.');
}
