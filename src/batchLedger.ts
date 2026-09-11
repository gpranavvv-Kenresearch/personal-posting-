/**
 * batchLedger.ts — Missed-batch catch-up + liveness heartbeat for the cron daemon.
 *
 * WHY THIS EXISTS
 *   node-cron (v4) does NOT re-run a slot it missed. When the Node event loop is
 *   blocked, the laptop sleeps/hibernates, or the daemon is restarted mid-day,
 *   it just logs "missed execution at <time>! Possible blocking IO..." and moves
 *   on. On 2026-09-04 every slot from 10:20 to 18:20 IST was reported missed in a
 *   single burst at 19:30 IST; on 2026-09-07 the daemon went silent from 15:16
 *   to 17:33 IST and the 16 batches in that window never ran. Each such day
 *   loses most of the ~600 posts.
 *
 * WHAT IT DOES
 *   1. Ledger  — every daily slot records start/end in .sessions/slot-ledger.json
 *                (reset per IST date). A slot that is in the ledger is never
 *                run twice on the same day.
 *   2. Sweeper — every SWEEP_INTERVAL_MS (and once at startup) it looks for
 *                slots whose scheduled time has already passed today but that
 *                have no ledger entry, and runs them one at a time, in
 *                schedule order, until CATCHUP_CUTOFF_IST. So a stall, sleep
 *                or restart only delays batches instead of dropping them.
 *   3. Heartbeat — writes .sessions/heartbeat.json every HEARTBEAT_MS. If the
 *                event loop is blocked the file goes stale; supervisor.ts
 *                watches it and restarts the daemon, which then catches up
 *                via (2).
 *
 * Env overrides:
 *   CATCHUP_CUTOFF_IST=21:00   last time of day a missed slot may still be caught up
 *   CATCHUP_GRACE_MIN=3        how many minutes past the slot time before it counts as missed
 *   CATCHUP_DISABLED=1         turn the sweeper off (ledger + heartbeat still run)
 */

import fs from 'fs';
import path from 'path';

export interface DailySlot {
  /** "HH:MM" in IST, 24h. */
  time: string;
  /** Human label — must be unique per day (e.g. "FB Batch 1", "Linkmate 2/2"). */
  label: string;
  run: () => Promise<void>;
}

interface LedgerEntry {
  status: 'running' | 'done' | 'error';
  startedAt: string;
  endedAt?: string;
  catchUp?: boolean;
  error?: string;
  /** PID of the daemon that ran it — a 'running' entry from another PID means that daemon died mid-batch. */
  pid?: number;
}

interface Ledger {
  date: string;
  slots: Record<string, LedgerEntry>;
}

const LEDGER_FILE = path.resolve('.sessions/slot-ledger.json');
const HEARTBEAT_FILE = path.resolve('.sessions/heartbeat.json');
const HEARTBEAT_MS = 20_000;
const SWEEP_INTERVAL_MS = 60_000;
const STARTUP_SWEEP_DELAY_MS = 15_000;
const TZ = 'Asia/Kolkata';

// ── IST helpers ──────────────────────────────────────────────────────────────

export function todayIst(d = new Date()): string {
  // en-CA gives YYYY-MM-DD
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

export function nowIstMinutes(d = new Date()): number {
  const [h, m] = d
    .toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .split(':')
    .map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** "HH:MM" -> node-cron expression "M H * * *". */
export function cronExprFor(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return `${m} ${h} * * *`;
}

// ── Ledger ───────────────────────────────────────────────────────────────────

function readLedger(): Ledger {
  const today = todayIst();
  try {
    if (fs.existsSync(LEDGER_FILE)) {
      const saved = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) as Ledger;
      if (saved.date === today && saved.slots) return saved;
    }
  } catch { /* corrupt → start fresh */ }
  return { date: today, slots: {} };
}

function writeLedger(l: Ledger): void {
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  fs.writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2));
}

/** True if the slot ran (or is running in THIS process) today. A 'running'
 * entry left behind by a previous daemon PID (killed/crashed mid-batch) does
 * not count — that batch must be picked up again. Batch runners only post to
 * rows that are still unposted, so re-running a half-finished batch is safe. */
export function ledgerHas(label: string): boolean {
  const e = readLedger().slots[label];
  if (!e) return false;
  if (e.status === 'running' && e.pid && e.pid !== process.pid) return false;
  return true;
}

export function ledgerMark(label: string, entry: Partial<LedgerEntry> & { status: LedgerEntry['status'] }): void {
  const l = readLedger();
  const prev = l.slots[label];
  l.slots[label] = {
    ...(prev ?? { startedAt: new Date().toISOString() }),
    ...entry,
  } as LedgerEntry;
  writeLedger(l);
}

/** Snapshot for logging / debugging. */
export function ledgerSummary(): { date: string; done: string[]; running: string[]; error: string[] } {
  const l = readLedger();
  const by = (s: LedgerEntry['status']) => Object.entries(l.slots).filter(([, e]) => e.status === s).map(([k]) => k);
  return { date: l.date, done: by('done'), running: by('running'), error: by('error') };
}

// ── Slot execution (used by the cron trigger AND the sweeper) ────────────────

/**
 * Run a slot exactly once per day. Returns false (without running) if the
 * ledger already has it — this is what stops a cron fire and a catch-up sweep
 * from both running the same batch.
 */
export async function runSlotOnce(slot: DailySlot, opts: { catchUp?: boolean } = {}): Promise<boolean> {
  if (ledgerHas(slot.label)) return false;
  ledgerMark(slot.label, { status: 'running', startedAt: new Date().toISOString(), catchUp: !!opts.catchUp, pid: process.pid });
  const tag = opts.catchUp ? 'CATCH-UP' : 'CRON';
  console.log(`\n[${nowIstString()}] ▶ ${slot.label}  (${tag}, scheduled ${slot.time} IST)`);
  try {
    await slot.run();
    ledgerMark(slot.label, { status: 'done', endedAt: new Date().toISOString() });
  } catch (err: any) {
    ledgerMark(slot.label, { status: 'error', endedAt: new Date().toISOString(), error: String(err?.message || err) });
    console.error(`[${slot.label}] Error: ${err?.message || err}`);
  }
  return true;
}

export function nowIstString(): string {
  return new Date().toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) + ' IST';
}

// ── Catch-up sweeper ─────────────────────────────────────────────────────────

let sweeping = false;

function cutoffMinutes(): number {
  return hhmmToMinutes(process.env.CATCHUP_CUTOFF_IST || '21:00');
}

function graceMinutes(): number {
  const n = parseInt(process.env.CATCHUP_GRACE_MIN || '3', 10);
  return Number.isFinite(n) ? n : 3;
}

/** Slots that should already have run today but have no ledger entry, in schedule order. */
export function findMissedSlots(slots: DailySlot[], now = new Date()): DailySlot[] {
  const nowMin = nowIstMinutes(now);
  if (nowMin > cutoffMinutes()) return [];
  const ledger = readLedger();
  return slots
    .filter((s) => {
      if (hhmmToMinutes(s.time) + graceMinutes() > nowMin) return false;
      const e = ledger.slots[s.label];
      if (!e) return true;
      return e.status === 'running' && !!e.pid && e.pid !== process.pid; // orphaned by a dead daemon
    })
    .sort((a, b) => hhmmToMinutes(a.time) - hhmmToMinutes(b.time));
}

async function sweep(slots: DailySlot[]): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const missed = findMissedSlots(slots);
    if (missed.length === 0) return;
    console.log(`\n[${nowIstString()}] ⏪ Catch-up: ${missed.length} missed slot(s) today → ${missed.map((m) => `${m.time} ${m.label}`).join(', ')}`);
    for (const slot of missed) {
      // Re-check the cutoff before each one — a long catch-up chain must not
      // run into the night.
      if (nowIstMinutes() > cutoffMinutes()) {
        console.log(`[${nowIstString()}] ⏪ Catch-up cutoff (${process.env.CATCHUP_CUTOFF_IST || '21:00'} IST) reached — remaining missed slots stay missed.`);
        break;
      }
      await runSlotOnce(slot, { catchUp: true });
    }
  } finally {
    sweeping = false;
  }
}

/** Start the periodic sweeper (and one delayed startup sweep). */
export function startCatchUpSweeper(slots: DailySlot[]): void {
  // OFF by default (2026-09-08: silently re-ran a whole morning of batches —
  // Medium, FB, LI etc — on a machine that had already posted them under an
  // un-ledgered daemon; duplicate posting is worse than a missed slot). Opt
  // in explicitly with CATCHUP_ENABLED=1 once you've verified the ledger
  // reflects reality (see `npm run ledger` / `npm run ledger:seed`).
  if (process.env.CATCHUP_ENABLED !== '1') {
    console.log('[ledger] Catch-up sweeper is OFF by default — set CATCHUP_ENABLED=1 to turn it on. (Ledger + heartbeat still active.)');
    return;
  }
  const s = ledgerSummary();
  console.log(`[ledger] ${s.date}: ${s.done.length} done, ${s.running.length} running, ${s.error.length} error — catch-up sweeper on (cutoff ${process.env.CATCHUP_CUTOFF_IST || '21:00'} IST, grace ${graceMinutes()} min)`);
  setTimeout(() => { sweep(slots).catch((e) => console.error(`[ledger] sweep error: ${e.message}`)); }, STARTUP_SWEEP_DELAY_MS);
  const t = setInterval(() => { sweep(slots).catch((e) => console.error(`[ledger] sweep error: ${e.message}`)); }, SWEEP_INTERVAL_MS);
  t.unref?.();
}

// ── Seeding (marking slots as already-run without running them) ──────────────

/** Mark every slot scheduled at or before `hhmm` (IST) as done for today,
 * without running it. Used when batches already ran under a daemon that did
 * not keep a ledger (first day of this feature, or someone started plain
 * `npm run dev` earlier in the day). Returns the labels seeded. */
export function seedLedgerBefore(slots: DailySlot[], hhmm: string, note = 'seeded'): string[] {
  const limit = hhmmToMinutes(hhmm);
  const seeded: string[] = [];
  for (const s of slots) {
    if (hhmmToMinutes(s.time) <= limit && !ledgerHas(s.label)) {
      ledgerMark(s.label, { status: 'done', endedAt: new Date().toISOString(), error: note, pid: process.pid });
      seeded.push(s.label);
    }
  }
  return seeded;
}

/** On startup: if there is NO ledger for today but .sessions/batch-counters.json
 * already shows posts recorded today, an un-ledgered daemon ran earlier — so
 * treat every slot before now as done instead of re-running the whole day. */
export function seedIfOldDaemonRanToday(slots: DailySlot[]): string[] {
  if (fs.existsSync(LEDGER_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')) as Ledger;
      if (saved.date === todayIst()) return []; // a ledgered daemon already ran today — normal catch-up applies
    } catch { /* fall through */ }
  }
  let postsToday = 0;
  try {
    const c = JSON.parse(fs.readFileSync(path.resolve('.sessions/batch-counters.json'), 'utf8'));
    if (c.date === todayIst()) postsToday = Object.entries(c).filter(([k]) => k !== 'date').reduce((a, [, v]) => a + (Number(v) || 0), 0);
  } catch { /* no counters */ }
  if (postsToday === 0) return [];
  const nowMin = nowIstMinutes();
  const hh = String(Math.floor(nowMin / 60)).padStart(2, '0'), mm = String(nowMin % 60).padStart(2, '0');
  const seeded = seedLedgerBefore(slots, `${hh}:${mm}`, 'seeded: an un-ledgered daemon already posted today');
  if (seeded.length) console.log(`[ledger] No ledger for today but ${postsToday} posts already recorded — assuming an earlier daemon ran them. Marked ${seeded.length} past slot(s) as done; no catch-up for those.`);
  return seeded;
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

export function startHeartbeat(): void {
  const beat = () => {
    try {
      fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }));
    } catch { /* best effort */ }
  };
  beat();
  const t = setInterval(beat, HEARTBEAT_MS);
  t.unref?.();
}

export function readHeartbeat(): { ts: Date; pid: number } | null {
  try {
    const j = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    return { ts: new Date(j.ts), pid: Number(j.pid) };
  } catch {
    return null;
  }
}

export const HEARTBEAT_INTERVAL_MS = HEARTBEAT_MS;
