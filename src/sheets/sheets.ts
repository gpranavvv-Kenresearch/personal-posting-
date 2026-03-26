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
  rowIndex: number;         // 1-based row index in sheet (for updates)
  title: string;
  targetUrl: string;
  marketValue: string;      // fetched from Tavily at post time (not read from sheet)
  cagr?: string;            // fetched from report page (not read from sheet)
  batch: number;
  date: string;
  name: string;             // account nickname/handle to post from
  priority?: string;        // manual priority hint (e.g. 'high', 'low')
  lastPostedX?: string;     // last X post date
  lastPostedFb?: string;    // last FB post date
  lastPostedLi?: string;    // last LI post date
  // SEO analysis columns (written by seoAgent before posting)
  seoIndexed?: string;      // 'yes' | 'no'
  seoPage?: string;         // exact Google position e.g. '3', '55', '100+', 'N/A'
  seoKeywords?: string;     // comma-separated trending keywords
  seoRanking?: string;      // P1/P2/P3 priority based on ranking
  lastSerpCheckDate?: string; // When SERP was last checked (YYYY-MM-DD)
  priorityAssignedDate?: string; // When priority was assigned (YYYY-MM-DD)
  platforms?: string;       // 'x' | 'x,facebook' | 'x,facebook,linkedin' etc.
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
  // Result columns
  messageStatus?: string;
  sanityIssues?: string;
  seoScore?: string;
}

// Backwards-compatible alias used by facebookPostingAgent and linkedinPostingAgent
export type SocialSheetRow = SheetRow;

// ── Retry wrapper for quota errors ─────────────────────────────────────────
// Retries on "Quota exceeded" / "Resource has been exhausted" with exponential backoff.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRetry<T = any>(fn: () => Promise<T>, label = 'Sheets'): Promise<T> {
  const MAX_RETRIES = 5;
  let delay = 5000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      const isQuota =
        msg.includes('Quota exceeded') ||
        msg.includes('Resource has been exhausted') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('rateLimitExceeded') ||
        msg.includes('userRateLimitExceeded');
      if (isQuota && attempt < MAX_RETRIES) {
        const jitter = Math.random() * 1000;
        const wait = delay + jitter;
        console.warn(`   ⚠️  ${label} quota — waiting ${Math.round(wait / 1000)}s then retrying (${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, wait));
        delay = Math.min(delay * 2, 60_000);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}

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
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!1:1`,
  }), 'getColumnMap');
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

// ── Read rows for a batch (picks rows where column M is empty) ─────────────

export async function getTodaysBatchRows(batch: number): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getTodaysBatchRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowBatch = Number(row[col(colMap, 'batch') ?? -1] ?? -1);

    if (rowBatch !== batch) continue;

    // Skip rows that already have an X Status (already posted/attempted)
    const xStatusVal = row[col(colMap, 'X Status', 'x status') ?? -1] ?? '';
    if (xStatusVal.trim()) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  if (results.length === 0) {
    const origHeaders = Object.keys(colMap).filter(k => k === k.trim() && k !== k.toLowerCase());
    console.log(`   ⚠️  Sheet headers found: ${origHeaders.join(', ')}`);
  }
  console.log(`   📋 Found ${results.length} rows for batch ${batch}`);
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
    title:           g(colMap, 'title'),
    targetUrl:       g(colMap, 'targetUrl', 'targeturl'),
    marketValue:     '',  // fetched from Tavily at post time
    cagr:            undefined,  // fetched from report page at post time
    batch:           Number(g(colMap, 'batch') || -1),
    date:            g(colMap, 'date'),
    name:            g(colMap, 'Name', 'name'),
    priority:        g(colMap, 'priority'),
    lastPostedX:     g(colMap, 'lastPostedX', 'lastpostedx'),
    lastPostedFb:    g(colMap, 'lastPostedFb', 'lastpostedfb'),
    lastPostedLi:    g(colMap, 'lastPostedLi', 'lastpostedli'),
    // SEO columns
    seoIndexed:      g(colMap, 'seoIndexed', 'seoindexed'),
    seoPage:         g(colMap, 'seoPage', 'seopage'),
    seoKeywords:     g(colMap, 'seoKeywords', 'seokeywords'),
    platforms:       g(colMap, 'platforms'),
    // X columns
    xPost:           g(colMap, 'X Post', 'x post'),
    xPostUrl:        g(colMap, 'X Post URL', 'x post url'),
    xStatus:         g(colMap, 'X Status', 'x status'),
    xError:          g(colMap, 'X Error', 'x error'),
    // Facebook columns
    fbPost:          g(colMap, 'FB Post', 'fb post'),
    fbPostUrl:       g(colMap, 'FB Post URL', 'fb post url'),
    fbStatus:        g(colMap, 'FB Status', 'fb status'),
    fbError:         g(colMap, 'FB Error', 'fb error'),
    // LinkedIn columns
    linkedinPost:    g(colMap, 'LinkedIn Post', 'linkedin post'),
    linkedinPostUrl: g(colMap, 'LinkedIn Post URL', 'linkedin post url'),
    linkedinStatus:  g(colMap, 'LinkedIn Status', 'linkedin status'),
    linkedinError:   g(colMap, 'LinkedIn Error', 'linkedin error'),
    // Result columns
    messageStatus:   g(colMap, 'Message Status', 'message status'),
    sanityIssues:    g(colMap, 'Sanity Issues', 'sanity issues'),
    seoScore:        g(colMap, 'SEO Score', 'seo score'),
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
  seoData: { indexStatus: string; rankPage: number; rankPosition?: number; keywords: string[]; platforms: string[] }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const posStr = positionToString(seoData.rankPosition ?? -1, seoData.indexStatus);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['seoIndexed', 'seoindexed'], value: seoData.indexStatus === 'indexed' ? 'yes' : 'no' },
    { names: ['seoPage',    'seopage'],    value: posStr },
    { names: ['seoKeywords','seokeywords'],value: seoData.keywords.join(', ') },
    { names: ['platforms'],                value: seoData.platforms.join(',') },
  ]);

  await batchWrite(sheets, data);
}

// ── Bulk-write SEO data for many rows in a single API call ─────────────────
// Avoids quota exhaustion by reusing one client + colMap and sending all
// updates in chunks of 500 ranges (Sheets API limit per batchUpdate).

export async function saveBulkSeoData(
  entries: Array<{
    rowIndex: number;
    seoData: { indexStatus: string; rankPage: number; rankPosition?: number; keywords: string[]; platforms: string[] };
  }>
): Promise<void> {
  if (entries.length === 0) return;

  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const allUpdates: { range: string; values: string[][] }[] = [];

  for (const { rowIndex, seoData } of entries) {
    const posStr = positionToString(seoData.rankPosition ?? -1, seoData.indexStatus);
    const updates = buildUpdates(colMap, rowIndex, [
      { names: ['seoIndexed', 'seoindexed'], value: seoData.indexStatus === 'indexed' ? 'yes' : 'no' },
      { names: ['seoPage',    'seopage'],    value: posStr },
      { names: ['seoKeywords','seokeywords'],value: seoData.keywords.join(', ') },
      { names: ['platforms'],                value: seoData.platforms.join(',') },
    ]);
    allUpdates.push(...updates);
  }

  const CHUNK = 500;
  for (let i = 0; i < allUpdates.length; i += CHUNK) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: allUpdates.slice(i, i + CHUNK) },
    });
  }
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


// ── Read a single row by 1-based row index ─────────────────────────────────

export async function getRowByIndex(rowIndex: number): Promise<SheetRow | null> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${rowIndex}:AH${rowIndex}`,
  }), 'getRowByIndex');

  const rows: string[][] = res.data.values ?? [];
  if (rows.length === 0) return null;
  return mapRow(rows[0], colMap, rowIndex);
}

// ── Read rows across a date range (for unprocessed detection) ─────────────

export async function getAllRowsInDateRange(dates: string[]): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getAllRowsInDateRange');

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

// ── Read unassigned rows (name/batch/date empty, URL+title present) ────────

export interface UnassignedRow {
  rowIndex: number;
  title: string;
  targetUrl: string;
  name: string;
}

export async function getUnassignedRows(): Promise<UnassignedRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const dataRes = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getUnassignedRows');
  const rows: string[][] = dataRes.data.values ?? [];
  const results: UnassignedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title     = row[col(colMap, 'title') ?? -1]                   ?? '';
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1]  ?? '';
    const batch     = row[col(colMap, 'batch') ?? -1]                   ?? '';
    const date      = row[col(colMap, 'date') ?? -1]                    ?? '';

    // Must have URL + title
    if (!targetUrl.trim() || !title.trim()) continue;
    // Skip rows already assigned to a batch/date
    if (batch.trim() || date.trim()) continue;

    results.push({
      rowIndex: i + 1,
      title,
      targetUrl,
      name: row[col(colMap, 'Name', 'name') ?? -1] ?? '',
    });
  }

  console.log(`   📋 Found ${results.length} unassigned rows`);
  return results;
}

// ── Read leftover rows (assigned but unposted from before today) ──────────

export interface LeftoverRow {
  rowIndex: number;
  title: string;
  targetUrl: string;
}

export async function getLeftoverRows(today: string): Promise<LeftoverRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getLeftoverRows');

  const rows: string[][] = res.data.values ?? [];
  const results: LeftoverRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row     = rows[i];
    const title     = row[col(colMap, 'title') ?? -1]                  ?? '';
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const batch     = row[col(colMap, 'batch') ?? -1]                  ?? '';
    const date      = row[col(colMap, 'date') ?? -1]                   ?? '';
    const name      = row[col(colMap, 'Name', 'name') ?? -1]           ?? '';
    const xStatus   = row[col(colMap, 'X Status', 'x status') ?? -1]  ?? '';

    // Must have url + title
    if (!targetUrl.trim() || !title.trim()) continue;
    // Must have been assigned (has batch + date + name) — skip url-title-only rows
    if (!batch.trim() || !date.trim() || !name.trim()) continue;
    // Date must be before today
    if (date.trim() >= today) continue;
    // Must not have been posted
    if (xStatus.trim().toLowerCase() === 'posted') continue;

    results.push({ rowIndex: i + 1, title, targetUrl });
  }

  console.log(`   📋 Found ${results.length} leftover rows before ${today}`);
  return results;
}

// ── Append url+title rows to end of sheet (for leftover agent) ───────────

export async function appendRowsToSheet(rows: Array<{ title: string; targetUrl: string }>): Promise<void> {
  if (rows.length === 0) return;
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const titleIdx  = col(colMap, 'title');
  const urlIdx    = col(colMap, 'targetUrl', 'targeturl');
  if (titleIdx === undefined || urlIdx === undefined) {
    console.warn('   ⚠️  Cannot append rows — title or targetUrl column not found');
    return;
  }

  const maxCol = Math.max(titleIdx, urlIdx) + 1;
  const data = rows.map(r => {
    const arr = Array(maxCol).fill('');
    arr[titleIdx] = r.title;
    arr[urlIdx]   = r.targetUrl;
    return arr;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: data },
  });
  console.log(`   📝 Appended ${rows.length} leftover rows to end of sheet`);
}

// ── Read today's rows for FB/LI batches (filtered by platform eligibility) ─

export async function getFbPendingRowsForBatches(xBatches: number[], today: string): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getFbPendingRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row       = rows[i];
    const rowBatch  = Number(row[col(colMap, 'batch') ?? -1] ?? -1);
    const rowDate   = row[col(colMap, 'date') ?? -1]                        ?? '';
    const platforms = row[col(colMap, 'platforms') ?? -1]                   ?? '';
    const fbStatus  = row[col(colMap, 'FB Status', 'fb status') ?? -1]      ?? '';

    if (rowDate !== today) continue;
    if (!xBatches.includes(rowBatch)) continue;
    if (!platforms.includes('facebook')) continue;
    if (fbStatus.trim().toLowerCase() === 'posted') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  return results;
}

export async function getLiPendingRowsForBatches(xBatches: number[], today: string): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getLiPendingRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row           = rows[i];
    const rowBatch      = Number(row[col(colMap, 'batch') ?? -1] ?? -1);
    const rowDate       = row[col(colMap, 'date') ?? -1]                          ?? '';
    const platforms     = row[col(colMap, 'platforms') ?? -1]                     ?? '';
    const liStatus      = row[col(colMap, 'LinkedIn Status', 'linkedin status') ?? -1] ?? '';

    if (rowDate !== today) continue;
    if (!xBatches.includes(rowBatch)) continue;
    if (!platforms.includes('linkedin')) continue;
    if (liStatus.trim().toLowerCase() === 'posted') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  return results;
}

export const getUnassignedXRows = getUnassignedRows;

// ── Get all rows with a targetUrl and no X Status (pending posts) ──────────

export async function getPendingRows(): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getPendingRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row       = rows[i];
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const name      = row[col(colMap, 'Name', 'name') ?? -1]           ?? '';
    const xStatus   = row[col(colMap, 'X Status', 'x status') ?? -1]  ?? '';

    if (!targetUrl.trim()) continue;
    if (!name.trim()) continue;
    if (xStatus.trim().toLowerCase() === 'posted') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📋 Found ${results.length} pending rows`);
  return results;
}

// ── Continuous row picking for FB/LI (Week 2+ feature) ──────────────────────
// Picks rows sequentially without daily reset (rows 1-15, then 16-30, etc)

export async function getRowsWithoutFbUrl(startRowIndex: number, limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getRowsWithoutFbUrl');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];
  let count = 0;
  let currentRowIndex = 0;

  for (let i = 1; i < rows.length && count < limit; i++) {
    const row = rows[i];
    const fbPostUrl = row[col(colMap, 'FB Post URL', 'fb post url') ?? -1] ?? '';

    // Skip rows that already have fbPostUrl filled
    if (fbPostUrl.trim()) continue;

    currentRowIndex++;

    // Only include rows >= startRowIndex
    if (currentRowIndex < startRowIndex) continue;

    results.push(mapRow(row, colMap, i + 1));
    count++;
  }

  console.log(`   📋 FB: Found ${results.length} rows starting from index ${startRowIndex}`);
  return results;
}

export async function getRowsWithoutLiUrl(startRowIndex: number, limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AH`,
  }), 'getRowsWithoutLiUrl');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];
  let count = 0;
  let currentRowIndex = 0;

  for (let i = 1; i < rows.length && count < limit; i++) {
    const row = rows[i];
    const liPostUrl = row[col(colMap, 'LinkedIn Post URL', 'linkedin post url') ?? -1] ?? '';

    // Skip rows that already have liPostUrl filled
    if (liPostUrl.trim()) continue;

    currentRowIndex++;

    // Only include rows >= startRowIndex
    if (currentRowIndex < startRowIndex) continue;

    results.push(mapRow(row, colMap, i + 1));
    count++;
  }

  console.log(`   📋 LI: Found ${results.length} rows starting from index ${startRowIndex}`);
  return results;
}

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
    const chunk = data.slice(i, i + CHUNK);
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: chunk },
    }), 'assignRowsBatch');
  }
  console.log(`   ✅ Assigned ${assignments.length} rows`);
}

export const assignXRowsBatch  = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignFbRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignLiRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Converts exact rank position to a human-readable sheet value.
 *   rankPosition > 0  → "3"  (exact position on Google, e.g. 3rd result)
 *   rankPosition = 0  → "100+" (indexed but outside top 100)
 *   rankPosition = -1 → "N/A" (unknown / SerpAPI unavailable)
 */
function positionToString(rankPosition: number, indexStatus: string): string {
  if (rankPosition > 0)  return String(rankPosition);
  if (rankPosition === 0) return indexStatus === 'indexed' ? '100+' : 'N/A';
  return 'N/A';
}

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
  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  }), 'batchWrite');
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
