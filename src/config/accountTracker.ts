/**
 * accountTracker.ts — Daily Post Count Tracker
 *
 * Tracks how many posts each account has made today per platform.
 * Persists to .sessions/daily-counts.json — auto-resets when date changes.
 *
 * Per-account daily limits:
 *   X         : 12 posts/day
 *   Facebook  : 4  posts/day
 *   LinkedIn  : 3  posts/day
 */

import fs from 'fs';
import path from 'path';
import { getFacebookAccounts } from '../browser/facebook/login.js';
import { getLinkedInAccounts } from '../browser/linkedin/login.js';

const COUNTS_FILE = path.resolve('.sessions/daily-counts.json');

const LIMITS = {
  x:        14,   // 13-14 posts/day per X account (15 accounts × 14 = 210 X posts/day)
  facebook:  5,   // 4-5 posts/day per FB account  (15 accounts × 5  = 75 FB posts/day)
  linkedin:  3,   // 3 posts/day per LI account     (15 accounts × 3  = 45 LI posts/day)
};

interface DailyCounts {
  date:     string;
  x:        Record<string, number>;
  facebook: Record<string, number>;
  linkedin: Record<string, number>;
}

// ── Load / reset counts ───────────────────────────────────────────────────

function loadCounts(): DailyCounts {
  const today = new Date().toISOString().split('T')[0];
  if (fs.existsSync(COUNTS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(COUNTS_FILE, 'utf8')) as DailyCounts;
      if (data.date === today) return data;
    } catch { /* corrupt file — reset */ }
  }
  return { date: today, x: {}, facebook: {}, linkedin: {} };
}

function saveCounts(counts: DailyCounts): void {
  fs.mkdirSync(path.dirname(COUNTS_FILE), { recursive: true });
  fs.writeFileSync(COUNTS_FILE, JSON.stringify(counts, null, 2));
}

// ── Public API ────────────────────────────────────────────────────────────

/** Increment count after a successful post. Call once per successful post. */
export function incrementCount(
  platform: 'x' | 'facebook' | 'linkedin',
  nickname: string,
): void {
  const counts = loadCounts();
  counts[platform][nickname] = (counts[platform][nickname] ?? 0) + 1;
  saveCounts(counts);
}

/** Returns how many posts this account has made today on the given platform. */
export function getCount(
  platform: 'x' | 'facebook' | 'linkedin',
  nickname: string,
): number {
  return loadCounts()[platform][nickname] ?? 0;
}

/** Check if an X account still has capacity today (under 12/day). */
export function xAccountHasCapacity(nickname: string): boolean {
  return getCount('x', nickname) < LIMITS.x;
}

/**
 * Pick the Facebook account with the fewest posts today that is still under limit.
 * Returns null if all accounts are at their daily limit.
 */
export function getAvailableFbAccount(): { email: string; password: string; sessionDir: string; nickname: string } | null {
  const counts = loadCounts();
  const accounts = (getFacebookAccounts() as any[]).filter(a => a.active);
  const available = accounts
    .map(a => ({ ...a, used: counts.facebook[a.nickname] ?? 0 }))
    .filter(a => a.used < LIMITS.facebook)
    .sort((a, b) => a.used - b.used);

  if (available.length === 0) return null;
  return available[0];
}

/**
 * Pick the LinkedIn account with the fewest posts today that is still under limit.
 * Returns null if all accounts are at their daily limit.
 */
export function getAvailableLinkedInAccount(): { email: string; password: string; sessionDir: string; nickname: string } | null {
  const counts = loadCounts();
  const accounts = (getLinkedInAccounts() as any[]).filter(a => a.active);
  const available = accounts
    .map(a => ({ ...a, used: counts.linkedin[a.nickname] ?? 0 }))
    .filter(a => a.used < LIMITS.linkedin)
    .sort((a, b) => a.used - b.used);

  if (available.length === 0) return null;
  return available[0];
}

/** Print today's usage summary to console. */
export function printDailyUsage(): void {
  const counts = loadCounts();
  console.log(`\n📊 Daily usage (${counts.date}):`);
  console.log(`   X       : ${Object.entries(counts.x).map(([n, c]) => `${n}=${c}`).join(', ') || 'none'}`);
  console.log(`   Facebook: ${Object.entries(counts.facebook).map(([n, c]) => `${n}=${c}`).join(', ') || 'none'}`);
  console.log(`   LinkedIn: ${Object.entries(counts.linkedin).map(([n, c]) => `${n}=${c}`).join(', ') || 'none'}`);
}
