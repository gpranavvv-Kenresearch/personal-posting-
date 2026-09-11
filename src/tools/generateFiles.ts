// Run with: node --import=tsx src/tools/generateFiles.ts

import 'dotenv/config';
import { google } from 'googleapis';
import { htmlToPdf, makeSlug } from '../utils/contentConverter.js';
import { savePdfPath } from '../sheets/sheets.js';
import type { SheetRow } from '../sheets/sheets.js';

const BLOG_SHEET_ID   = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const BLOG_SHEET_NAME = 'Blogs';

// ──── Auth ──────────────────────────────────────────────────────────────────

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
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ──── Read all blog rows ─────────────────────────────────────────────────────

async function getAllBlogRows(): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();

  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!1:1`,
  });
  const headers: string[] = headerRes.data.values?.[0] ?? [];

  const colMap: Record<string, number> = {};
  headers.forEach((h, i) => {
    const trimmed = h.trim();
    colMap[trimmed] = i;
    colMap[trimmed.toLowerCase()] = i;
  });

  const g = (row: string[], ...names: string[]): string => {
    for (const n of names) {
      const idx = colMap[n] ?? colMap[n.toLowerCase()];
      if (idx !== undefined) return row[idx] ?? '';
    }
    return '';
  };

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  });
  const rows: string[][] = dataRes.data.values ?? [];

  const results: SheetRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const blogContent = g(row, 'Blog Content', 'blog content', 'Blog Content for all', 'blog content for all', 'blogcontent', 'Content', 'content');
    if (!blogContent.trim()) continue;

    results.push({
      rowIndex: i + 1,
      sheetType: 'blog',
      title:       g(row, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title'),
      targetUrl:   g(row, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl', 'URL', 'url'),
      marketValue: g(row, 'market_value', 'marketValue', 'market value'),
      batch:       Number(g(row, 'Batch', 'batch', 'S.No') || -1),
      date:        g(row, 'Date to Be Published', 'date to be published', 'date'),
      name:        g(row, 'Name', 'name'),
      blogContent,
      pdfPath:     g(row, 'PDF Path', 'pdf path', 'pdfPath'),
    } as SheetRow);
  }

  return results;
}

// ──── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // Optional: pass a specific row number as CLI arg, e.g. "node ... generateFiles.ts 2"
  const targetRow = process.argv[2] ? Number(process.argv[2]) : null;

  console.log('Reading blog rows from sheet...');
  const allRows = await getAllBlogRows();

  // Filter: has blogContent AND (specific row if requested, otherwise pdfPath is empty)
  const pending = targetRow
    ? allRows.filter(r => r.rowIndex === targetRow)
    : allRows.filter(r => r.blogContent && !r.pdfPath?.trim());
  const total = pending.length;

  console.log(`Found ${total} rows with blogContent but no PDF yet.\n`);

  if (total === 0) {
    console.log('Nothing to generate. All done!');
    return;
  }

  let generated = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const rowTitle = row.title || `Row ${row.rowIndex}`;
    console.log(`[${i + 1}/${total}] Generating files for: ${rowTitle}`);

    try {
      const slug = makeSlug(rowTitle);

      const pdfPath = await htmlToPdf(row.blogContent!, slug, row.rowIndex);

      await savePdfPath(row, pdfPath);

      console.log(`   PDF: ${pdfPath}`);
      generated++;
    } catch (err: any) {
      console.error(`   ERROR on row ${row.rowIndex} (${rowTitle}): ${err?.message ?? err}`);
      failed++;
    }
  }

  console.log(`\nDone. Generated: ${generated}, Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
