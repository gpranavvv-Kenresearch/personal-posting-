/**
 * sheets.ts — Google Sheets Integration (Unified Single Tab)
 * All platforms (X, Facebook, LinkedIn) in one "insta" tab.
 *
 * Auth: Google Service Account JSON
 * Place your service account JSON at: .accounts/google-service-account.json
 * OR set GOOGLE_SERVICE_ACCOUNT_JSON env var with the JSON string
 */

import { google } from 'googleapis';
import 'dotenv/config';

const SHEET_ID   = '1DFYIv9fAItnLYOeiTsnhTR5WYiJgCk1aXFqykg0Qkus';
const SHEET_NAME = 'insta'; // unified tab — replaces X Sheet / FB Sheet / Linkedin Post

export interface SheetRow {
  rowIndex: number;       // 1-based row index in sheet (for updates)
  title: string;
  targetUrl: string;
  marketValue: string;
  cagr?: string;          // extracted by reportDataAgent (e.g. "12.5% CAGR")
  batch: number;
  date: string;
  name: string;           // account nickname/handle to post from
  // SEO analysis columns (written by seoAgent before posting)
  seoIndexed?: string;    // 'yes' | 'no'
  seoPage?: string;       // '1' | '2' | ... | '10+'
  seoKeywords?: string;   // comma-separated trending keywords
  platforms?: string;     // 'x' | 'x,facebook' | 'x,facebook,linkedin' etc.
  // X columns
  xPost?: string;
  xPostUrl?: string;
  xStatus?: string;
  xError?: string;
  // Facebook columns
  fbPost?: string;
  fbPostUrl?: string;
  fbStatus?: string;
  fbError?: string;
  // LinkedIn columns
  linkedinPost?: string;
  linkedinPostUrl?: string;
  linkedinStatus?: string;
  linkedinError?: string;
}

// Backwards-compatible alias used by facebookPostingAgent and linkedinPostingAgent
export type SocialSheetRow = SheetRow;

// ── Auth ───────────────────────────────────────────────────────────────────

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

// ── Column map (0-indexed, header-row-driven) ──────────────────────────────

interface ColMap {
  [key: string]: number;
}

async function getColumnMap(sheets: any): Promise<ColMap> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!1:1`,
  });
  const headers: string[] = res.data.values?.[0] ?? [];
  const map: ColMap = {};
  headers.forEach((h, i) => {
    const trimmed = h.trim();
    map[trimmed] = i;
    map[trimmed.toLowerCase()] = i;
  });
  return map;
}

// ── Helper: pick first defined column index from multiple name variants ────

function col(colMap: ColMap, ...names: string[]): number | undefined {
  for (const n of names) {
    if (colMap[n] !== undefined) return colMap[n];
    if (colMap[n.toLowerCase()] !== undefined) return colMap[n.toLowerCase()];
  }
  return undefined;
}

// ── Read today's rows for a batch ──────────────────────────────────────────

export async function getTodaysBatchRows(batch: number): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0]; // yyyy-MM-dd

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  });

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowDate  = row[col(colMap, 'date') ?? -1]  ?? '';
    const rowBatch = Number(row[col(colMap, 'batch') ?? -1] ?? -1);

    if (rowDate !== today || rowBatch !== batch) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  if (results.length === 0) {
    const origHeaders = Object.keys(colMap).filter(k => k === k.trim() && k !== k.toLowerCase());
    console.log(`   ⚠️  Sheet headers found: ${origHeaders.join(', ')}`);
  }
  console.log(`   📋 Found ${results.length} rows for batch ${batch} on ${today}`);
  return results;
}

// ── Map raw sheet row to SheetRow interface ────────────────────────────────

function mapRow(row: string[], colMap: ColMap, rowIndex: number): SheetRow {
  const g = (colMap: ColMap, ...names: string[]) => {
    const idx = col(colMap, ...names);
    return idx !== undefined ? (row[idx] ?? '') : '';
  };

  return {
    rowIndex,
    title:          g(colMap, 'title'),
    targetUrl:      g(colMap, 'targetUrl', 'targeturl'),
    marketValue:    g(colMap, 'market_value', 'market_value '),
    batch:          Number(g(colMap, 'batch') || -1),
    date:           g(colMap, 'date'),
    name:           g(colMap, 'Name', 'name'),
    // SEO columns
    seoIndexed:     g(colMap, 'seoIndexed', 'seoindexed'),
    seoPage:        g(colMap, 'seoPage', 'seopage'),
    seoKeywords:    g(colMap, 'seoKeywords', 'seokeywords'),
    platforms:      g(colMap, 'platforms'),
    // X columns
    xPost:          g(colMap, 'X Post', 'x post'),
    xPostUrl:       g(colMap, 'X Post URL', 'x post url'),
    xStatus:        g(colMap, 'X Status', 'x status'),
    xError:         g(colMap, 'X Error', 'x error'),
    // Facebook columns
    fbPost:         g(colMap, 'FB Post', 'fb post'),
    fbPostUrl:      g(colMap, 'FB Post URL', 'fb post url'),
    fbStatus:       g(colMap, 'FB Status', 'fb status'),
    fbError:        g(colMap, 'FB Error', 'fb error'),
    // LinkedIn columns
    linkedinPost:    g(colMap, 'LinkedIn Post', 'linkedin post'),
    linkedinPostUrl: g(colMap, 'LinkedIn Post URL', 'linkedin post url'),
    linkedinStatus:  g(colMap, 'LinkedIn Status', 'linkedin status'),
    linkedinError:   g(colMap, 'LinkedIn Error', 'linkedin error'),
  };
}

// ── Write generated tweet back to sheet ────────────────────────────────────

export async function saveGeneratedTweet(row: SheetRow, xPost: string): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const colIdx = col(colMap, 'X Post', 'x post');
  if (colIdx === undefined) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${colToLetter(colIdx)}${row.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[xPost]] },
  });
}

// ── Write X posting result back to sheet ──────────────────────────────────

export async function savePostingResult(
  row: SheetRow,
  result: {
    xPostUrl: string;
    xStatus: string;
    xError?: string;
    xPost?: string;
    seoScore?: number;
    sanityIssues?: string[];
    messageStatus?: string;
  }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['X Post',          'x post'],           value: result.xPost ?? '' },
    { names: ['X Post URL',      'x post url'],        value: result.xPostUrl },
    { names: ['X Status',        'x status'],          value: result.xStatus },
    { names: ['X Error',         'x error'],           value: result.xError ?? '' },
    { names: ['SEO Score',       'seo score'],         value: result.seoScore != null ? String(result.seoScore) : '' },
    { names: ['Sanity Issues',   'sanity issues'],     value: result.sanityIssues?.join(' | ') ?? '' },
    { names: ['Message Status',  'message status'],    value: result.messageStatus ?? '' },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 Sheet updated for row ${row.rowIndex}: ${result.xStatus}`);
}

// ── Write SEO analysis data to sheet ──────────────────────────────────────

export async function saveUnifiedSeoData(
  row: SheetRow,
  seoData: { indexStatus: string; rankPage: number; keywords: string[]; platforms: string[] }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const pageStr = seoData.rankPage >= 10 ? '10+' : String(seoData.rankPage);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['seoIndexed', 'seoindexed'], value: seoData.indexStatus === 'indexed' ? 'yes' : 'no' },
    { names: ['seoPage',    'seopage'],    value: pageStr },
    { names: ['seoKeywords','seokeywords'],value: seoData.keywords.join(', ') },
    { names: ['platforms'],                value: seoData.platforms.join(',') },
  ]);

  await batchWrite(sheets, data);
}

// ── Write Facebook posting result to unified sheet ─────────────────────────

export async function saveUnifiedFbResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['FB Post',     'fb post'],     value: result.post    },
    { names: ['FB Post URL', 'fb post url'], value: result.postUrl },
    { names: ['FB Status',   'fb status'],   value: result.status  },
    { names: ['FB Error',    'fb error'],    value: result.error ?? '' },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 FB updated for row ${row.rowIndex}: ${result.status}`);
}

// ── Write LinkedIn posting result to unified sheet ─────────────────────────

export async function saveUnifiedLinkedInResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['LinkedIn Post',     'linkedin post'],     value: result.post    },
    { names: ['LinkedIn Post URL', 'linkedin post url'], value: result.postUrl },
    { names: ['LinkedIn Status',   'linkedin status'],   value: result.status  },
    { names: ['LinkedIn Error',    'linkedin error'],    value: result.error ?? '' },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 LinkedIn updated for row ${row.rowIndex}: ${result.status}`);
}

// ── Write sanity issues back to sheet ────────────────────────────────────

export async function saveSanityResult(row: SheetRow, issues: string): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const colIdx = col(colMap, 'Sanity Issues', 'sanity issues');
  if (colIdx === undefined) {
    console.warn('   ⚠️  "Sanity Issues" column not found — skipping');
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${colToLetter(colIdx)}${row.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[issues]] },
  });
}

// ── Write SEO score back to sheet ─────────────────────────────────────────

export async function saveSeoScore(row: SheetRow, score: number): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const colIdx = col(colMap, 'SEO Score', 'seo score');
  if (colIdx === undefined) {
    console.warn('   ⚠️  "SEO Score" column not found — skipping');
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${colToLetter(colIdx)}${row.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[String(score)]] },
  });
}

// ── Scan entire sheet for leftover rows (all platforms unposted) ──────────
// A row is leftover when title+url are present but ALL platform statuses are empty.

export async function getAllLeftoverRows(): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  });

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title     = row[col(colMap, 'title') ?? -1]              ?? '';
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const xStatus   = row[col(colMap, 'X Status', 'x status') ?? -1]  ?? '';
    const fbStatus  = row[col(colMap, 'FB Status', 'fb status') ?? -1] ?? '';
    const liStatus  = row[col(colMap, 'LinkedIn Status', 'linkedin status') ?? -1] ?? '';

    if (!title.trim() || !targetUrl.trim()) continue;
    // Only leftover if ALL three platforms are unposted
    if (xStatus.trim() || fbStatus.trim() || liStatus.trim()) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📋 Found ${results.length} leftover rows (all platforms unposted)`);
  return results;
}

// ── Read rows across a date range (for unprocessed detection) ─────────────

export async function getAllRowsInDateRange(dates: string[]): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  });

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowDate   = row[col(colMap, 'date') ?? -1]                 ?? '';
    const rowStatus = row[col(colMap, 'X Status', 'x status') ?? -1] ?? '';

    if (!dates.includes(rowDate)) continue;
    if (rowStatus && rowStatus.trim() !== '') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📋 Found ${results.length} unprocessed rows for dates: ${dates.join(', ')}`);
  return results;
}

// ── Batch append leftover rows at the bottom of the sheet ─────────────────

export async function appendLeftoverRowsBatch(
  rows: Array<{ title: string; targetUrl: string }>
): Promise<void> {
  if (rows.length === 0) return;

  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const titleIdx     = col(colMap, 'title');
  const targetUrlIdx = col(colMap, 'targetUrl', 'targeturl');

  if (titleIdx === undefined || targetUrlIdx === undefined) {
    throw new Error('Cannot find "title" or "targetUrl" columns in sheet header');
  }

  const allSheetData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  });
  const lastRow = (allSheetData.data.values ?? []).length;

  const maxCol = Math.max(titleIdx, targetUrlIdx) + 1;
  const values = rows.map(r => {
    const newRow: string[] = Array(maxCol).fill('');
    newRow[titleIdx]     = r.title;
    newRow[targetUrlIdx] = r.targetUrl;
    return newRow;
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${lastRow + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

// ── Batch DELETE entire original rows ─────────────────────────────────────

export async function deleteLeftoverOriginalRowsBatch(rowIndices: number[]): Promise<void> {
  if (rowIndices.length === 0) return;

  const sheets = await getSheetsClient();

  const metaRes = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties',
  });
  const sheetMeta = metaRes.data.sheets?.find((s: any) => s.properties?.title === SHEET_NAME);
  if (!sheetMeta) throw new Error(`Sheet "${SHEET_NAME}" not found in spreadsheet`);
  const sheetGid: number = sheetMeta.properties!.sheetId ?? 0;

  const sorted = [...rowIndices].sort((a, b) => b - a);

  const requests = sorted.map(rowIndex => ({
    deleteDimension: {
      range: {
        sheetId:    sheetGid,
        dimension:  'ROWS',
        startIndex: rowIndex - 1,
        endIndex:   rowIndex,
      },
    },
  }));

  const CHUNK = 500;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: requests.slice(i, i + CHUNK) },
    });
  }
}

// ── Read unassigned rows (name/batch/date empty, URL+title present) ────────

export interface UnassignedRow {
  rowIndex: number;
  title: string;
  targetUrl: string;
  marketValue: string;
  name: string;   // pre-filled account name (may be empty — distributionAgent will assign)
}

export async function getUnassignedRows(): Promise<UnassignedRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  });
  const rows: string[][] = dataRes.data.values ?? [];
  const results: UnassignedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title     = row[col(colMap, 'title') ?? -1]              ?? '';
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const name      = row[col(colMap, 'Name', 'name') ?? -1]       ?? '';
    const batch     = row[col(colMap, 'batch') ?? -1]              ?? '';
    const date      = row[col(colMap, 'date') ?? -1]               ?? '';
    const seoScore  = row[col(colMap, 'SEO Score', 'seo score', 'seoscore') ?? -1] ?? '';

    if (!targetUrl.trim()) continue;  // must have a URL to post
    if (seoScore.trim()) continue;   // SEO Score filled = already processed, skip

    results.push({
      rowIndex: i + 1,
      title,
      targetUrl,
      marketValue: row[col(colMap, 'market_value', 'market_value ') ?? -1] ?? '',
      name,
    });
  }

  console.log(`   📋 Found ${results.length} unassigned rows`);
  return results;
}

// Keep legacy aliases for backwards compatibility with distributionAgent
export const getUnassignedXRows = getUnassignedRows;

// ── Batch-assign name/batch/date back to sheet rows ───────────────────────

export interface RowAssignment {
  rowIndex: number;
  name: string;
  batch: number;
  date: string;
}

export async function assignRowsBatch(assignments: RowAssignment[]): Promise<void> {
  if (assignments.length === 0) return;
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const nameCol  = colToLetter(col(colMap, 'Name', 'name') ?? 0);
  const batchCol = colToLetter(col(colMap, 'batch') ?? 0);
  const dateCol  = colToLetter(col(colMap, 'date') ?? 0);

  const data = assignments.flatMap(a => [
    { range: `${SHEET_NAME}!${nameCol}${a.rowIndex}`,  values: [[a.name]] },
    { range: `${SHEET_NAME}!${batchCol}${a.rowIndex}`, values: [[String(a.batch)]] },
    { range: `${SHEET_NAME}!${dateCol}${a.rowIndex}`,  values: [[a.date]] },
  ]);

  const CHUNK = 500;
  for (let i = 0; i < data.length; i += CHUNK) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: data.slice(i, i + CHUNK) },
    });
  }
  console.log(`   ✅ Assigned ${assignments.length} rows`);
}

// Legacy aliases for distributionAgent
export const assignXRowsBatch  = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignFbRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignLiRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);

// ── Internal helpers ───────────────────────────────────────────────────────

function buildUpdates(
  colMap: ColMap,
  rowIndex: number,
  fields: { names: string[]; value: string }[]
): { range: string; values: string[][] }[] {
  return fields
    .map(f => ({ colIdx: col(colMap, ...f.names), value: f.value }))
    .filter(f => f.colIdx !== undefined)
    .map(f => ({
      range: `${SHEET_NAME}!${colToLetter(f.colIdx!)}${rowIndex}`,
      values: [[f.value]],
    }));
}

async function batchWrite(sheets: any, data: { range: string; values: string[][] }[]): Promise<void> {
  if (data.length === 0) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
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
