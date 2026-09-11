/**
 * supervisor.ts — keeps the cron daemon alive and un-stuck.
 *
 *   npm run dev:supervised
 *
 * Spawns `node --import=tsx src/index.ts` (the normal `npm run dev` daemon) as
 * a child process and watches .sessions/heartbeat.json, which the daemon
 * rewrites every 20 s from a setInterval. If the daemon's event loop is
 * blocked (hung Playwright call, stuck child process, etc.) the file stops
 * updating; after STALE_AFTER_MS with no fresh beat the supervisor kills the
 * whole child process tree (daemon + its Chrome windows) and starts a new
 * daemon, which immediately runs any slots it missed via the catch-up
 * sweeper in batchLedger.ts. A child that exits on its own is restarted too.
 *
 * Sleep/hibernate safety: after the machine wakes, the heartbeat looks stale
 * even though the daemon is fine and about to write again. So a stale reading
 * is re-checked after RECHECK_MS — the daemon is restarted only if it STILL
 * has not written a fresh beat since the first stale reading.
 *
 * Env overrides:
 *   SUPERVISOR_STALE_MIN=3     minutes without a heartbeat before restart
 *   SUPERVISOR_MAX_RESTARTS=20 give up (exit 1) after this many restarts in a day
 */

import 'dotenv/config';
import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import { readHeartbeat } from './batchLedger.js';

const STALE_AFTER_MS = (parseFloat(process.env.SUPERVISOR_STALE_MIN || '3') || 3) * 60_000;
const CHECK_MS = 30_000;
const RECHECK_MS = 45_000;
const RESTART_BACKOFF_MS = 10_000;
const MAX_RESTARTS = parseInt(process.env.SUPERVISOR_MAX_RESTARTS || '20', 10) || 20;

const DAEMON_ARGS = ['--import=tsx', path.resolve('src/index.ts')];

let child: ChildProcess | null = null;
let restarts = 0;
let restartDay = new Date().toDateString();
let stopping = false;

function ts(): string {
  return new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';
}

function log(msg: string): void {
  console.log(`[supervisor ${ts()}] ${msg}`);
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      // /T kills the daemon AND every Chrome it launched.
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 15_000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

function startDaemon(): void {
  if (new Date().toDateString() !== restartDay) { restartDay = new Date().toDateString(); restarts = 0; }
  if (restarts >= MAX_RESTARTS) {
    log(`❌ ${restarts} restarts today — giving up so a human looks at this.`);
    process.exit(1);
  }
  log(`▶ starting daemon: node ${DAEMON_ARGS.join(' ')}`);
  child = spawn(process.execPath, DAEMON_ARGS, {
    stdio: 'inherit',
    env: { ...process.env, SUPERVISED: '1' },
    detached: process.platform !== 'win32',
  });
  const c = child;
  c.on('exit', (code, signal) => {
    if (c !== child) return; // stale handler from a previous child
    child = null;
    if (stopping) return;
    log(`daemon exited (code ${code}, signal ${signal}) — restarting in ${RESTART_BACKOFF_MS / 1000}s`);
    restarts++;
    setTimeout(startDaemon, RESTART_BACKOFF_MS);
  });
}

function restartDaemon(reason: string): void {
  log(`🔁 restarting daemon — ${reason}`);
  restarts++;
  const c = child;
  child = null; // so the exit handler above doesn't double-restart
  if (c?.pid) killTree(c.pid);
  setTimeout(startDaemon, RESTART_BACKOFF_MS);
}

function heartbeatAge(): number | null {
  const hb = readHeartbeat();
  return hb ? Date.now() - hb.ts.getTime() : null;
}

let recheckPending = false;

async function check(): Promise<void> {
  if (!child || recheckPending) return;
  const age = heartbeatAge();
  if (age === null) return; // daemon may still be booting
  if (age < STALE_AFTER_MS) return;

  // Stale. Could be a real hang — or the laptop just woke from sleep and the
  // daemon simply hasn't had its next 20 s tick yet. Give it RECHECK_MS.
  recheckPending = true;
  const firstSeen = readHeartbeat()?.ts.getTime() ?? 0;
  log(`⚠️ heartbeat is ${Math.round(age / 1000)}s old — re-checking in ${RECHECK_MS / 1000}s before restarting`);
  await new Promise((r) => setTimeout(r, RECHECK_MS));
  recheckPending = false;
  const latest = readHeartbeat()?.ts.getTime() ?? 0;
  if (latest > firstSeen) {
    log('heartbeat recovered — no restart');
    return;
  }
  restartDaemon(`no heartbeat for ${Math.round((Date.now() - latest) / 1000)}s (event loop blocked or process frozen)`);
}

process.on('SIGINT', () => {
  stopping = true;
  log('SIGINT — stopping daemon and exiting');
  if (child?.pid) killTree(child.pid);
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopping = true;
  if (child?.pid) killTree(child.pid);
  process.exit(0);
});

log(`watching heartbeat (stale after ${STALE_AFTER_MS / 60_000} min, check every ${CHECK_MS / 1000}s, max ${MAX_RESTARTS} restarts/day)`);
startDaemon();
setInterval(() => { check().catch((e) => log(`check error: ${e.message}`)); }, CHECK_MS);
