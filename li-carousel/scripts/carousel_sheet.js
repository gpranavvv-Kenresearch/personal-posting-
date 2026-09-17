// carousel_sheet.js — read/write Social Media sheet for carousel pipeline
//
// Usage:
//   node scripts/carousel_sheet.js next
//     → prints { row, targetUrl, title } of first row where col Y (LinkedIn Post) is empty
//
//   node scripts/carousel_sheet.js write --row=N --path="C:/..." --caption="..."
//   node scripts/carousel_sheet.js write --row=N --path="C:/..." --caption-file="C:/tmp/caption.txt"
//     → col E ← local PDF path | col Y (LinkedIn Post) ← caption

import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SHEET_ID = process.env.SOCIAL_SHEET_ID;
const SA_FILE  = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;

if (!SHEET_ID || !SA_FILE) {
  console.error('Missing SOCIAL_SHEET_ID or GOOGLE_SERVICE_ACCOUNT_FILE in .env');
  process.exit(1);
}
if (!fs.existsSync(SA_FILE)) {
  console.error(`Service account file not found: ${SA_FILE}`);
  process.exit(1);
}

const SA = JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
const auth = new google.auth.JWT({
  email: SA.client_email,
  key:   SA.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const TAB   = 'Social Media';
const COL_A = 0;   // targetUrl
const COL_B = 1;   // title
const COL_E = 4;   // local PDF path  (column E)
const COL_Y = 24;  // LinkedIn Post   (column Y)

function colLetter(idx) {
  let s = '', n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function fetchRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A:Z`,
  });
  return res.data.values ?? [];
}

async function commandNext() {
  const rows = await fetchRows();
  if (rows.length < 2) {
    console.log(JSON.stringify({ row: null, message: 'No data rows.' }));
    return;
  }
  for (let i = 1; i < rows.length; i++) {
    const row       = rows[i];
    const targetUrl = (row[COL_A] ?? '').trim();
    const title     = (row[COL_B] ?? '').trim();
    const liPost    = (row[COL_Y] ?? '').trim();
    if (targetUrl && !liPost) {
      console.log(JSON.stringify({ row: i + 1, targetUrl, title }));
      return;
    }
  }
  console.log(JSON.stringify({ row: null, message: 'Queue empty — all rows have LinkedIn Post data.' }));
}

async function commandWrite(args) {
  const rowNum = parseInt(args.row, 10);
  if (!rowNum || rowNum < 2) {
    console.error('Missing or invalid --row=N (sheet row number, >= 2)');
    process.exit(1);
  }

  const localPath = args.path ?? null;
  let caption = args.caption ?? null;
  if (!caption && args['caption-file']) {
    caption = fs.readFileSync(args['caption-file'], 'utf8').trim();
  }

  const data = [];
  if (localPath) {
    data.push({ range: `'${TAB}'!${colLetter(COL_E)}${rowNum}`, values: [[localPath]] });
  }
  if (caption) {
    data.push({ range: `'${TAB}'!${colLetter(COL_Y)}${rowNum}`, values: [[caption]] });
  }

  if (!data.length) {
    console.error('Nothing to write — provide --path and/or --caption / --caption-file');
    process.exit(1);
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });

  console.log(JSON.stringify({ ok: true, row: rowNum, wrote: { colE: !!localPath, colY: !!caption } }));
}

// ---------- CLI ----------
const command = process.argv[2];
const rawArgs = Object.fromEntries(
  process.argv.slice(3).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

try {
  if (command === 'next')       await commandNext();
  else if (command === 'write') await commandWrite(rawArgs);
  else {
    console.error('Usage: node scripts/carousel_sheet.js { next | write --row=N [--path=...] [--caption=... | --caption-file=...] }');
    process.exit(1);
  }
} catch (err) {
  console.error('Sheet error:', err?.message ?? err);
  if (err?.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  process.exit(1);
}
