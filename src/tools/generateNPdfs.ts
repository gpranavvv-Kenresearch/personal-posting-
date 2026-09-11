/**
 * generateNPdfs.ts — generate N real PDFs from real New Logic rows that
 * don't already have a PDF Path, and write each path back. Generation +
 * sheet-write only — does NOT log into or post to any platform.
 *
 * Usage: npx tsx src/tools/generateNPdfs.ts <count>
 */
import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs';
import { htmlToPdf, makeSlug } from '../utils/contentConverter.js';

const NEW_LOGIC_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const NEW_LOGIC_SHEET_NAME = 'New Logic';

async function getSheetsClient() {
  const raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

function colToLetter(col: number): string {
  let letter = '';
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

async function main() {
  const count = parseInt(process.argv[2] || '5', 10);
  const sheets = await getSheetsClient();
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: NEW_LOGIC_SHEET_ID,
    range: `${NEW_LOGIC_SHEET_NAME}!1:1`,
  });
  const headers = (headerRes.data.values?.[0] ?? []).map(h => h.trim().toLowerCase());
  const colIdx = (names: string[]) => {
    for (const n of names) {
      const i = headers.indexOf(n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const contentIdx = colIdx(['Blog Content', 'blog content']);
  const titleIdx = colIdx(['Blog Title', 'Title', 'Main Title']);
  const pdfPathIdx = colIdx(['PDF Path', 'pdf path', 'pdfPath']);

  if (contentIdx < 0) { console.error('No "Blog Content" column found.'); process.exit(1); }
  if (pdfPathIdx < 0) { console.error('No "PDF Path" column found.'); process.exit(1); }

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: NEW_LOGIC_SHEET_ID,
    range: `${NEW_LOGIC_SHEET_NAME}!A:ZZ`,
  });
  const rows = dataRes.data.values ?? [];

  const candidates: { rowIndex: number; title: string; content: string }[] = [];
  for (let i = 1; i < rows.length && candidates.length < count; i++) {
    const row = rows[i];
    const content = (row[contentIdx] ?? '').trim();
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const existingPdfPath = (row[pdfPathIdx] ?? '').trim();
    if (content.length > 200 && title && !existingPdfPath) {
      candidates.push({ rowIndex: i + 1, title, content });
    }
  }

  console.log(`Found ${candidates.length} row(s) with real content and no existing PDF Path.\n`);

  const writeData: { range: string; values: string[][] }[] = [];
  for (const c of candidates) {
    console.log(`Row ${c.rowIndex}: "${c.title}"`);
    const pdfPath = await htmlToPdf(c.content, makeSlug(c.title), c.rowIndex);
    const stat = fs.statSync(pdfPath);
    console.log(`  ✅ PDF built (${(stat.size / 1024).toFixed(1)} KB): ${pdfPath}`);
    writeData.push({
      range: `${NEW_LOGIC_SHEET_NAME}!${colToLetter(pdfPathIdx)}${c.rowIndex}`,
      values: [[pdfPath]],
    });
  }

  if (writeData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: NEW_LOGIC_SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: writeData },
    });
    console.log(`\n✅ Wrote ${writeData.length} PDF Path value(s) back to the New Logic sheet.`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
