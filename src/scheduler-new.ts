/**
 * scheduler-new.ts — New Coordinator-Based Scheduler
 *
 * Replaces old scheduler.ts
 * Uses cron to trigger Master Coordinator every 30 minutes
 */

import cron from 'node-cron';
import { runMasterCoordinator, runWeeklySerpRecheck } from './coordinator/masterCoordinator.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toIstDate(utc: Date): Date {
  const nowUTC = new Date();
  return new Date(utc.getTime() + IST_OFFSET_MS + nowUTC.getTimezoneOffset() * 60 * 1000);
}

function fmtIst(utc: Date): string {
  const ist = toIstDate(utc);
  const h = ist.getHours();
  const m = ist.getMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

/**
 * Start the new coordinator-based scheduler daemon
 */
export async function startCoordinatorDaemon(): Promise<void> {
  console.log('🤖 Coordinator-Based Scheduler Started');
  console.log('⚡ Coordinator runs every 30 minutes during 11 AM - 6 PM IST window\n');

  // ── Every 30 minutes — check if any batch should run ───────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      console.log(`\n[${fmtIst(new Date())}] Running coordinator check...`);
      await runMasterCoordinator();
    } catch (err: any) {
      console.error(`[COORDINATOR] Error: ${err.message}`);
    }
  });

  // ── Midnight IST — reset daily counters ─────────────────────────────────────
  cron.schedule('0 0 * * *', () => {
    console.log(`\n[${fmtIst(new Date())}] 🔄 Midnight reset — resetting daily counters`);
    // Counter reset is handled by masterCoordinator on date change
  }, { timezone: 'Asia/Kolkata' });

  // ── Saturday 10 PM IST — weekly SERP re-check for old URLs ──────────────────
  cron.schedule('0 22 * * 6', async () => {
    try {
      console.log(`\n[${fmtIst(new Date())}] 📊 Weekly SERP re-check — checking URLs > 7 days old`);
      await runWeeklySerpRecheck();
    } catch (err: any) {
      console.error(`[WEEKLY RECHECK] Error: ${err.message}`);
    }
  }, { timezone: 'Asia/Kolkata' });

  console.log('  [COORDINATOR]   Check  → every 30 minutes (11 AM - 6 PM IST)');
  console.log('  [RESET]         Daily  → 00:00 IST');
  console.log('  [WEEKLY RECHECK] Sat   → 22:00 IST (10 PM)\n');

  // ── Startup message
  const nowUTC = new Date();
  const istNow = toIstDate(nowUTC);
  const istMinutes = istNow.getHours() * 60 + istNow.getMinutes();

  if (istMinutes >= 11 * 60 && istMinutes < 18 * 60) {
    console.log(`⚡ Daemon started during posting window (${fmtIst(nowUTC)})`);
    console.log('   Next coordinator check in up to 30 minutes\n');
  } else {
    const nextWindow = istNow.getHours() < 11
      ? `${11 - istNow.getHours()} hours`
      : `${24 - istNow.getHours() + 11} hours`;
    console.log(`⏳ Waiting for 11 AM IST window (${nextWindow})...\n`);
  }
}

/**
 * For CLI mode: run coordinator once
 */
export async function runCoordinatorOnce(): Promise<void> {
  console.log('🔁 Running coordinator once...\n');
  await runMasterCoordinator();
  console.log('\n✅ Done.');
}
