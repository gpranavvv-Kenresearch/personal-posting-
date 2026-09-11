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
  { key: 'x',               displayName: 'X',              statusCol: 'X Status',               errorCol: 'X Error',               lastPostedCol: 'lastPostedX',              sheet: 'social' },
  { key: 'facebook',        displayName: 'Facebook',       statusCol: 'FB Status',              errorCol: 'FB Error',              lastPostedCol: 'lastPostedFb',             sheet: 'social' },
  { key: 'linkedin',        displayName: 'LinkedIn',       statusCol: 'LinkedIn Status',        errorCol: 'LinkedIn Error',        lastPostedCol: 'lastPostedLi',             sheet: 'social' },
  // Blog
  { key: 'hackmd',          displayName: 'HackMD',         statusCol: 'HackMD Status',          errorCol: 'HackMD Error',          lastPostedCol: 'lastPostedHackmd',         sheet: 'blog' },
  { key: 'googlesite',      displayName: 'Google Sites',   statusCol: 'Google Site Status',     errorCol: 'Google Site Error',     lastPostedCol: 'lastPostedGoogleSite',     sheet: 'blog' },
  { key: 'devto',           displayName: 'Dev.to',         statusCol: 'Dev.to Status',          errorCol: 'Dev.to Error',          lastPostedCol: 'lastPostedDevto',          sheet: 'blog' },
  { key: 'linkmate',        displayName: 'Linkmate',       statusCol: 'Linkmate Status',        errorCol: 'Linkmate Error',        lastPostedCol: 'lastPostedLinkmate',       sheet: 'blog' },
  { key: 'calisthenics',    displayName: 'Calisthenics',   statusCol: 'Calisthenics Status',    errorCol: 'Calisthenics Error',    lastPostedCol: 'lastPostedCalisthenics',   sheet: 'blog' },
  { key: 'wordpress',       displayName: 'WordPress',      statusCol: 'WordPress Status',       errorCol: 'WordPress Error',       lastPostedCol: 'lastPostedWordpress',      sheet: 'blog' },
  { key: 'blogger',         displayName: 'Blogger',        statusCol: 'Blogger Status',         errorCol: 'Blogger Error',         lastPostedCol: 'lastPostedBlogger',        sheet: 'blog' },
  { key: 'linkedinpulse',   displayName: 'LinkedIn Pulse', statusCol: 'LinkedIn Pulse Status',  errorCol: 'LinkedIn Pulse Error',  lastPostedCol: 'lastPosted linkedin Pulse', sheet: 'blog' },
  { key: 'medium',          displayName: 'Medium',         statusCol: 'Medium Status',          errorCol: 'Medium Error',          lastPostedCol: 'lastPostedMedium',         sheet: 'blog' },
  { key: 'notion',          displayName: 'Notion',         statusCol: 'Notion Status',          errorCol: 'Notion Error',          lastPostedCol: 'lastPostedNotion',         sheet: 'blog' },
  { key: 'substack',        displayName: 'Substack',       statusCol: 'Substack Status',        errorCol: 'Substack Error',        lastPostedCol: 'lastPostedSubstack',       sheet: 'blog' },
  { key: 'paragraph',       displayName: 'Paragraph',      statusCol: 'Paragraph Status',       errorCol: 'Paragraph Error',       lastPostedCol: 'lastPostedParagraph',      sheet: 'blog' },
  { key: 'ameba',           displayName: 'Ameba',          statusCol: 'Ameba Status',           errorCol: 'Ameba Error',           lastPostedCol: 'lastPostedAmeba',          sheet: 'blog' },
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

// ──── Build the today-summary table as a string ───────────────────────────

export function buildTodaySummaryText(r: TrackerResult): string {
  const nameWidth = Math.max(
    'Platform'.length,
    ...PLATFORMS.map(p => p.displayName.length),
    'TOTAL'.length,
  );
  const countWidth = 6;
  const sep = `+${'-'.repeat(nameWidth + 2)}+${'-'.repeat(countWidth + 2)}+`;

  const lines: string[] = [];
  lines.push(`Today's Posting Summary — ${r.date}`);
  lines.push('');
  lines.push(sep);
  lines.push(`| ${'Platform'.padEnd(nameWidth)} | ${'Posts'.padStart(countWidth)} |`);
  lines.push(sep);

  let total = 0;
  for (const p of PLATFORMS) {
    const count = r.platforms[p.key]?.postedToday ?? 0;
    total += count;
    lines.push(`| ${p.displayName.padEnd(nameWidth)} | ${String(count).padStart(countWidth)} |`);
  }

  lines.push(sep);
  lines.push(`| ${'TOTAL'.padEnd(nameWidth)} | ${String(total).padStart(countWidth)} |`);
  lines.push(sep);
  return lines.join('\n');
}

// ──── Teams webhook poster ────────────────────────────────────────────────

export async function postTodaySummaryToTeams(r: TrackerResult): Promise<void> {
  const url = process.env.TEAMS_WEBHOOK_URL;
  if (!url) {
    console.warn('⚠️  TEAMS_WEBHOOK_URL not set — skipping Teams post.');
    return;
  }

  // Build a table of facts for the Adaptive Card
  const facts = PLATFORMS.map(p => ({
    title: p.displayName,
    value: String(r.platforms[p.key]?.postedToday ?? 0),
  }));
  const total = facts.reduce((s, f) => s + Number(f.value), 0);
  facts.push({ title: 'TOTAL', value: String(total) });

  const payload = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              size: 'Large',
              weight: 'Bolder',
              text: `📊 Today's Posting Summary — ${r.date}`,
              wrap: true,
            },
            {
              type: 'FactSet',
              facts,
            },
          ],
        },
      },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`❌ Teams webhook failed: ${res.status} ${res.statusText}\n${body}`);
    return;
  }
  console.log('✅ Summary posted to Teams.');
}

// ──── Today-only summary printer ──────────────────────────────────────────

export function printTodaySummary(r: TrackerResult): void {
  const nameWidth = Math.max(
    'Platform'.length,
    ...PLATFORMS.map(p => p.displayName.length),
    'TOTAL'.length,
  );
  const countWidth = 6;

  const sep = `+${'-'.repeat(nameWidth + 2)}+${'-'.repeat(countWidth + 2)}+`;

  console.log(`\nToday's Posting Summary — ${r.date}\n`);
  console.log(sep);
  console.log(`| ${'Platform'.padEnd(nameWidth)} | ${'Posts'.padStart(countWidth)} |`);
  console.log(sep);

  let total = 0;
  for (const p of PLATFORMS) {
    const count = r.platforms[p.key]?.postedToday ?? 0;
    total += count;
    console.log(`| ${p.displayName.padEnd(nameWidth)} | ${String(count).padStart(countWidth)} |`);
  }

  console.log(sep);
  console.log(`| ${'TOTAL'.padEnd(nameWidth)} | ${String(total).padStart(countWidth)} |`);
  console.log(sep);
  console.log('');
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
  for (const key of ['medium', 'linkmate', 'googlesite', 'devto', 'linkedinpulse', 'calisthenics', 'substack', 'hackmd']) {
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
