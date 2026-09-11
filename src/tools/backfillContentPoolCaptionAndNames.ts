/**
 * backfillContentPoolCaptionAndNames.ts — one-off: for Content Pool rows that
 * came from the "Blogs" tab (already matched earlier by seedContentPoolFromBlogsTab.ts),
 * fill in the newly-added Blog Caption column plus Name/New Name, pulled from
 * the matching Blogs-tab row by Target URL. Only touches rows whose Blog
 * Caption is currently empty — safe to re-run.
 *
 * Run with: node --import=tsx src/tools/backfillContentPoolCaptionAndNames.ts
 */

import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs';

const SPREADSHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const BLOGS_SHEET_NAME = 'Blogs';
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

function colToLetter(idx: number): string {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function main() {
  const sheets = await getSheetsClient();

  // ── Blogs tab: build targetUrl → {blogCaption, name, newName} lookup ──
  const blogsHeaderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${BLOGS_SHEET_NAME}!1:1`,
  });
  const blogsHeaders: string[] = blogsHeaderRes.data.values?.[0] ?? [];
  const bUrlIdx = findCol(blogsHeaders, 'targetUrl');
  const bCaptionIdx = findCol(blogsHeaders, 'Blog Caption');
  const bNameIdx = findCol(blogsHeaders, 'Name');
  const bNewNameIdx = findCol(blogsHeaders, 'New Name');

  const blogsDataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${BLOGS_SHEET_NAME}!A:AZ`,
  });
  const blogsRows: string[][] = blogsDataRes.data.values ?? [];
  const byUrl = new Map<string, { blogCaption: string; name: string; newName: string }>();
  for (let i = 1; i < blogsRows.length; i++) {
    const row = blogsRows[i];
    const url = (row[bUrlIdx] ?? '').trim();
    if (!url) continue;
    byUrl.set(url, {
      blogCaption: bCaptionIdx !== -1 ? (row[bCaptionIdx] ?? '').trim() : '',
      name: bNameIdx !== -1 ? (row[bNameIdx] ?? '').trim() : '',
      newName: bNewNameIdx !== -1 ? (row[bNewNameIdx] ?? '').trim() : '',
    });
  }
  console.log(`Blogs tab: ${byUrl.size} URL(s) indexed.`);

  // ── Content Pool: find rows with empty Blog Caption that match a Blogs URL ──
  const poolHeaderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONTENT_POOL_SHEET_NAME}!1:1`,
  });
  const poolHeaders: string[] = poolHeaderRes.data.values?.[0] ?? [];
  const pUrlIdx = findCol(poolHeaders, 'Target URL');
  const pCaptionIdx = findCol(poolHeaders, 'Blog Caption');
  const pNameIdx = findCol(poolHeaders, 'Name');
  const pNewNameIdx = findCol(poolHeaders, 'New Name');

  if (pUrlIdx === -1 || pCaptionIdx === -1 || pNameIdx === -1 || pNewNameIdx === -1) {
    console.error(`Missing a required column in ${CONTENT_POOL_SHEET_NAME}. Headers: ${poolHeaders.join(', ')}`);
    process.exit(1);
  }

  const poolDataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONTENT_POOL_SHEET_NAME}!A:AZ`,
  });
  const poolRows: string[][] = poolDataRes.data.values ?? [];

  const updates: { range: string; values: string[][] }[] = [];
  let matched = 0;

  for (let i = 1; i < poolRows.length; i++) {
    const row = poolRows[i];
    const url = (row[pUrlIdx] ?? '').trim();
    const existingCaption = (row[pCaptionIdx] ?? '').trim();
    if (!url || existingCaption) continue; // already filled or no URL — skip

    const match = byUrl.get(url);
    if (!match) continue;

    const sheetRow = i + 1; // 1-indexed sheet row
    updates.push({
      range: `${CONTENT_POOL_SHEET_NAME}!${colToLetter(pCaptionIdx)}${sheetRow}`,
      values: [[match.blogCaption]],
    });
    updates.push({
      range: `${CONTENT_POOL_SHEET_NAME}!${colToLetter(pNameIdx)}${sheetRow}`,
      values: [[match.name]],
    });
    updates.push({
      range: `${CONTENT_POOL_SHEET_NAME}!${colToLetter(pNewNameIdx)}${sheetRow}`,
      values: [[match.newName]],
    });
    matched++;
  }

  console.log(`${matched} Content Pool row(s) matched and will be updated.`);
  if (updates.length === 0) {
    console.log('Nothing to update.');
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
  console.log(`✅ Backfilled Blog Caption + Name + New Name for ${matched} row(s).`);
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
