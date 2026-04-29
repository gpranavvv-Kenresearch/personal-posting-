/**
 * scheduler-new.ts — Static Cron Scheduler (Asia/Kolkata)
 *
 * Rules:
 *   1. ALL batches fire between 11:00 and 18:00 IST — hard limit, no exceptions.
 *   2. LinkedIn (LI), LinkedIn Pulse, and Medium each get a 20-minute exclusive
 *      window: no other batch is scheduled to start during those 20 minutes.
 *   3. Batch counts unchanged: X×9, FB×5, LI×3, GS×2, HackMD×2, Linkmate×2,
 *      Guffiz×2, Calisthenics×2, Substack×1, Dev.to×1, LI Pulse×1, Medium×1.
 *
 * Full timeline (IST):
 *
 *   11:00 → X-1, FB-1, GS-1
 *   11:15 → HackMD-1
 *   11:20 → LI-1         ← PROTECTED window: nothing 11:20–11:40
 *   11:40 → X-2, Linkmate-1
 *   11:55 → Guffiz-1
 *   12:10 → FB-2, Calisthenics-1
 *   12:25 → Substack-1
 *   12:40 → Dev.to-1
 *   12:55 → LI Pulse-1   ← PROTECTED window: nothing 12:55–13:15
 *   13:15 → X-3, FB-3
 *   13:30 → LI-2         ← PROTECTED window: nothing 13:30–13:50
 *   13:50 → X-4, GS-2
 *   14:05 → HackMD-2
 *   14:15 → Medium-1     ← PROTECTED window: nothing 14:15–14:35
 *   14:35 → X-5, Linkmate-2
 *   14:50 → Guffiz-2, FB-4
 *   15:05 → Calisthenics-2
 *   15:15 → LI-3         ← PROTECTED window: nothing 15:15–15:35
 *   15:35 → X-6, FB-5
 *   15:50 → X-7
 *   16:10 → X-8
 *   16:30 → X-9          ← last batch (90 min before 18:00 hard limit)
 */

import cron from 'node-cron';
import {
  runXBatch, runFbBatch, runLiBatch,
  runMediumBatch, runLinkmateBatch, runGoogleSiteBatch,
  runDevtoBatch, runLinkedinPulseBatch, runCalisthenicsNBatch,
  runSubstackBatch, runGuffizBatch, runHackmdBatch,
  runWeeklySerpRecheck, runSundayExamination, resetBatchCounters,
} from './coordinator/masterCoordinator.js';
import { runMonitorCycle } from './monitor.js';

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

export async function startCoordinatorDaemon(): Promise<void> {
  const tz = 'Asia/Kolkata';

  // ── 11:00 — X-1, FB-1, GS-1 ───────────────────────────────────────────────
  cron.schedule('0 11 * * *',  wrap('X Batch 1',           () => runXBatch(1)),          { timezone: tz });
  cron.schedule('0 11 * * *',  wrap('FB Batch 1',          () => runFbBatch(1)),         { timezone: tz });
  cron.schedule('0 11 * * *',  wrap('Google Sites Batch 1',() => runGoogleSiteBatch(1)), { timezone: tz });

  // ── 11:15 — HackMD-1 ──────────────────────────────────────────────────────
  cron.schedule('15 11 * * *', wrap('HackMD Batch 1',      () => runHackmdBatch(1)),     { timezone: tz });

  // ── 11:20 — LI-1  [PROTECTED 11:20–11:40] ─────────────────────────────────
  cron.schedule('20 11 * * *', wrap('LI Batch 1',          () => runLiBatch(undefined, 1)), { timezone: tz });

  // ── 11:40 — X-2, Linkmate-1  (first slot after LI-1 window) ──────────────
  cron.schedule('40 11 * * *', wrap('X Batch 2',           () => runXBatch(2)),          { timezone: tz });
  cron.schedule('40 11 * * *', wrap('Linkmate Batch 1',    () => runLinkmateBatch(1)),   { timezone: tz });

  // ── 11:55 — Guffiz-1 ──────────────────────────────────────────────────────
  cron.schedule('55 11 * * *', wrap('Guffiz Batch 1',      () => runGuffizBatch(1)),     { timezone: tz });

  // ── 12:10 — FB-2, Calisthenics-1 ──────────────────────────────────────────
  cron.schedule('10 12 * * *', wrap('FB Batch 2',          () => runFbBatch(2)),         { timezone: tz });
  cron.schedule('10 12 * * *', wrap('Calisthenics Batch 1',() => runCalisthenicsNBatch(1)), { timezone: tz });

  // ── 12:25 — Substack-1 ────────────────────────────────────────────────────
  cron.schedule('25 12 * * *', wrap('Substack Batch',      () => runSubstackBatch(1)),   { timezone: tz });

  // ── 12:40 — Dev.to-1 ──────────────────────────────────────────────────────
  cron.schedule('40 12 * * *', wrap('Dev.to Batch',        () => runDevtoBatch(1)),      { timezone: tz });

  // ── 12:55 — LI Pulse-1  [PROTECTED 12:55–13:15] ───────────────────────────
  cron.schedule('55 12 * * *', wrap('LinkedIn Pulse Batch',() => runLinkedinPulseBatch(1)), { timezone: tz });

  // ── 13:15 — X-3, FB-3  (first slot after LI Pulse window) ────────────────
  cron.schedule('15 13 * * *', wrap('X Batch 3',           () => runXBatch(3)),          { timezone: tz });
  cron.schedule('15 13 * * *', wrap('FB Batch 3',          () => runFbBatch(3)),         { timezone: tz });

  // ── 13:30 — LI-2  [PROTECTED 13:30–13:50] ─────────────────────────────────
  cron.schedule('30 13 * * *', wrap('LI Batch 2',          () => runLiBatch(undefined, 2)), { timezone: tz });

  // ── 13:50 — X-4, GS-2  (first slot after LI-2 window) ────────────────────
  cron.schedule('50 13 * * *', wrap('X Batch 4',           () => runXBatch(4)),          { timezone: tz });
  cron.schedule('50 13 * * *', wrap('Google Sites Batch 2',() => runGoogleSiteBatch(2)), { timezone: tz });

  // ── 14:05 — HackMD-2 ──────────────────────────────────────────────────────
  cron.schedule('5 14 * * *',  wrap('HackMD Batch 2',      () => runHackmdBatch(2)),     { timezone: tz });

  // ── 14:15 — Medium-1  [PROTECTED 14:15–14:35] ─────────────────────────────
  cron.schedule('15 14 * * *', wrap('Medium Batch',        () => runMediumBatch(1)),     { timezone: tz });

  // ── 14:35 — X-5, Linkmate-2  (first slot after Medium window) ────────────
  cron.schedule('35 14 * * *', wrap('X Batch 5',           () => runXBatch(5)),          { timezone: tz });
  cron.schedule('35 14 * * *', wrap('Linkmate Batch 2',    () => runLinkmateBatch(2)),   { timezone: tz });

  // ── 14:50 — Guffiz-2, FB-4 ────────────────────────────────────────────────
  cron.schedule('50 14 * * *', wrap('Guffiz Batch 2',      () => runGuffizBatch(2)),     { timezone: tz });
  cron.schedule('50 14 * * *', wrap('FB Batch 4',          () => runFbBatch(4)),         { timezone: tz });

  // ── 15:05 — Calisthenics-2 ────────────────────────────────────────────────
  cron.schedule('5 15 * * *',  wrap('Calisthenics Batch 2',() => runCalisthenicsNBatch(2)), { timezone: tz });

  // ── 15:15 — LI-3  [PROTECTED 15:15–15:35] ─────────────────────────────────
  cron.schedule('15 15 * * *', wrap('LI Batch 3',          () => runLiBatch(undefined, 3)), { timezone: tz });

  // ── 15:35 — X-6, FB-5  (first slot after LI-3 window) ────────────────────
  cron.schedule('35 15 * * *', wrap('X Batch 6',           () => runXBatch(6)),          { timezone: tz });
  cron.schedule('35 15 * * *', wrap('FB Batch 5',          () => runFbBatch(5)),         { timezone: tz });

  // ── 15:50 — X-7 ───────────────────────────────────────────────────────────
  cron.schedule('50 15 * * *', wrap('X Batch 7',           () => runXBatch(7)),          { timezone: tz });

  // ── 16:10 — X-8 ───────────────────────────────────────────────────────────
  cron.schedule('10 16 * * *', wrap('X Batch 8',           () => runXBatch(8)),          { timezone: tz });

  // ── 16:30 — X-9  (last batch — 90 min before 18:00 hard limit) ────────────
  cron.schedule('30 16 * * *', wrap('X Batch 9',           () => runXBatch(9)),          { timezone: tz });

  // ── Error monitor: every 3 minutes ───────────────────────────────────────────
  cron.schedule('*/3 * * * *', async () => {
    try {
      const result = await runMonitorCycle();
      if (result.newErrors > 0) {
        console.log(`\n[${nowIst()}] Monitor: ${result.newErrors} error(s) — fixed: ${result.autoFixed}, human alerts: ${result.humanAlerts}, unknown: ${result.unknownErrors}`);
        for (const line of result.summary) console.log(`   ${line}`);
      }
    } catch (err: any) {
      console.warn(`[Monitor] cycle failed: ${err.message}`);
    }
  });

  // ── Daily reset at midnight IST ────────────────────────────────────────────
  cron.schedule('0 0 * * *', () => {
    console.log(`\n[${nowIst()}] Midnight — resetting daily batch counters`);
    resetBatchCounters();
  }, { timezone: tz });

  // ── Weekly SERP recheck: Saturday 10 PM IST ────────────────────────────────
  cron.schedule('0 22 * * 6', wrap('Weekly SERP Recheck', runWeeklySerpRecheck), { timezone: tz });

  // ── Sunday Examination: Move failed posts to end of sheet ─────────────────
  cron.schedule('0 10 * * 0', wrap('Sunday Failed Posts Examination', runSundayExamination), { timezone: tz });

  // ── Print schedule ─────────────────────────────────────────────────────────
  console.log('Coordinator Scheduler Started — all times IST, hard limit 11:00–18:00\n');
  console.log('  Time  │ Batches firing');
  console.log('  ──────┼─────────────────────────────────────────────');
  console.log('  11:00 │ X-1, FB-1, Google Sites-1');
  console.log('  11:15 │ HackMD-1');
  console.log('  11:20 │ LI-1  [PROTECTED 20 min — nothing until 11:40]');
  console.log('  11:40 │ X-2, Linkmate-1');
  console.log('  11:55 │ Guffiz-1');
  console.log('  12:10 │ FB-2, Calisthenics-1');
  console.log('  12:25 │ Substack-1');
  console.log('  12:40 │ Dev.to-1');
  console.log('  12:55 │ LI Pulse-1  [PROTECTED 20 min — nothing until 13:15]');
  console.log('  13:15 │ X-3, FB-3');
  console.log('  13:30 │ LI-2  [PROTECTED 20 min — nothing until 13:50]');
  console.log('  13:50 │ X-4, Google Sites-2');
  console.log('  14:05 │ HackMD-2');
  console.log('  14:15 │ Medium-1  [PROTECTED 20 min — nothing until 14:35]');
  console.log('  14:35 │ X-5, Linkmate-2');
  console.log('  14:50 │ Guffiz-2, FB-4');
  console.log('  15:05 │ Calisthenics-2');
  console.log('  15:15 │ LI-3  [PROTECTED 20 min — nothing until 15:35]');
  console.log('  15:35 │ X-6, FB-5');
  console.log('  15:50 │ X-7');
  console.log('  16:10 │ X-8');
  console.log('  16:30 │ X-9  (last batch)');
  console.log('  ──────┼─────────────────────────────────────────────');
  console.log('  Posts │ X:135  FB:75  LI:45  GS:30  HackMD:30');
  console.log('        │ Linkmate:30  Guffiz:30  Calisthenics:30');
  console.log('        │ Substack:15  Dev.to:15  LI Pulse:15  Medium:15');
  console.log('        │ Total: ~465 posts/day\n');

  const istHour = parseInt(new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false,
  }));
  if (istHour >= 11 && istHour < 18) {
    console.log(`Now: ${nowIst()} — posting window OPEN`);
  } else {
    console.log(`Now: ${nowIst()} — posting window CLOSED (opens 11:00 IST)`);
  }
}

export async function runCoordinatorOnce(): Promise<void> {
  console.log('Running all batches once...\n');
  await runXBatch();
  await runFbBatch();
  await runLiBatch();
  console.log('\nDone.');
}
