/**
 * seedContentPoolFromBlogsTab.ts — copy N already-written blogs from the
 * "Blogs" tab (which has fully-generated Blog Title/Description/Content,
 * cover image already embedded) into "Content Pool", so the daily posting
 * cron can claim and post them immediately — no generation needed for these
 * rows. Skips any Target URL already present in Content Pool.
 *
 * Column mapping (Blogs → Content Pool):
 *   Blog Title       → Title        (the polished headline, used for posting)
 *   Blog Description → Description
 *   Blog Caption     → Blog Caption
 *   Blog Content     → Blog Content (already has the cover image embedded)
 *   targetUrl        → Target URL
 *   Name             → Name
 *   New Name         → New Name
 *
 * Run with: node --import=tsx src/tools/seedContentPoolFromBlogsTab.ts [count]
 *   [count] optional — how many rows to take, starting from row 2 (default 150).
 */

import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs';
import { appendFullRowsToContentPool } from '../sheets/sheets.js';

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

async function main() {
  const count = Number(process.argv[2]) || 150;

  const sheets = await getSheetsClient();

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${BLOGS_SHEET_NAME}!1:1`,
  });
  const headers: string[] = headerRes.data.values?.[0] ?? [];
  const urlIdx = findCol(headers, 'targetUrl');
  const blogTitleIdx = findCol(headers, 'Blog Title');
  const blogDescIdx = findCol(headers, 'Blog Description');
  const blogCaptionIdx = findCol(headers, 'Blog Caption');
  const blogContentIdx = findCol(headers, 'Blog Content');
  const fallbackTitleIdx = findCol(headers, 'Title');
  const nameIdx = findCol(headers, 'Name');
  const newNameIdx = findCol(headers, 'New Name');

  if (urlIdx === -1 || blogContentIdx === -1) {
    console.error(`Could not find "targetUrl"/"Blog Content" columns in ${BLOGS_SHEET_NAME}. Headers seen: ${headers.join(', ')}`);
    process.exit(1);
  }

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${BLOGS_SHEET_NAME}!A:AZ`,
  });
  const rows: string[][] = dataRes.data.values ?? [];

  // Row 2 = rows[1] (rows[0] is the header) — take `count` rows from there.
  const picked: Array<{ title: string; targetUrl: string; description: string; blogCaption: string; blogContent: string; name: string; newName: string }> = [];
  for (let i = 1; i < rows.length && picked.length < count; i++) {
    const row = rows[i];
    const targetUrl = (row[urlIdx] ?? '').trim();
    const blogContent = (row[blogContentIdx] ?? '').trim();
    if (!targetUrl || !blogContent) continue; // skip rows with no URL or no finished content
    const title = (row[blogTitleIdx] ?? '').trim() || (fallbackTitleIdx !== -1 ? (row[fallbackTitleIdx] ?? '').trim() : '');
    const description = blogDescIdx !== -1 ? (row[blogDescIdx] ?? '').trim() : '';
    const blogCaption = blogCaptionIdx !== -1 ? (row[blogCaptionIdx] ?? '').trim() : '';
    const name = nameIdx !== -1 ? (row[nameIdx] ?? '').trim() : '';
    const newName = newNameIdx !== -1 ? (row[newNameIdx] ?? '').trim() : '';
    picked.push({ title, targetUrl, description, blogCaption, blogContent, name, newName });
  }

  console.log(`Picked ${picked.length} fully-written row(s) from "${BLOGS_SHEET_NAME}" (rows 2-${picked.length + 1}).`);
  if (picked.length === 0) {
    console.log('Nothing to append.');
    return;
  }

  // Skip anything already in Content Pool by Target URL.
  const poolHeaderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONTENT_POOL_SHEET_NAME}!1:1`,
  });
  const poolHeaders: string[] = poolHeaderRes.data.values?.[0] ?? [];
  const poolUrlIdx = findCol(poolHeaders, 'Target URL') !== -1 ? findCol(poolHeaders, 'Target URL') : findCol(poolHeaders, 'targetUrl');
  const poolDataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONTENT_POOL_SHEET_NAME}!A:AZ`,
  });
  const poolRows: string[][] = poolDataRes.data.values ?? [];
  const existingUrls = new Set<string>();
  if (poolUrlIdx !== -1) {
    for (let i = 1; i < poolRows.length; i++) {
      const u = (poolRows[i][poolUrlIdx] ?? '').trim();
      if (u) existingUrls.add(u);
    }
  }

  const toAppend = picked.filter(p => !existingUrls.has(p.targetUrl));
  const skipped = picked.length - toAppend.length;
  console.log(`${toAppend.length} row(s) new (skipped ${skipped} already in Content Pool).`);
  if (toAppend.length === 0) {
    console.log('Nothing to append.');
    return;
  }

  const ok = await appendFullRowsToContentPool(toAppend);
  if (!ok) {
    console.error('❌ Did NOT append — Content Pool is missing its Title/Target URL column.');
    process.exit(1);
  }
  console.log(`✅ Appended ${toAppend.length} fully-written row(s) to Content Pool.`);
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
