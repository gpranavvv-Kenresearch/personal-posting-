/**
 * cleanContentPoolCitationArtifacts.ts — one-off: strip leaked ChatGPT
 * citation artifacts (":contentReference[oaicite:N]{index=N}") out of
 * Content Pool's Title/Description/Blog Content columns for rows already
 * generated before blogGenAgent.ts started sanitizing title/description.
 *
 * Run with: node --import=tsx src/tools/cleanContentPoolCitationArtifacts.ts
 */

import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs';

const SPREADSHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const SHEET_NAME = 'Content Pool';
const ARTIFACT_RE = /\s*:contentReference\[[^\]]*\]\{[^}]*\}/g;

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

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!1:1` });
  const headers: string[] = headerRes.data.values?.[0] ?? [];
  const titleIdx = findCol(headers, 'Title');
  const descIdx = findCol(headers, 'Description');
  const contentIdx = findCol(headers, 'Blog Content');

  const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:ZZ` });
  const rows: string[][] = dataRes.data.values ?? [];

  const updates: { range: string; values: string[][] }[] = [];
  let fixed = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sheetRow = i + 1;

    for (const idx of [titleIdx, descIdx, contentIdx]) {
      if (idx === -1) continue;
      const val = row[idx] ?? '';
      if (!ARTIFACT_RE.test(val)) continue;
      ARTIFACT_RE.lastIndex = 0; // reset — test() with /g advances lastIndex
      const cleaned = val.replace(ARTIFACT_RE, '').trim();
      updates.push({ range: `${SHEET_NAME}!${colToLetter(idx)}${sheetRow}`, values: [[cleaned]] });
    }
    if (updates.length > 0 && updates[updates.length - 1].range.endsWith(String(sheetRow))) {
      // count each row once even if multiple columns matched
    }
  }

  // Dedup row count for logging (count distinct rows touched, not cell updates)
  const touchedRows = new Set(updates.map(u => u.range.match(/\d+$/)?.[0]));
  fixed = touchedRows.size;

  console.log(`${fixed} row(s) had citation artifacts — ${updates.length} cell(s) to clean.`);
  if (updates.length === 0) {
    console.log('Nothing to clean.');
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: updates },
  });
  console.log(`✅ Cleaned ${updates.length} cell(s) across ${fixed} row(s).`);
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
