/**
 * tracker.ts — Daily Posting Tracker
 *
 * Reads both Social Media and Blogs sheets, counts today's
 * posted / failed / pending per platform, and prints a summary.
 *
 * Usage: npm run dev -- tracker
 */

import { google } from 'googleapis';
import 'dotenv/config';

// ──── Sheet config ────────────────────────────────────────────────────────

const SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';

const SHEETS = [
  { name: 'Social Media', type: 'social' as const },
  { name: 'Blogs',        type: 'blog'   as const },
];

// Platform definitions: column name for status, error, and lastPosted
const PLATFORMS = [
  // Social
  { key: 'x',               statusCol: 'X Status',               errorCol: 'X Error',               lastPostedCol: 'lastPostedX',              sheet: 'social' },
  { key: 'facebook',        statusCol: 'FB Status',              errorCol: 'FB Error',              lastPostedCol: 'lastPostedFb',             sheet: 'social' },
  { key: 'linkedin',        statusCol: 'LinkedIn Status',        errorCol: 'LinkedIn Error',        lastPostedCol: 'lastPostedLi',             sheet: 'social' },
  // Blog
  { key: 'medium',          statusCol: 'Medium Status',          errorCol: 'Medium Error',          lastPostedCol: 'lastPostedMedium',         sheet: 'blog' },
  { key: 'linkmate',        statusCol: 'Linkmate Status',        errorCol: 'Linkmate Error',        lastPostedCol: 'lastPostedLinkmate',       sheet: 'blog' },
  { key: 'googlesite',      statusCol: 'Google Site Status',     errorCol: 'Google Site Error',     lastPostedCol: 'lastPostedGoogleSite',     sheet: 'blog' },
  { key: 'devto',           statusCol: 'Dev.to Status',          errorCol: 'Dev.to Error',          lastPostedCol: 'lastPostedDevto',          sheet: 'blog' },
  { key: 'linkedinpulse',   statusCol: 'LinkedIn Pulse Status',  errorCol: 'LinkedIn Pulse Error',  lastPostedCol: 'lastPosted linkedin Pulse', sheet: 'blog' },
  { key: 'calisthenics',    statusCol: 'Calisthenics Status',    errorCol: 'Calisthenics Error',    lastPostedCol: 'lastPostedCalisthenics',   sheet: 'blog' },
  { key: 'substack',        statusCol: 'Substack Status',        errorCol: 'Substack Error',        lastPostedCol: 'lastPostedSubstack',       sheet: 'blog' },
  { key: 'guffiz',          statusCol: 'Guffiz Status',          errorCol: 'Guffiz Error',          lastPostedCol: 'lastPostedGuffiz',         sheet: 'blog' },
  { key: 'hackmd',          statusCol: 'HackMD Status',          errorCol: 'HackMD Error',          lastPostedCol: 'lastPostedHackmd',         sheet: 'blog' },
];

// ──── Auth ────────────────────────────────────────────────────────────────

async function getSheetsClient() {
  let credentials: object;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    const fs = (await import('fs')).default;
    const raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
    credentials = JSON.parse(raw);
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ──── Column resolver ─────────────────────────────────────────────────────

type ColMap = Record<string, number>;

function buildColMap(headerRow: string[]): ColMap {
  const map: ColMap = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = (headerRow[i] ?? '').trim();
    if (h) {
      map[h] = i;
      map[h.toLowerCase()] = i;
    }
  }
  return map;
}

function getCell(row: string[], colMap: ColMap, ...names: string[]): string {
  for (const n of names) {
    const idx = colMap[n] ?? colMap[n.toLowerCase()];
    if (idx !== undefined) return (row[idx] ?? '').trim();
  }
  return '';
}

// ──── Core tracker ────────────────────────────────────────────────────────

interface PlatformStats {
  posted: number;
  failed: number;
  pending: number;       // has status column empty (not yet attempted)
  totalRows: number;     // rows that exist in the sheet for this platform's tab
  postedToday: number;   // lastPosted contains today's date
  errors: string[];      // unique error messages (max 5)
}

export interface TrackerResult {
  date: string;
  platforms: Record<string, PlatformStats>;
  grandTotal: { posted: number; failed: number; pending: number; postedToday: number };
}

export async function runTracker(): Promise<TrackerResult> {
  const sheets = await getSheetsClient();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Read both sheets in parallel
  const sheetData: Record<string, { colMap: ColMap; rows: string[][] }> = {};

  await Promise.all(
    SHEETS.map(async (s) => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${s.name}!A:AZ`,
      });
      const allRows: string[][] = res.data.values ?? [];
      const header = allRows[0] ?? [];
      sheetData[s.type] = {
        colMap: buildColMap(header),
        rows: allRows.slice(1), // skip header
      };
    })
  );

  const platforms: Record<string, PlatformStats> = {};
  const grandTotal = { posted: 0, failed: 0, pending: 0, postedToday: 0 };

  for (const p of PLATFORMS) {
    const data = sheetData[p.sheet];
    if (!data) continue;

    const stats: PlatformStats = {
      posted: 0,
      failed: 0,
      pending: 0,
      totalRows: data.rows.length,
      postedToday: 0,
      errors: [],
    };

    const errorSet = new Set<string>();

    for (const row of data.rows) {
      const status = getCell(row, data.colMap, p.statusCol).toLowerCase();
      const lastPosted = getCell(row, data.colMap, p.lastPostedCol);

      if (status === 'posted') {
        stats.posted++;
      } else if (status === 'failed' || status === 'error') {
        stats.failed++;
        const errMsg = getCell(row, data.colMap, p.errorCol);
        if (errMsg && errorSet.size < 5) {
          // Truncate long errors
          const short = errMsg.length > 120 ? errMsg.slice(0, 120) + '...' : errMsg;
          errorSet.add(short);
        }
      } else {
        stats.pending++;
      }

      // Check if posted today (lastPosted may be "2026-04-17" or "2026-04-16 | 2026-04-17")
      if (lastPosted) {
        const parts = lastPosted.split(' | ');
        const latest = (parts[parts.length - 1] ?? '').split('T')[0].trim();
        if (latest === today) {
          stats.postedToday++;
        }
      }
    }

    stats.errors = [...errorSet];
    platforms[p.key] = stats;

    grandTotal.posted += stats.posted;
    grandTotal.failed += stats.failed;
    grandTotal.pending += stats.pending;
    grandTotal.postedToday += stats.postedToday;
  }

  return { date: today, platforms, grandTotal };
}

// ──── Pretty printer ──────────────────────────────────────────────────────

export function printTrackerReport(r: TrackerResult): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  DAILY POSTING TRACKER — ${r.date}`);
  console.log(`${'='.repeat(72)}\n`);

  // Table header
  const hdr = [
    pad('Platform', 18),
    pad('Posted', 8),
    pad('Failed', 8),
    pad('Pending', 9),
    pad('Today', 7),
    pad('Total', 7),
  ].join(' | ');
  console.log(`  ${hdr}`);
  console.log(`  ${'-'.repeat(hdr.length)}`);

  // Social platforms
  console.log(`  ${'--- Social ---'.padEnd(hdr.length)}`);
  for (const key of ['x', 'facebook', 'linkedin']) {
    printPlatformRow(r.platforms[key], key);
  }

  // Blog platforms
  console.log(`  ${'--- Blogs ---'.padEnd(hdr.length)}`);
  for (const key of ['medium', 'linkmate', 'googlesite', 'devto', 'linkedinpulse', 'calisthenics', 'substack', 'guffiz', 'hackmd']) {
    printPlatformRow(r.platforms[key], key);
  }

  // Grand total
  console.log(`  ${'-'.repeat(hdr.length)}`);
  const totalLine = [
    pad('TOTAL', 18),
    pad(String(r.grandTotal.posted), 8),
    pad(String(r.grandTotal.failed), 8),
    pad(String(r.grandTotal.pending), 9),
    pad(String(r.grandTotal.postedToday), 7),
    pad('', 7),
  ].join(' | ');
  console.log(`  ${totalLine}`);

  // Failure details
  const failedPlatforms = Object.entries(r.platforms).filter(([, s]) => s.failed > 0);
  if (failedPlatforms.length > 0) {
    console.log(`\n  FAILURE DETAILS:`);
    for (const [key, stats] of failedPlatforms) {
      console.log(`\n  [${key.toUpperCase()}] — ${stats.failed} failed`);
      for (const err of stats.errors) {
        console.log(`    - ${err}`);
      }
    }
  }

  // Summary
  const failRate = r.grandTotal.posted + r.grandTotal.failed > 0
    ? ((r.grandTotal.failed / (r.grandTotal.posted + r.grandTotal.failed)) * 100).toFixed(1)
    : '0.0';
  console.log(`\n  Summary: ${r.grandTotal.postedToday} posted today | ${r.grandTotal.failed} total failures (${failRate}% fail rate)`);
  console.log(`${'='.repeat(72)}\n`);
}

function printPlatformRow(stats: PlatformStats | undefined, key: string): void {
  if (!stats) return;
  const failFlag = stats.failed > 0 ? ' !!' : '';
  const line = [
    pad(key, 18),
    pad(String(stats.posted), 8),
    pad(String(stats.failed), 8),
    pad(String(stats.pending), 9),
    pad(String(stats.postedToday), 7),
    pad(String(stats.totalRows), 7),
  ].join(' | ');
  console.log(`  ${line}${failFlag}`);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
