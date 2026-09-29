/**
 * distributedUrlPool.ts — fallback URL source for the nightly New Logic /
 * Social Media feeders, used when the RSS Extraction tab doesn't have enough
 * unfed rows to hit the daily quota (100 for New Logic, 200 for Social
 * Media).
 *
 * Source: the separate "Distributed URL" spreadsheet
 * (1ZbEcDaK-zb6U1SK1P23UIjezN5NGdy3R15r9W-glVlU), tabs "Report R.S",
 * "Report R.V", "Report R.P", "Report R.A" — cycled in that fixed order
 * (R.S and R.V prioritized first, per explicit instruction 2026-09-17).
 * Each tab is [URL, Title], no status columns, so "already used" is tracked
 * locally (not written back to that sheet) via a per-purpose cursor file —
 * New Logic and Social Media each get their own independent cursor, so the
 * same underlying report URL can be picked for both a blog post and a
 * social post (that's the intended behavior, not a bug).
 *
 * When a cursor runs off the end of all 4 tabs, it wraps back to the start
 * of "Report R.P" and recycles the pool rather than running dry.
 */
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const DISTRIBUTED_URL_SHEET_ID = '1ZbEcDaK-zb6U1SK1P23UIjezN5NGdy3R15r9W-glVlU';
const TAB_ORDER = ['Report R.S', 'Report R.V', 'Report R.P', 'Report R.A'];

export type PoolPurpose = 'newLogic' | 'socialMedia';

interface CursorState {
  tabIndex: number; // index into TAB_ORDER
  rowIndex: number;  // 0-based data-row offset within that tab (0 = first data row)
}

function cursorFile(purpose: PoolPurpose): string {
  return path.resolve(`.sessions/distributed-url-cursor-${purpose}.json`);
}

function loadCursor(purpose: PoolPurpose): CursorState {
  try {
    const raw = fs.readFileSync(cursorFile(purpose), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.tabIndex === 'number' && typeof parsed.rowIndex === 'number') return parsed;
  } catch { /* no cursor yet */ }
  return { tabIndex: 0, rowIndex: 0 };
}

function saveCursor(purpose: PoolPurpose, state: CursorState): void {
  fs.mkdirSync(path.dirname(cursorFile(purpose)), { recursive: true });
  fs.writeFileSync(cursorFile(purpose), JSON.stringify(state, null, 2));
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: '.accounts/google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() as any });
}

export interface DistributedUrlPick {
  url: string;
  title: string;
  sourceTab: string; // e.g. "R.P" — written to New Logic's "Report Tab" column
}

/**
 * Pulls up to `count` URLs from the pool, continuing from wherever this
 * purpose's cursor left off, advancing through R.P → R.A → R.S → R.V and
 * wrapping back to R.P if it runs out. Saves the new cursor position before
 * returning. Does not mutate the Distributed URL spreadsheet itself.
 */
export async function pickFromDistributedUrlPool(purpose: PoolPurpose, count: number): Promise<DistributedUrlPick[]> {
  if (count <= 0) return [];
  const sheets = await getSheetsClient();

  // Cache each tab's data rows for this call so wrapping around doesn't
  // re-fetch a tab it already read.
  const tabCache = new Map<number, string[][]>();
  async function getTabRows(tabIndex: number): Promise<string[][]> {
    if (tabCache.has(tabIndex)) return tabCache.get(tabIndex)!;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: DISTRIBUTED_URL_SHEET_ID,
      range: `${TAB_ORDER[tabIndex]}!A2:B`, // skip header row
    });
    const rows = res.data.values ?? [];
    tabCache.set(tabIndex, rows);
    return rows;
  }

  let cursor = loadCursor(purpose);
  const picks: DistributedUrlPick[] = [];
  let wrapped = false;

  while (picks.length < count) {
    const rows = await getTabRows(cursor.tabIndex);

    if (cursor.rowIndex >= rows.length) {
      // Exhausted this tab — move to the next one in the fixed order.
      const nextTabIndex = cursor.tabIndex + 1;
      if (nextTabIndex >= TAB_ORDER.length) {
        if (wrapped) {
          // Went all the way around twice with nothing usable — pool is
          // genuinely empty (e.g. tabs have no rows at all). Stop rather
          // than loop forever.
          break;
        }
        wrapped = true;
        cursor = { tabIndex: 0, rowIndex: 0 };
        console.log(`   🔁 [Distributed URL Pool:${purpose}] All 4 tabs exhausted — recycling pool from "${TAB_ORDER[0]}".`);
      } else {
        cursor = { tabIndex: nextTabIndex, rowIndex: 0 };
      }
      continue;
    }

    const pickedFromTabIndex = cursor.tabIndex;
    const [url, title] = rows[cursor.rowIndex];
    cursor = { tabIndex: cursor.tabIndex, rowIndex: cursor.rowIndex + 1 };
    if (!url || !url.trim()) continue; // skip blank rows, keep advancing

    picks.push({
      url: url.trim(),
      title: (title ?? '').trim(),
      sourceTab: TAB_ORDER[pickedFromTabIndex].replace('Report ', ''), // "Report R.P" -> "R.P"
    });
  }

  saveCursor(purpose, cursor);
  console.log(`   📦 [Distributed URL Pool:${purpose}] Picked ${picks.length}/${count} URL(s). Cursor now at ${TAB_ORDER[cursor.tabIndex]} row ${cursor.rowIndex + 2}.`);
  return picks;
}
