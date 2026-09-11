import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'fs';
import { uploadFileToDropbox } from '../utils/dropboxUpload.js';

const BLOG_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const BLOG_SHEET_NAME = 'Blogs';

interface PdfRow {
  rowIndex: number;
  title: string;
  pdfPath: string;
  dropboxPdfUrl: string;
}

async function getSheetsClient() {
  let credentials: object;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    const raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
    credentials = JSON.parse(raw);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

function buildColMap(headers: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = (h || '').trim();
    if (key) {
      map[key] = i;
      map[key.toLowerCase()] = i;
    }
  });
  return map;
}

function getCell(row: string[], colMap: Record<string, number>, ...names: string[]): string {
  for (const name of names) {
    const idx = colMap[name] ?? colMap[name.toLowerCase()];
    if (idx !== undefined) return (row[idx] ?? '').trim();
  }
  return '';
}

async function getRowsPendingDropboxUpload(targetRow?: number): Promise<{
  rows: PdfRow[];
  dropboxUrlColIndex: number;
}> {
  const sheets = await getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  });

  const allRows: string[][] = res.data.values ?? [];
  const headers = allRows[0] ?? [];
  const colMap = buildColMap(headers);

  const dropboxUrlColIndex =
    colMap['Dropbox PDF URL'] ??
    colMap['dropbox pdf url'] ??
    colMap['Dropbox URL'] ??
    colMap['dropbox url'];

  if (dropboxUrlColIndex === undefined) {
    throw new Error('Missing sheet column: Dropbox PDF URL');
  }

  const rows: PdfRow[] = [];

  for (let i = 1; i < allRows.length; i++) {
    const rowIndex = i + 1;
    if (targetRow && rowIndex !== targetRow) continue;

    const row = allRows[i];
    const title = getCell(row, colMap, 'Blog Title', 'Title', 'Main Title');
    const pdfPath = getCell(row, colMap, 'PDF Path', 'pdfPath', 'pdf path');
    const dropboxPdfUrl = getCell(row, colMap, 'Dropbox PDF URL', 'Dropbox URL');

    if (!pdfPath) continue;
    if (!targetRow && dropboxPdfUrl) continue;

    rows.push({
      rowIndex,
      title,
      pdfPath,
      dropboxPdfUrl,
    });
  }

  return { rows, dropboxUrlColIndex };
}

async function saveDropboxUrl(rowIndex: number, colIndex: number, url: string): Promise<void> {
  const sheets = await getSheetsClient();
  const colLetter = columnToLetter(colIndex + 1);

  await sheets.spreadsheets.values.update({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!${colLetter}${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[url]],
    },
  });
}

function columnToLetter(col: number): string {
  let temp = col;
  let letter = '';

  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - rem - 1) / 26);
  }

  return letter;
}

async function main() {
  const targetRow = process.argv[2] ? Number(process.argv[2]) : undefined;

  if (targetRow && (Number.isNaN(targetRow) || targetRow < 2)) {
    throw new Error(`Invalid row number: ${process.argv[2]}`);
  }

  const { rows, dropboxUrlColIndex } = await getRowsPendingDropboxUpload(targetRow);

  console.log(`Found ${rows.length} PDF row(s) pending Dropbox upload.`);

  let uploaded = 0;
  let failed = 0;

  for (const row of rows) {
    console.log(`\nRow ${row.rowIndex}: ${row.title || '(no title)'}`);
    console.log(`PDF Path: ${row.pdfPath}`);

    try {
      const result = await uploadFileToDropbox(row.pdfPath);
      await saveDropboxUrl(row.rowIndex, dropboxUrlColIndex, result.sharedUrl);

      console.log(`Uploaded: ${result.sharedUrl}`);
      uploaded++;
    } catch (err: any) {
      console.error(`Failed row ${row.rowIndex}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Uploaded: ${uploaded}, Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});