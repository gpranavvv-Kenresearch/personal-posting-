/**
 * seedContentPoolFromSocial.ts — pick unique reports (deduped by Target URL)
 * from the "Social Media" tab and append their Title + Target URL into
 * "Content Pool", skipping any Target URL already present there, so the
 * blog-gen loop has topics to work through without regenerating the same
 * report multiple times. Does not touch Name/New Name or any other column
 * — those get filled in later by claimNextRowsForGroup when a group batch
 * actually claims the row for posting.
 *
 * Run with: node --import=tsx src/tools/seedContentPoolFromSocial.ts [limit]
 *   [limit] optional — caps how many NEW rows get appended (default: no cap).
 */

import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs';
import { appendRowsToContentPool } from '../sheets/sheets.js';

const SPREADSHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const SOCIAL_SHEET_NAME = 'Social Media';
const CONTENT_POOL_SHEET_NAME = 'Content Pool';

async function getSheetsClient() {
  let credentials: object;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    const raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
    credentials = JSON.parse(raw);
  }
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

function findCol(headers: string[], name: string): number {
  return headers.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
}

async function main() {
  const limit = process.argv[2] ? Number(process.argv[2]) : Infinity;

  const sheets = await getSheetsClient();

  // ── Social Media: read Title + Target URL ────────────────────────────
  const socialHeaderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SOCIAL_SHEET_NAME}!1:1`,
  });
  const socialHeaders: string[] = socialHeaderRes.data.values?.[0] ?? [];
  const titleIdx = findCol(socialHeaders, 'title');
  const urlIdx = findCol(socialHeaders, 'targetUrl');
  if (titleIdx === -1 || urlIdx === -1) {
    console.error(`Could not find "title"/"targetUrl" columns in ${SOCIAL_SHEET_NAME}. Headers seen: ${socialHeaders.join(', ')}`);
    process.exit(1);
  }

  const socialDataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SOCIAL_SHEET_NAME}!A:AZ`,
  });
  const socialRows: string[][] = socialDataRes.data.values ?? [];

  // Dedupe by Target URL — keep the first Title seen for each URL.
  const uniqueByUrl = new Map<string, string>();
  for (let i = 1; i < socialRows.length; i++) {
    const row = socialRows[i];
    const targetUrl = (row[urlIdx] ?? '').trim();
    const title = (row[titleIdx] ?? '').trim();
    if (!targetUrl) continue;
    if (!uniqueByUrl.has(targetUrl)) uniqueByUrl.set(targetUrl, title);
  }
  console.log(`Social Media: ${socialRows.length - 1} rows → ${uniqueByUrl.size} unique Target URLs.`);

  // ── Content Pool: read existing Target URLs so we don't duplicate ────
  const poolHeaderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONTENT_POOL_SHEET_NAME}!1:1`,
  });
  const poolHeaders: string[] = poolHeaderRes.data.values?.[0] ?? [];
  const poolUrlIdx = findCol(poolHeaders, 'Target URL') !== -1 ? findCol(poolHeaders, 'Target URL') : findCol(poolHeaders, 'targetUrl');
  if (poolUrlIdx === -1) {
    console.error(`Could not find "Target URL" column in ${CONTENT_POOL_SHEET_NAME}. Headers seen: ${poolHeaders.join(', ')}`);
    process.exit(1);
  }

  const poolDataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONTENT_POOL_SHEET_NAME}!A:AZ`,
  });
  const poolRows: string[][] = poolDataRes.data.values ?? [];
  const existingUrls = new Set<string>();
  for (let i = 1; i < poolRows.length; i++) {
    const u = (poolRows[i][poolUrlIdx] ?? '').trim();
    if (u) existingUrls.add(u);
  }
  console.log(`Content Pool already has ${existingUrls.size} row(s) with a Target URL.`);

  // ── Build the list of genuinely new rows ──────────────────────────────
  const toAppend: Array<{ title: string; targetUrl: string }> = [];
  for (const [targetUrl, title] of uniqueByUrl) {
    if (existingUrls.has(targetUrl)) continue;
    toAppend.push({ title, targetUrl });
    if (toAppend.length >= limit) break;
  }

  console.log(`${toAppend.length} new unique row(s) to append (skipped ${uniqueByUrl.size - toAppend.length} already in Content Pool).`);
  if (toAppend.length === 0) {
    console.log('Nothing to append.');
    return;
  }

  const ok = await appendRowsToContentPool(toAppend);
  if (!ok) {
    console.error(`❌ Did NOT append — Content Pool is missing its "Target URL" column.`);
    process.exit(1);
  }
  console.log(`✅ Appended ${toAppend.length} row(s) to Content Pool.`);
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
