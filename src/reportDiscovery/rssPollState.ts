/**
 * rssPollState.ts — remembers the last successful RSS poll date so each
 * scheduled poll can request `?since=<lastPollDate>` instead of re-fetching
 * the whole feed every time.
 */
import fs from 'fs';
import path from 'path';

const POLL_STATE_FILE = path.resolve('.sessions/rss-last-poll.json');

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function getLastPollDate(): string {
  try {
    const j = JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf8'));
    if (typeof j.lastPollDate === 'string' && j.lastPollDate) return j.lastPollDate;
  } catch { /* no state yet */ }
  // First run: look back 2 days as a safety buffer rather than the whole feed.
  return daysAgoIso(2);
}

export function setLastPollDate(dateIso: string): void {
  fs.mkdirSync(path.dirname(POLL_STATE_FILE), { recursive: true });
  fs.writeFileSync(POLL_STATE_FILE, JSON.stringify({ lastPollDate: dateIso, updatedAt: new Date().toISOString() }, null, 2));
}
