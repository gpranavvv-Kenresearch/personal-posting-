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

// ──── History-safe helpers ──────────────────────────────────────────────────

/** Appends newVal to existing cell with ' | ' separator. Skips if newVal empty or duplicate. */
function appendValue(existing: string | undefined, newVal: string): string {
  if (!newVal) return existing ?? '';
  const trimmed = (existing ?? '').trim();
  if (!trimmed) return newVal;
  const parts = trimmed.split(' | ');
  if (parts[parts.length - 1].trim() === newVal.trim()) return trimmed;
  return `${trimmed} | ${newVal}`;
}

/** Extracts most-recent date from a possibly-appended value like "2025-01-15 | 2025-01-16". */
function latestDate(value: string): string {
  const parts = value.split(' | ');
  return (parts[parts.length - 1] ?? '').split('T')[0].trim();
}

// Sheet configuration for different platform types
const SOCIAL_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'; // X, FB, LI
const SOCIAL_SHEET_NAME = 'Social Media';

const BLOG_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'; // Medium, Dev.to, Google Sites, Linkmate, LinkedIn Pulse
const BLOG_SHEET_NAME = 'Blogs';

// Helper to get sheet config based on platform
function getSheetConfig(platform?: 'social' | 'blog'): { id: string; name: string } {
  if (platform === 'blog') {
    return { id: BLOG_SHEET_ID, name: BLOG_SHEET_NAME };
  }
  return { id: SOCIAL_SHEET_ID, name: SOCIAL_SHEET_NAME }; // default to social
}

// Backwards-compatible default (for functions that don't specify)
const SHEET_ID   = SOCIAL_SHEET_ID;
const SHEET_NAME = SOCIAL_SHEET_NAME;

export type SheetType = 'social' | 'blog';

export interface SheetRow {
  rowIndex: number;         // 1-based row index in sheet (for updates)
  sheetType?: SheetType;
  title: string;
  seedKeyword?: string;     // keyword for hashtags/SEO (e.g., "logistics", "robotics")
  descriptionTitle?: string; // alternative/meta description title for blogs
  description?: string;      // SEO description / article description
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
  lastPostedMedium?: string;    // last Medium post date
  lastPostedLinkmate?: string;  // last Linkmate post date
  // SEO analysis columns (written by seoAgent before posting)
  seoIndexed?: string;      // 'yes' | 'no'
  seoPage?: string;         // exact Google position e.g. '3', '55', '100+', 'N/A'
  seoKeywords?: string;     // comma-separated trending keywords
  seoRanking?: string;      // P1/P2/P3 priority based on ranking
  lastSerpCheckDate?: string; // When SERP was last checked (YYYY-MM-DD)
  priorityAssignedDate?: string; // When priority was assigned (YYYY-MM-DD)
  platforms?: string;       // 'x' | 'x,facebook' | 'x,facebook,linkedin' etc.
  // Unified content column
  blogContent?: string;     // HTML content for Medium, Linkmate, Google Sites
  // X columns
  xThread?: string;         // if non-empty → post as thread instead of single tweet
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
  // Medium columns
  mediumPost?: string;
  mediumPostUrl?: string;
  mediumStatus?: string;
  mediumError?: string;
  // Linkmate columns
  linkMateContent?: string;
  linkMatePostUrl?: string;
  linkMateStatus?: string;
  linkMateError?: string;
  // Google Sites columns
  googleSitePost?: string;
  googleSitePostUrl?: string;
  googleSiteStatus?: string;
  googleSiteError?: string;
  // Result columns
  messageStatus?: string;
  sanityIssues?: string;
  seoScore?: string;
  // Batch tracking columns (written after each post)
  xBatch?: string;        // "Batch 1" ... "Batch 13"
  fbBatch?: string;       // "Batch 1" ... "Batch 5"
  liBatch?: string;       // "Batch 1" ... "Batch 3"
  mediumBatch?: string;      // "Batch 1" ... Medium batches (max 1/day)
  linkmateBatch?: string;    // "Batch 1" ... Linkmate batches (max 3/day)
  googleSiteBatch?: string;  // "Batch 1" ... Google Sites batches
  lastPostedGoogleSite?: string; // last Google Sites post date
  // Dev.to columns
  devtoPostUrl?: string;
  devtoStatus?: string;
  devtoError?: string;
  devtoBatch?: string;
  lastPostedDevto?: string; // last Dev.to post date
  // LinkedIn Pulse columns
  linkedinPulsePostUrl?: string;
  linkedinPulseStatus?: string;
  linkedinPulseError?: string;
  linkedinPulseBatch?: string;
  lastPostedLinkedinPulse?: string; // last LinkedIn Pulse post date
  // Calisthenics columns
  calisthenicsPostUrl?: string;
  calisthenicsStatus?: string;
  calisthenicsError?: string;
  calisthenicsNBatch?: string;
  lastPostedCalisthenics?: string; // last Calisthenics post date
  // Substack columns
  substackPostUrl?: string;
  substackStatus?: string;
  substackError?: string;
  substackBatch?: string;
  lastPostedSubstack?: string; // last Substack post date
  // Guffiz columns
  guffizPostUrl?: string;
  guffizStatus?: string;
  guffizError?: string;
  guffizBatch?: string;
  lastPostedGuffiz?: string; // last Guffiz post date
  // HackMD columns
  hackmdPostUrl?: string;
  hackmdStatus?: string;
  hackmdError?: string;
  hackmdBatch?: string;
  lastPostedHackmd?: string; // last HackMD post date
  // WordPress columns
  wordpressPostUrl?: string;
  wordpressStatus?: string;
  wordpressError?: string;
  wordpressBatch?: string;
  lastPostedWordpress?: string;
  // Blogger columns
  bloggerPostUrl?: string;
  bloggerStatus?: string;
  bloggerError?: string;
  bloggerBatch?: string;
  lastPostedBlogger?: string;
  // Penzu columns
  penzuPostUrl?: string;
  penzuStatus?: string;
  penzuError?: string;
  penzuBatch?: string;
  lastPostedPenzu?: string;
  // WriteupCafe columns
  writeupcafePostUrl?: string;
  writeupcafeStatus?: string;
  writeupcafeError?: string;
  writeupcafeBatch?: string;
  lastPostedWriteupcafe?: string;
}

// Backwards-compatible alias used by facebookPostingAgent and linkedinPostingAgent
export type SocialSheetRow = SheetRow;

// ──── Retry wrapper for quota errors ─────────────────────────────────────
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

// ──── Auth ──────────────────────────────────────────────────────────────

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

// ──── Column map (0-indexed, header-row-driven) ──────────────────────────

interface ColMap {
  [key: string]: number;
}

async function getColumnMap(sheets: any, sheetId: string = SHEET_ID, sheetName: string = SHEET_NAME): Promise<ColMap> {
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!1:1`,
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

// ──── Helper: pick first defined column index from multiple name variants ────

function col(colMap: ColMap, ...names: string[]): number | undefined {
  for (const n of names) {
    if (colMap[n] !== undefined) return colMap[n];
    if (colMap[n.toLowerCase()] !== undefined) return colMap[n.toLowerCase()];
  }
  return undefined;
}

// ──── Read rows for a batch (picks rows where column M is empty) ──────────

export async function getTodaysBatchRows(batch: number): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
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
  console.log(`   📄 Found ${results.length} rows for batch ${batch}`);
  return results;
}

// ──── Map raw sheet row to SheetRow interface ───────────────────────────

function mapRow(row: string[], colMap: ColMap, rowIndex: number, sheetType: SheetType = 'social'): SheetRow {
  const g = (colMap: ColMap, ...names: string[]) => {
    const idx = col(colMap, ...names);
    return idx !== undefined ? (row[idx] ?? '') : '';
  };

  return {
    rowIndex,
    sheetType,
    title:           g(colMap, 'Title', 'title', 'Main Title'),
    seedKeyword:     g(colMap, 'Seed Keyword', 'seed keyword', 'seedKeyword'),
    descriptionTitle: g(colMap, 'Title', 'title', 'Main Title'),
    description: g(colMap, 'Description', 'description'),
    targetUrl:       g(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'targetUrl', 'targeturl', 'URL', 'url'),
    marketValue:     g(colMap, 'market_value', 'marketValue', 'market value'),
    cagr:            g(colMap, 'cagr') || undefined,
    batch:           Number(g(colMap, 'S.No', 'batch') || -1),
    date:            g(colMap, 'date'),
    name:            g(colMap, 'Name', 'name'),
    priority:        g(colMap, 'priority', 'seoRanking', 'seoranking'),
    lastPostedX:     g(colMap, 'lastPostedX', 'lastpostedx'),
    lastPostedFb:    g(colMap, 'lastPostedFb', 'lastpostedfb'),
    lastPostedLi:    g(colMap, 'lastPostedLi', 'lastpostedli'),
    // SEO columns
    seoIndexed:      g(colMap, 'seoIndexed', 'seoindexed'),
    seoPage:         g(colMap, 'seoPage', 'seopage'),
    seoKeywords:     g(colMap, 'seoKeywords', 'seokeywords'),
    seoRanking:      g(colMap, 'seoRanking', 'seoranking', 'priority'),
    lastSerpCheckDate: g(colMap, 'lastSerpCheckDate', 'last serp check date'),
    priorityAssignedDate: g(colMap, 'priorityAssignedDate', 'priority assigned date'),
    platforms:       g(colMap, 'platforms'),
    // Unified content column
    blogContent:     g(colMap, 'Content', 'content', 'Blog Content for all', 'blog content for all', 'blogcontent', 'Blog Content', 'blog content'),
    // X columns
    xThread:         g(colMap, 'X Thread', 'x thread', 'xThread', 'Thread'),
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
    // Medium columns
    mediumPost:      g(colMap, 'Medium Post', 'medium post'),
    mediumPostUrl:   g(colMap, 'Medium Post URL', 'medium post url'),
    mediumStatus:    g(colMap, 'Medium Status', 'medium status'),
    mediumError:     g(colMap, 'Medium Error', 'medium error'),
    mediumBatch:     g(colMap, 'mediumBatch', 'medium batch', 'Medium Batch'),
    lastPostedMedium: g(colMap, 'lastPostedMedium', 'lastpostedmedium'),
    // Linkmate columns
    linkMateContent: g(colMap, 'Linkmate Content', 'linkmate content'),
    linkMatePostUrl: g(colMap, 'Linkmate Post URL', 'linkmate post url'),
    linkMateStatus:  g(colMap, 'Linkmate Status', 'linkmate status'),
    linkMateError:   g(colMap, 'Linkmate Error', 'linkmate error'),
    linkmateBatch:   g(colMap, 'linkmateBatch', 'linkmate batch', 'Linkmate Batch'),
    lastPostedLinkmate: g(colMap, 'lastPostedLinkmate', 'lastpostedlinkmate'),
    // Google Sites columns
    googleSitePostUrl:   g(colMap, 'Google Site Post URL', 'google site post url'),
    googleSiteStatus:    g(colMap, 'Google Site Status', 'google site status'),
    googleSiteError:     g(colMap, 'Google Site Error', 'google site error'),
    googleSiteBatch:     g(colMap, 'GoogleSite Batch', 'googleSiteBatch', 'google site batch', 'Google Site Batch', 'googlesite batch'),
    lastPostedGoogleSite: g(colMap, 'lastPostedGoogleSite', 'lastpostedgooglesite'),
    // Dev.to columns
    devtoPostUrl:    g(colMap, 'Dev.to Post URL', 'dev.to post url'),
    devtoStatus:     g(colMap, 'Dev.to Status', 'dev.to status'),
    devtoError:      g(colMap, 'Dev.to Error', 'dev.to error'),
    devtoBatch:      g(colMap, 'Devto Batch', 'devtoBatch', 'dev.to batch', 'Dev.to Batch', 'devto batch'),
    lastPostedDevto: g(colMap, 'lastPostedDevto', 'lastposteddevto'),
    // LinkedIn Pulse columns
    linkedinPulsePostUrl:    g(colMap, 'Linkedin Pulse URL', 'LinkedIn Pulse Post URL', 'linkedin pulse post url', 'linkedin pulse url'),
    linkedinPulseStatus:     g(colMap, 'LinkedIn Pulse Status', 'linkedin pulse status'),
    linkedinPulseError:      g(colMap, 'LinkedIn Pulse Error', 'linkedin pulse error'),
    linkedinPulseBatch:      g(colMap, 'linkedinPulseBatch', 'linkedin pulse batch', 'LinkedIn Pulse Batch'),
    lastPostedLinkedinPulse: g(colMap, 'lastPosted linkedin Pulse', 'lastPostedLinkedinPulse', 'lastpostedlinkedinpulse'),
    // Calisthenics columns
    calisthenicsPostUrl: g(colMap, 'Calisthenics Post URL', 'calisthenics post url'),
    calisthenicsStatus:  g(colMap, 'Calisthenics Status', 'calisthenics status'),
    calisthenicsError:   g(colMap, 'Calisthenics Error', 'calisthenics error'),
    calisthenicsNBatch:  g(colMap, 'calisthenicsNBatch', 'calisthenics batch', 'Calisthenics Batch'),
    lastPostedCalisthenics: g(colMap, 'lastPostedCalisthenics', 'lastpostedcalisthenics'),
    // Substack columns
    substackPostUrl: g(colMap, 'Substack Post URL', 'substack post url'),
    substackStatus:  g(colMap, 'Substack Status', 'substack status'),
    substackError:   g(colMap, 'Substack  Error', 'Substack Error', 'substack  error', 'substack error'),
    substackBatch:   g(colMap, 'substackBatch', 'substack batch', 'Substack Batch'),
    lastPostedSubstack: g(colMap, 'lastPostedSubstack', 'lastpostedsubstack'),
    // Guffiz columns
    guffizPostUrl: g(colMap, 'Guffiz Post URL', 'guffiz post url'),
    guffizStatus:  g(colMap, 'Guffiz Status', 'guffiz status'),
    guffizError:   g(colMap, 'Guffiz Error', 'guffiz error'),
    guffizBatch:   g(colMap, 'guffizBatch', 'guffiz batch', 'Guffiz Batch'),
    lastPostedGuffiz: g(colMap, 'lastPostedGuffiz', 'lastpostedguffiz'),
    // HackMD columns
    hackmdPostUrl: g(colMap, 'HackMD Post URL', 'hackmd post url'),
    hackmdStatus:  g(colMap, 'HackMD Status', 'hackmd status'),
    hackmdError:   g(colMap, 'HackMD Error', 'hackmd error'),
    hackmdBatch:   g(colMap, 'hackmdBatch', 'hackmd batch', 'HackMD Batch'),
    lastPostedHackmd: g(colMap, 'lastPostedHackmd', 'lastpostedhackmd'),
    // WordPress columns
    wordpressPostUrl: g(colMap, 'WordPress Post URL', 'wordpress post url'),
    wordpressStatus:  g(colMap, 'WordPress Status', 'wordpress status'),
    wordpressError:   g(colMap, 'WordPress Error', 'wordpress error'),
    wordpressBatch:   g(colMap, 'wordpressBatch', 'wordpress batch', 'WordPress Batch'),
    lastPostedWordpress: g(colMap, 'lastPostedWordpress', 'lastpostedwordpress'),
    // Blogger columns
    bloggerPostUrl: g(colMap, 'Blogger Post URL', 'blogger post url'),
    bloggerStatus:  g(colMap, 'Blogger Status', 'blogger status'),
    bloggerError:   g(colMap, 'Blogger Error', 'blogger error'),
    bloggerBatch:   g(colMap, 'bloggerBatch', 'blogger batch', 'Blogger Batch'),
    lastPostedBlogger: g(colMap, 'Last Posted Blogger', 'lastPostedBlogger', 'lastpostedblogger'),
    // Penzu columns
    penzuPostUrl: g(colMap, 'Penzu Post URL', 'penzu post url'),
    penzuStatus:  g(colMap, 'Penzu Status', 'penzu status'),
    penzuError:   g(colMap, 'Penzu Error', 'penzu error'),
    penzuBatch:   g(colMap, 'penzuBatch', 'penzu batch', 'Penzu Batch'),
    lastPostedPenzu: g(colMap, 'Last Posted Penzu', 'lastPostedPenzu', 'lastpostedpenzu'),
    // WriteupCafe columns
    writeupcafePostUrl: g(colMap, 'WriteupCafe Post URL', 'writeupcafe post url'),
    writeupcafeStatus:  g(colMap, 'WriteupCafe Status', 'writeupcafe status'),
    writeupcafeError:   g(colMap, 'WriteupCafe Error', 'writeupcafe error'),
    writeupcafeBatch:   g(colMap, 'writeupcafeBatch', 'writeupcafe batch', 'WriteupCafe Batch'),
    lastPostedWriteupcafe: g(colMap, 'Last Posted WriteupCafe', 'lastPostedWriteupcafe', 'lastpostedwriteupcafe'),
    // Result columns
    messageStatus:   g(colMap, 'Message Status', 'message status'),
    sanityIssues:    g(colMap, 'Sanity Issues', 'sanity issues'),
    seoScore:        g(colMap, 'SEO Score', 'seo score'),
  };
}

// ──── Write generated tweet back to sheet ───────────────────────────────

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

// ──── Write X posting result back to sheet ──────────────────────────────

export async function savePostingResult(
  row: { rowIndex: number },
  result: {
    xPostUrl: string;
    xStatus: string;
    xError?: string;
    xPost?: string;
    seoScore?: number;
    sanityIssues?: string[];
    messageStatus?: string;
    xBatch?: string;
  }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0];
  const existing = await getRowByIndex(row.rowIndex);
  const newUrl = appendValue(existing?.xPostUrl, result.xPostUrl);
  const newLastPosted = result.xStatus?.toLowerCase() === 'posted'
    ? appendValue(existing?.lastPostedX, today)
    : (existing?.lastPostedX ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['X Post',          'x post'],               value: result.xPost ?? '' },
    { names: ['X Post URL',      'x post url'],            value: newUrl },
    { names: ['X Status',        'x status'],              value: result.xStatus },
    { names: ['X Error',         'x error'],               value: result.xError ?? '' },
    { names: ['SEO Score',       'seo score'],             value: result.seoScore != null ? String(result.seoScore) : '' },
    { names: ['Sanity Issues',   'sanity issues'],         value: result.sanityIssues?.join(' | ') ?? '' },
    { names: ['Message Status',  'message status'],        value: result.messageStatus ?? '' },
    { names: ['xBatch',          'x batch',   'X Batch'], value: result.xBatch ?? '' },
    { names: ['lastPostedX',     'lastpostedx'],           value: newLastPosted },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 Sheet updated for row ${row.rowIndex}: ${result.xStatus}`);
}

// ──── Write SEO analysis data to sheet ──────────────────────────────────

export async function saveUnifiedSeoData(
  row: { rowIndex: number; sheetType?: SheetType },
  seoData: { indexStatus: string; rankPage: number; rankPosition?: number; keywords: string[]; platforms: string[]; priority?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const posStr = positionToString(seoData.rankPosition ?? -1, seoData.indexStatus);
  const indexed = (seoData.rankPosition ?? -1) >= 0 ? 'yes' : 'no';

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['seoIndexed', 'seoindexed'],   value: indexed },
    { names: ['seoPage',    'seopage'],       value: posStr },
    { names: ['seoKeywords','seokeywords'],   value: seoData.keywords.join(', ') },
    { names: ['platforms'],                   value: seoData.platforms.join(',') },
    { names: ['priority', 'seoRanking', 'seoranking'], value: seoData.priority ?? '' },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 SEO data saved for row ${row.rowIndex}: ${seoData.priority ?? 'N/A'} | ${posStr}`);
}

// ──── Bulk-write SEO data for many rows in a single API call ──────────────
// Avoids quota exhaustion by reusing one client + colMap and sending all
// updates in chunks of 500 ranges (Sheets API limit per batchUpdate).

export async function saveBulkSeoData(
  entries: Array<{
    rowIndex: number;
    seoData: { indexStatus: string; rankPage: number; rankPosition?: number; keywords: string[]; platforms: string[]; priority?: string };
  }>,
  sheetType: SheetType = 'social'
): Promise<void> {
  if (entries.length === 0) return;

  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const allUpdates: { range: string; values: string[][] }[] = [];

  for (const { rowIndex, seoData } of entries) {
    const posStr = positionToString(seoData.rankPosition ?? -1, seoData.indexStatus);
    const indexed = (seoData.rankPosition ?? -1) >= 0 ? 'yes' : 'no';
    const updates = buildUpdates(colMap, rowIndex, [
      { names: ['seoIndexed', 'seoindexed'],   value: indexed },
      { names: ['seoPage',    'seopage'],       value: posStr },
      { names: ['seoKeywords','seokeywords'],   value: seoData.keywords.join(', ') },
      { names: ['platforms'],                   value: seoData.platforms.join(',') },
      { names: ['priority', 'seoRanking', 'seoranking'], value: seoData.priority ?? '' },
    ], sheetConfig.name);
    allUpdates.push(...updates);
  }

  const CHUNK = 500;
  for (let i = 0; i < allUpdates.length; i += CHUNK) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetConfig.id,
      requestBody: { valueInputOption: 'RAW', data: allUpdates.slice(i, i + CHUNK) },
    });
  }
}

// ──── Write Facebook posting result to unified sheet ──────────────────────

export async function saveUnifiedFbResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0];

  // Re-read live cell values so we always append to current sheet data,
  // not the stale row object fetched at batch-start.
  let liveFbPostUrl = row.fbPostUrl ?? '';
  let liveLastPostedFb = row.lastPostedFb ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'FB Post URL', 'fb post url');
    const dateIdx = col(colMap, 'lastPostedFb', 'lastpostedfb');
    if (urlIdx !== undefined) liveFbPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedFb = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical — fall back to row object */ }

  console.log(`   [FB save] row ${row.rowIndex} | existing URL: "${liveFbPostUrl}" | new URL: "${result.postUrl}"`);
  const newUrl = appendValue(liveFbPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedFb, today)
    : liveLastPostedFb;
  console.log(`   [FB save] → writing URL: "${newUrl}" | date: "${newLastPosted}"`);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['FB Post',     'fb post'],                        value: result.post    },
    { names: ['FB Post URL', 'fb post url'],                    value: newUrl },
    { names: ['FB Status',   'fb status'],                      value: result.status  },
    { names: ['FB Error',    'fb error'],                       value: result.error ?? '' },
    { names: ['fbBatch',     'fb batch',    'FB Batch'],        value: result.batch ?? '' },
    { names: ['lastPostedFb','lastpostedfb'],                   value: newLastPosted },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 FB updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write LinkedIn posting result to unified sheet ──────────────────────

export async function saveUnifiedLinkedInResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0];

  let liveLinkedinPostUrl = row.linkedinPostUrl ?? '';
  let liveLastPostedLi = row.lastPostedLi ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'LinkedIn Post URL', 'linkedin post url');
    const dateIdx = col(colMap, 'lastPostedLi', 'lastpostedli');
    if (urlIdx !== undefined) liveLinkedinPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedLi = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical — fall back to row object */ }

  console.log(`   [LI save] row ${row.rowIndex} | existing URL: "${liveLinkedinPostUrl}" | new URL: "${result.postUrl}"`);
  const newUrl = appendValue(liveLinkedinPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedLi, today)
    : liveLastPostedLi;
  console.log(`   [LI save] → writing URL: "${newUrl}" | date: "${newLastPosted}"`);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['LinkedIn Post',     'linkedin post'],                              value: result.post    },
    { names: ['LinkedIn Post URL', 'linkedin post url'],                          value: newUrl },
    { names: ['LinkedIn Status',   'linkedin status'],                            value: result.status  },
    { names: ['LinkedIn Error',    'linkedin error'],                             value: result.error ?? '' },
    { names: ['liBatch',           'li batch',         'LI Batch'],              value: result.batch ?? '' },
    { names: ['lastPostedLi',      'lastpostedli'],                               value: newLastPosted },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 LinkedIn updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write Medium posting result to unified sheet ────────────────────────

export async function saveUnifiedMediumResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.mediumPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedMedium, today)
    : (row.lastPostedMedium ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Medium Post URL', 'medium post url'],                        value: newUrl },
    { names: ['Medium Status',   'medium status'],                          value: result.status  },
    { names: ['Medium Error',    'medium error'],                           value: result.error ?? '' },
    { names: ['mediumBatch',     'medium batch',    'Medium Batch'],        value: result.batch ?? '' },
    { names: ['lastPostedMedium','lastpostedmedium'],                       value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Medium updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write Linkmate posting result to unified sheet ────────────────────

export async function saveUnifiedLinkmateResult(
  row: SheetRow,
  result: { content: string; postUrl: string; status: string; error?: string; batch?: string; lastPosted?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.linkMatePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedLinkmate, today)
    : (row.lastPostedLinkmate ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Linkmate Content', 'linkmate content'],                       value: result.content    },
    { names: ['Linkmate Post URL', 'linkmate post url'],                     value: newUrl },
    { names: ['Linkmate Status',   'linkmate status'],                       value: result.status  },
    { names: ['Linkmate Error',    'linkmate error'],                        value: result.error ?? '' },
    { names: ['linkmateBatch',     'linkmate batch',    'Linkmate Batch'],   value: result.batch ?? '' },
    { names: ['lastPostedLinkmate','lastpostedlinkmate'],                    value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Linkmate updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write Google Sites posting result to unified sheet ────────────────

export async function saveUnifiedGoogleSiteResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.googleSitePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedGoogleSite, today)
    : (row.lastPostedGoogleSite ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Google Site Post URL', 'google site post url'],                value: newUrl },
    { names: ['Google Site Status',   'google site status'],                  value: result.status  },
    { names: ['Google Site Error',    'google site error'],                   value: result.error ?? '' },
    { names: ['GoogleSite Batch', 'googleSiteBatch', 'google site batch', 'Google Site Batch'], value: result.batch ?? '' },
    { names: ['lastPostedGoogleSite', 'lastpostedgooglesite'],                value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Google Sites updated for row ${row.rowIndex}: ${result.status}`);
}

/**
 * Fetch a single row by its Google Sheet row number (1-based, row 1 = header).
 * e.g. rowIndex=15 returns the data in sheet row 15.
 */
export async function getSheetRowByIndex(rowIndex: number, sheetType: 'blog' | 'social'): Promise<SheetRow | null> {
  const sheets = await getSheetsClient();
  const config = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, config.id, config.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: config.id,
    range: `${config.name}!A:AZ`,
  }), 'getSheetRowByIndex');

  const rows: string[][] = res.data.values ?? [];
  // rows[0] = header, rows[rowIndex-1] = sheet row rowIndex
  const arrIdx = rowIndex - 1;
  if (arrIdx < 1 || arrIdx >= rows.length) return null;

  return mapRow(rows[arrIdx], colMap, rowIndex, sheetType);
}

// ──── Write Dev.to posting result to unified sheet ──────────────────────

export async function saveUnifiedDevtoResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.devtoPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedDevto, today)
    : (row.lastPostedDevto ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Dev.to Post URL', 'dev.to post url'],                value: newUrl },
    { names: ['Dev.to Status',   'dev.to status'],                  value: result.status  },
    { names: ['Dev.to Error',    'dev.to error'],                   value: result.error ?? '' },
    { names: ['Devto Batch', 'devtoBatch', 'dev.to batch', 'Dev.to Batch'], value: result.batch ?? '' },
    { names: ['lastPostedDevto', 'lastposteddevto'],                value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Dev.to updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write LinkedIn Pulse posting result to unified sheet ──────────────

export async function saveLinkedinPulseResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.linkedinPulsePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedLinkedinPulse, today)
    : (row.lastPostedLinkedinPulse ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Linkedin Pulse URL', 'LinkedIn Pulse Post URL', 'linkedin pulse post url'], value: newUrl },
    { names: ['Linkedin Pulse Status', 'LinkedIn Pulse Status', 'linkedin pulse status'], value: result.status  },
    { names: ['Linkedin Pulse Error', 'LinkedIn Pulse Error', 'linkedin pulse error'],    value: result.error ?? '' },
    { names: ['linkedinPulseBatch', 'linkedin pulse batch', 'LinkedIn Pulse Batch'],      value: result.batch ?? '' },
    { names: ['lastPosted linkedin Pulse', 'lastPostedLinkedinPulse', 'lastpostedlinkedinpulse'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 LinkedIn Pulse updated for row ${row.rowIndex}: ${result.status}`);
}

export async function saveCalisthenicsResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.calisthenicsPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedCalisthenics, today)
    : (row.lastPostedCalisthenics ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Calisthenics Post URL', 'calisthenics post url'], value: newUrl },
    { names: ['Calisthenics Status', 'calisthenics status'], value: result.status  },
    { names: ['Calisthenics Error', 'calisthenics error'],    value: result.error ?? '' },
    { names: ['calisthenicsNBatch', 'calisthenics batch', 'Calisthenics Batch'],      value: result.batch ?? '' },
    { names: ['lastPostedCalisthenics', 'lastpostedcalisthenics'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Calisthenics updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Save weekly SERP re-check results (Feature 2) ───────────────────────

export async function saveWeeklySerpRecheck(
  row: SheetRow,
  seoResult: {
    seoRanking: number;
    indexStatus: string;
    priority: string;
    keywords: string[];
  },
  contentResult?: {
    tweet: string;
    fbPost: string;
    liPost: string;
    blog: string;
  }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const today = new Date().toISOString().split('T')[0];

  const indexed = (seoResult.seoRanking ?? -1) >= 0 ? 'yes' : 'no';
  const updates = [
    { names: ['priority'],                                              value: seoResult.priority },
    { names: ['seoIndexed', 'seoindexed'],                             value: indexed },
    { names: ['seoKeywords', 'seokeywords'],                           value: seoResult.keywords.join(', ') },
    // Clear old post URLs so rows are re-picked for re-posting
    { names: ['X Post URL',         'x post url'],                     value: '' },
    { names: ['FB Post URL',        'fb post url'],                    value: '' },
    { names: ['LinkedIn Post URL',  'linkedin post url'],              value: '' },
  ];

  // If content was regenerated, update it
  if (contentResult) {
    updates.push(
      { names: ['X Post', 'x post', 'xPost'],                           value: contentResult.tweet },
      { names: ['FB Post', 'fb post', 'fbPost'],                        value: contentResult.fbPost },
      { names: ['LinkedIn Post', 'linkedin post', 'linkedinPost'],      value: contentResult.liPost },
      { names: ['Message Status'],                                      value: contentResult.blog }
    );
  }

  const data = buildUpdates(colMap, row.rowIndex, updates);
  await batchWrite(sheets, data);
  console.log(`   📝 SERP re-checked for row ${row.rowIndex}: ${seoResult.priority} (${today})`);
}

// ──── Read a single row by 1-based row index ────────────────────────────

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

// ──── Read rows across a date range (for unprocessed detection) ──────────

export async function getAllRowsInDateRange(dates: string[]): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
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

  console.log(`   📄 Found ${results.length} unprocessed rows for dates: ${dates.join(', ')}`);
  return results;
}

// ──── Read unassigned rows (name/batch/date empty, URL+title present) ────

export interface UnassignedRow {
  rowIndex: number;
  title: string;
  targetUrl: string;
  name: string;
  marketValue?: string;
}

export async function getUnassignedRows(): Promise<UnassignedRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const dataRes = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getUnassignedRows');
  const rows: string[][] = dataRes.data.values ?? [];
  const results: UnassignedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title     = row[col(colMap, 'Title', 'title', 'Main Title') ?? -1]                   ?? '';
    const targetUrl = row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'targetUrl', 'targeturl', 'URL', 'url') ?? -1]  ?? '';
    const seoRanking = row[col(colMap, 'seoRanking', 'priority') ?? -1] ?? '';

    // Must have URL + title
    if (!targetUrl.trim() || !title.trim()) continue;
    // NEW ARCHITECTURE: Skip rows already with priority (P1/P2/P3)
    if (seoRanking.trim()) continue;

    results.push({
      rowIndex: i + 1,
      title,
      targetUrl,
      name: row[col(colMap, 'Name', 'name') ?? -1] ?? '',
      marketValue: row[col(colMap, 'market_value', 'marketValue', 'market value') ?? -1] ?? '',
    });
  }

  console.log(`   📄 Found ${results.length} unassigned rows (no priority yet)`);
  return results;
}

// ──── Get unassigned rows as SheetRow (for batch top-up) ─────────────────

export async function getUnassignedRowsAsSheetRows(limit: number = 15, sheetType: 'social' | 'blog' = 'social'): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = sheetType === 'blog' ? { id: BLOG_SHEET_ID, name: BLOG_SHEET_NAME } : { id: SOCIAL_SHEET_ID, name: SOCIAL_SHEET_NAME };
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const dataRes = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:AZ`,
  }), 'getUnassignedRowsAsSheetRows');
  const rows: string[][] = dataRes.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const title     = row[col(colMap, 'Title', 'title', 'Main Title') ?? -1]                   ?? '';
    const targetUrl = row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'targetUrl', 'targeturl', 'URL', 'url') ?? -1]  ?? '';
    const seoRanking = row[col(colMap, 'seoRanking', 'priority') ?? -1] ?? '';

    // Must have URL + title
    if (!targetUrl.trim() || !title.trim()) continue;
    // Skip rows already with priority (P1/P2/P3)
    if (seoRanking.trim()) continue;

    results.push(mapRow(row, colMap, i + 1, sheetType));
  }

  return results;
}

// ──── Get rows for continuous reposting (priority-based) ──────────────────

export async function getRowsForContinuousXPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousXPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['X Status', 'x status', 'xStatus'], limit, 'X', 'social');
}

export async function getRowsForContinuousFbPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousFbPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['FB Status', 'fb status', 'fbStatus'], limit, 'FB', 'social');
}

export async function getRowsForContinuousLiPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousLiPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['LinkedIn Status', 'linkedin status', 'liStatus'], limit, 'LI', 'social');
}

// ──── Read leftover rows (assigned but unposted from before today) ────────

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
    range: `${SHEET_NAME}!A:AZ`,
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
    // Must have been assigned (has batch + date + name) – skip url-title-only rows
    if (!batch.trim() || !date.trim() || !name.trim()) continue;
    // Date must be before today
    if (date.trim() >= today) continue;
    // Must not have been posted
    if (xStatus.trim().toLowerCase() === 'posted') continue;

    results.push({ rowIndex: i + 1, title, targetUrl });
  }

  console.log(`   📄 Found ${results.length} leftover rows before ${today}`);
  return results;
}

// ──── Append url+title rows to end of sheet (for leftover agent) ──────────

export async function appendRowsToSheet(rows: Array<{ title: string; targetUrl: string }>): Promise<void> {
  if (rows.length === 0) return;
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const titleIdx  = col(colMap, 'title');
  const urlIdx    = col(colMap, 'targetUrl', 'targeturl');
  if (titleIdx === undefined || urlIdx === undefined) {
    console.warn('   ⚠️  Cannot append rows – title or targetUrl column not found');
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
  console.log(`   📄 Appended ${rows.length} leftover rows to end of sheet`);
}

// ──── Read today's rows for FB/LI batches (filtered by platform eligibility) ──

export async function getFbPendingRowsForBatches(xBatches: number[], today: string): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
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
    range: `${SHEET_NAME}!A:AZ`,
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

// ──── Get all rows with a targetUrl and no X Status (pending posts) ──────

export async function getPendingRows(): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
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

  console.log(`   📄 Found ${results.length} pending rows`);
  return results;
}

// ──── New: get rows ready for FB/LI batch (seoRanking set, postUrl empty) ──

/**
 * Get rows where X has assigned priority (seoRanking/seoPage is set)
 * but fbPostUrl is still empty. Used by FB batch to pick rows to post.
 */
export async function getRowsReadyForFb(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForFb');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const fbPostUrl  = (row[col(colMap, 'FB Post URL', 'fb post url') ?? -1] ?? '').trim();
    const targetUrl  = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title      = (row[col(colMap, 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no FB post yet
    if (!targetUrl || !title) continue;
    if (fbPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📄 FB: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where linkedinPostUrl is still empty. Used by LI batch.
 */
export async function getRowsReadyForLi(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForLi');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const liPostUrl     = (row[col(colMap, 'LinkedIn Post URL', 'linkedin post url') ?? -1] ?? '').trim();
    const targetUrl     = (row[col(colMap, 'Download Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title         = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no LI post yet
    if (!targetUrl || !title) continue;
    if (liPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📄 LI: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where mediumPostUrl is still empty. Used by Medium batch.
 */
export async function getRowsReadyForMedium(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForMedium');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const mediumPostUrl = (row[col(colMap, 'Medium Post URL', 'medium post url') ?? -1] ?? '').trim();
    const targetUrl     = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title         = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Medium post yet
    if (!targetUrl || !title) continue;
    if (mediumPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Medium: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where linkMatePostUrl is still empty. Used by Linkmate batch.
 */
export async function getRowsReadyForLinkmate(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForLinkmate');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const linkMatePostUrl = (row[col(colMap, 'Linkmate Post URL', 'linkmate post url') ?? -1] ?? '').trim();
    const targetUrl       = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title           = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Linkmate post yet
    if (!targetUrl || !title) continue;
    if (linkMatePostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Linkmate: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where googleSitePostUrl is still empty. Used by Google Sites batch.
 */
export async function getRowsReadyForGoogleSite(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForGoogleSite');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const googleSitePostUrl = (row[col(colMap, 'Google Site Post URL', 'google site post url') ?? -1] ?? '').trim();
    const targetUrl         = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title             = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Google Sites post yet
    if (!targetUrl || !title) continue;
    if (googleSitePostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Google Sites: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where devtoPostUrl is still empty. Used by Dev.to batch.
 */
export async function getRowsReadyForDevto(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForDevto');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const devtoPostUrl = (row[col(colMap, 'Dev.to Post URL', 'dev.to post url') ?? -1] ?? '').trim();
    const targetUrl    = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title        = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Dev.to post yet
    if (!targetUrl || !title) continue;
    if (devtoPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Dev.to: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where linkedinPulsePostUrl is still empty. Used by LinkedIn Pulse batch.
 */
export async function getRowsReadyForLinkedinPulse(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForLinkedinPulse');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const linkedinPulsePostUrl = (row[col(colMap, 'Linkedin Pulse URL', 'LinkedIn Pulse Post URL', 'linkedin pulse post url', 'linkedin pulse url') ?? -1] ?? '').trim();
    const targetUrl            = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title                = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no LinkedIn Pulse post yet
    if (!targetUrl || !title) continue;
    if (linkedinPulsePostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 LinkedIn Pulse: Found ${results.length} rows ready for posting`);
  return results;
}

// ──── Continuous posting for blog platforms (sequential: next unposted rows) ──

/**
 * Shared helper: find the last row that already has a URL for this platform,
 * then return the next `limit` rows after it where the URL is still empty.
 * No P1/P2/P3 or SERP required — pure sequential order.
 */
function pickNextSequentialBlogRows(
  rows: string[][],
  colMap: ColMap,
  urlColNames: string[],
  limit: number,
  label: string,
  sheetType: 'social' | 'blog' = 'blog'
): SheetRow[] {
  const urlColIdx = col(colMap, ...urlColNames) ?? -1;
  if (urlColIdx < 0) {
    console.error(`   ❌ pickNextSequentialBlogRows [${label}]: URL column NOT FOUND in sheet. Expected one of: [${urlColNames.join(', ')}]. Check sheet headers. Returning 0 rows to prevent repeated posting.`);
    return [];
  }
  const titleIdx = col(colMap, 'Title', 'title', 'Main Title') ?? -1;
  const targetUrlIdx = col(colMap, 'Report URL', 'Download Report URL', 'Target URL', 'target url', 'targetUrl', 'URL', 'url') ?? -1;

  // Find the highest data-row index that has a posted URL
  let lastPostedIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    const urlVal = urlColIdx >= 0 ? (rows[i][urlColIdx] ?? '').trim() : '';
    if (urlVal) lastPostedIdx = i;
  }

  // Pick next rows after lastPostedIdx where URL is still empty
  const results: SheetRow[] = [];
  for (let i = lastPostedIdx + 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const urlVal = urlColIdx >= 0 ? (row[urlColIdx] ?? '').trim() : '';
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const targetUrl = targetUrlIdx >= 0 ? (row[targetUrlIdx] ?? '').trim() : '';

    if (urlVal) continue;       // gap row already posted — skip, keep scanning
    if (!title || !targetUrl) continue;

    results.push(mapRow(row, colMap, i + 1, sheetType));
  }

  console.log(`   📄 Found ${results.length} rows ready for sequential ${label} posting`);
  return results;
}

export async function getRowsForContinuousMediumPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousMediumPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Medium Post URL', 'medium post url', 'mediumPostUrl'], limit, 'Medium');
}

export async function getRowsForContinuousLinkmatePosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousLinkmatePosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Linkmate Post URL', 'linkmate post url', 'linkMatePostUrl'], limit, 'Linkmate');
}

export async function getRowsForContinuousDevtoPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousDevtoPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Dev.to Post URL', 'devto post url', 'devtoPostUrl'], limit, 'Dev.to');
}

export async function getRowsForContinuousGoogleSitePosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousGoogleSitePosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Google Site Post URL', 'google site post url', 'googleSitePostUrl'], limit, 'Google Sites');
}

export async function getRowsForContinuousLinkedinPulsePosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousLinkedinPulsePosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Linkedin Pulse URL', 'linkedin pulse url', 'linkedinPulsePostUrl'], limit, 'LinkedIn Pulse');
}

export async function getRowsForContinuousCalisthenicsPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousCalisthenicsPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Calisthenics Post URL', 'calisthenics post url', 'calisthenicsPostUrl'], limit, 'Calisthenics');
}

// ──── Continuous row picking for FB/LI (legacy - kept for compatibility) ──

export async function getRowsWithoutFbUrl(startRowIndex: number, limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
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

  console.log(`   📄 FB: Found ${results.length} rows starting from index ${startRowIndex}`);
  return results;
}

export async function getRowsWithoutLiUrl(startRowIndex: number, limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
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

  console.log(`   📄 LI: Found ${results.length} rows starting from index ${startRowIndex}`);
  return results;
}

// ──── Get URLs due for weekly SERP re-check (Week 2+ feature) ──────────

export async function getUrlsDueForRecheck(): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getUrlsDueForRecheck');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const lastSerpCheckDate = row[col(colMap, 'lastSerpCheckDate', 'last serp check date') ?? -1] ?? '';
    const priority = row[col(colMap, 'priority', 'seoRanking') ?? -1] ?? '';

    // Need: targetUrl exists AND priority was assigned AND lastSerpCheckDate <= 7 days ago
    if (!targetUrl.trim()) continue;
    if (!priority.trim()) continue; // Skip unprocessed URLs

    // If no lastSerpCheckDate, it's new - skip
    if (!lastSerpCheckDate.trim()) continue;

    // Check if > 7 days old
    if (lastSerpCheckDate <= sevenDaysAgo) {
      results.push(mapRow(row, colMap, i + 1));
    }
  }

  console.log(`   📄 Found ${results.length} URLs due for SERP re-check (> 7 days old)`);
  return results;
}

// ──── Batch-assign name/batch/date back to sheet rows ──────────────────

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
  console.log(`   ✔ Assigned ${assignments.length} rows`);
}

export const assignXRowsBatch  = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignFbRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignLiRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);

// ──── Internal helpers ──────────────────────────────────────────────────

/**
 * Converts exact rank position to a human-readable sheet value.
 *   rankPosition > 0  → "PageNo=1 ranking=7"  (page number + exact position)
 *   rankPosition = 0  → "PageNo=11+ ranking=100+"  (indexed but outside top 100)
 *   rankPosition = -1 → "N/A" (unknown / SerpAPI unavailable)
 */
function positionToString(rankPosition: number, indexStatus: string): string {
  if (rankPosition > 0 && rankPosition < 999) {
    const page = Math.ceil(rankPosition / 10);
    return `page=${page}/ranking=${rankPosition}`;
  }
  if (rankPosition === 999) return 'page=NA/ranking=NA';
  if (rankPosition === 0) return 'page=11+/ranking=100+';
  return 'N/A';
}

// ──── Get next batch number from sheet (last written batch + 1) ─────────

export async function getLastBatchNumber(
  batchColNames: string[],
  sheetType: SheetType = 'social'
): Promise<number> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const batchColIdx = col(colMap, ...batchColNames);
  if (batchColIdx === undefined) return 0;

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:AZ`,
  }), 'getLastBatchNumber');

  const rows: string[][] = res.data.values ?? [];
  let maxBatch = 0;
  for (let i = 1; i < rows.length; i++) {
    const val = (rows[i][batchColIdx] || '').trim();
    if (val.startsWith('Batch ')) {
      const num = parseInt(val.slice(6), 10);
      if (!isNaN(num) && num > maxBatch) maxBatch = num;
    }
  }
  return maxBatch;
}

function buildUpdates(
  colMap: ColMap,
  rowIndex: number,
  fields: { names: string[]; value: string }[],
  sheetName: string = SHEET_NAME
): { range: string; values: string[][] }[] {
  const results: { range: string; values: string[][] }[] = [];
  for (const f of fields) {
    const colIdx = col(colMap, ...f.names);
    if (colIdx === undefined) {
      console.warn(`   ⚠️ buildUpdates: column NOT FOUND for names [${f.names.join(', ')}] – skipping`);
    } else {
      results.push({
        range: `${sheetName}!${colToLetter(colIdx)}${rowIndex}`,
        values: [[f.value]],
      });
    }
  }
  if (results.length === 0) {
    console.warn(`   ⚠️ buildUpdates: NO columns matched for row ${rowIndex} – nothing will be written!`);
  } else {
    console.log(`   ✔ buildUpdates: ${results.length}/${fields.length} fields matched for row ${rowIndex}`);
  }
  return results;
}

async function batchWrite(sheets: any, data: { range: string; values: string[][] }[], spreadsheetId: string = SHEET_ID): Promise<void> {
  if (data.length === 0) {
    console.warn('   ⚠️ batchWrite: called with EMPTY data – nothing to write');
    return;
  }
  console.log(`   ✔ batchWrite: writing ${data.length} cells – ${data.map(d => d.range).join(', ')}`);
  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
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

// ──── Sunday Examination: Move Failed Posts to End of Sheet ──────────────────

export async function examineSundayFailedPosts(): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'examineSundayFailedPosts');

  const rows: string[][] = res.data.values ?? [];
  const failedRows: { rowIndex: number; data: string[]; platform: string }[] = [];
  let lastDataRowIndex = 1; // Start from header

  // Column indexes for relevant fields
  const descTitleCol = col(colMap, 'descriptionTitle', 'Report Title', 'description title', 'report title');
  const targetUrlCol = col(colMap, 'targetUrl', 'Target URL', 'Download Report URL', 'target url', 'url');

  // Platform status columns
  const mediumStatusCol = col(colMap, 'mediumStatus', 'Medium Status', 'medium status');
  const mediumUrlCol = col(colMap, 'mediumPostUrl', 'Medium Post URL', 'medium post url');
  const linkmateStatusCol = col(colMap, 'linkMateStatus', 'Linkmate Status', 'linkmate status');
  const linkmateUrlCol = col(colMap, 'linkMatePostUrl', 'Linkmate Post URL', 'linkmate post url');
  const googleSiteStatusCol = col(colMap, 'googleSiteStatus', 'Google Site Status', 'google site status');
  const googleSiteUrlCol = col(colMap, 'googleSitePostUrl', 'Google Site Post URL', 'google site post url');
  const devtoStatusCol = col(colMap, 'devtoStatus', 'Dev.to Status', 'dev.to status');
  const devtoUrlCol = col(colMap, 'devtoPostUrl', 'Dev.to Post URL', 'dev.to post url');
  const liPulseStatusCol = col(colMap, 'linkedinPulseStatus', 'LinkedIn Pulse Status', 'linkedin pulse status');
  const liPulseUrlCol = col(colMap, 'linkedinPulsePostUrl', 'LinkedIn Pulse Post URL', 'linkedin pulse post url');
  const calisthenicsStatusCol = col(colMap, 'calisthenicsStatus', 'Calisthenics Status', 'calisthenics status');
  const calisthenicsUrlCol = col(colMap, 'calisthenicsPostUrl', 'Calisthenics Post URL', 'calisthenics post url');

  // Scan for failed rows and last data row
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const descTitle = (row[descTitleCol ?? -1] ?? '').trim();
    const targetUrl = (row[targetUrlCol ?? -1] ?? '').trim();

    // Track last row with data
    if (descTitle || targetUrl) {
      lastDataRowIndex = i + 1; // Convert to 1-based for sheet operations
    }

    // Check for failed posts
    const checks = [
      { status: mediumStatusCol, url: mediumUrlCol, platform: 'Medium' },
      { status: linkmateStatusCol, url: linkmateUrlCol, platform: 'Linkmate' },
      { status: googleSiteStatusCol, url: googleSiteUrlCol, platform: 'Google Sites' },
      { status: devtoStatusCol, url: devtoUrlCol, platform: 'Dev.to' },
      { status: liPulseStatusCol, url: liPulseUrlCol, platform: 'LinkedIn Pulse' },
      { status: calisthenicsStatusCol, url: calisthenicsUrlCol, platform: 'Calisthenics' },
    ];

    for (const check of checks) {
      if (check.status === undefined || check.url === undefined) continue;

      const status = (row[check.status] ?? '').trim();
      const postUrl = (row[check.url] ?? '').trim();

      if (status.toLowerCase() === 'failed' && !postUrl) {
        failedRows.push({
          rowIndex: i + 1,
          data: [...row],
          platform: check.platform,
        });
        break; // Don't count same row twice for multiple platforms
      }
    }
  }

  if (failedRows.length === 0) {
    console.log(`   ✅ Sunday Examination: No failed posts to move`);
    return;
  }

  console.log(`   🔍 Sunday Examination: Found ${failedRows.length} failed posts`);

  // Insert failed rows at the end (after lastDataRowIndex)
  const insertStartRow = lastDataRowIndex + 1;
  const updates: any[] = [];

  for (let i = 0; i < failedRows.length; i++) {
    const failedRow = failedRows[i];
    const sheetRowIndex = insertStartRow + i;

    // Build update for this row
    const rowData: any[] = [];
    for (let colIndex = 0; colIndex < failedRow.data.length; colIndex++) {
      rowData.push({ userEnteredValue: { stringValue: failedRow.data[colIndex] ?? '' } });
    }

    // Append rows to sheet
    updates.push({
      range: `${BLOG_SHEET_NAME}!A${sheetRowIndex}`,
      values: [failedRow.data],
    });
  }

  // Write all updates
  await batchWrite(sheets, updates, BLOG_SHEET_ID);

  console.log(`   📋 Moved ${failedRows.length} failed posts to rows ${insertStartRow}-${insertStartRow + failedRows.length - 1}`);
  console.log(`      Failed posts:`);
  for (const fp of failedRows) {
    const title = (fp.data[col(colMap, 'Title', 'title', 'Main Title') ?? -1] ?? 'N/A').slice(0, 50);
    console.log(`        • ${title}... (${fp.platform})`);
  }
}

// ──── Substack Blog Posting ─────────────────────────────────────────────────────

export async function getRowsReadyForSubstack(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForSubstack');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const substackPostUrl = (row[col(colMap, 'Substack Post URL', 'substack post url') ?? -1] ?? '').trim();
    const targetUrl = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl', 'URL') ?? -1] ?? '').trim();
    const title = (row[col(colMap, 'Title', 'title', 'Main Title') ?? -1] ?? '').trim();

    if (!targetUrl || !title) continue;
    if (substackPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  return results;
}

export async function getRowsForContinuousSubstackPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousSubstackPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Substack Post URL', 'substack post url', 'substackPostUrl'], limit, 'Substack');
}

export async function saveUnifiedSubstackResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.substackPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedSubstack, today)
    : (row.lastPostedSubstack ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Substack Post URL', 'substack post url'], value: newUrl },
    { names: ['Substack Status', 'substack status'], value: result.status },
    { names: ['Substack  Error', 'Substack Error', 'substack  error', 'substack error'], value: result.error ?? '' },
    { names: ['substackBatch', 'substack batch', 'Substack Batch'], value: result.batch ?? '' },
    { names: ['lastPostedSubstack', 'lastpostedsubstack'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Guffiz Blog Posting ─────────────────────────────────────────────────────

export async function getRowsReadyForGuffiz(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForGuffiz');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const guffizPostUrl = (row[col(colMap, 'Guffiz Post URL', 'guffiz post url') ?? -1] ?? '').trim();
    const targetUrl = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl', 'URL') ?? -1] ?? '').trim();
    const title = (row[col(colMap, 'Title', 'title', 'Main Title') ?? -1] ?? '').trim();

    if (!targetUrl || !title) continue;
    if (guffizPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  return results;
}

export async function getRowsForContinuousGuffizPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousGuffizPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Guffiz Post URL', 'guffiz post url', 'guffizPostUrl'], limit, 'Guffiz');
}

export async function saveUnifiedGuffizResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.guffizPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedGuffiz, today)
    : (row.lastPostedGuffiz ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Guffiz Post URL', 'guffiz post url'], value: newUrl },
    { names: ['Guffiz Status', 'guffiz status'], value: result.status },
    { names: ['Guffiz Error', 'guffiz error'], value: result.error ?? '' },
    { names: ['guffizBatch', 'guffiz batch', 'Guffiz Batch'], value: result.batch ?? '' },
    { names: ['lastPostedGuffiz', 'lastpostedguffiz'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── HackMD Blog Posting ─────────────────────────────────────────────────────

export async function getRowsReadyForHackmd(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:ZZ`,
  }), 'getRowsReadyForHackmd');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const hackmdStatus  = (row[col(colMap, 'HackMD Status',   'Hackmd Status',   'hackmd status')   ?? -1] ?? '').trim();
    const hackmdPostUrl = (row[col(colMap, 'HackMD Post URL', 'Hackmd Post URL', 'hackmd post url') ?? -1] ?? '').trim();
    const targetUrl = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl', 'URL') ?? -1] ?? '').trim();
    const title = (row[col(colMap, 'Title', 'title', 'Main Title') ?? -1] ?? '').trim();

    if (!targetUrl || !title) continue;
    if (hackmdStatus || hackmdPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  return results;
}

export async function getRowsForContinuousHackmdPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:ZZ`,
  }), 'getRowsForContinuousHackmdPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Hackmd Post URL', 'hackmd post url', 'HackMD Post URL', 'hackmdPostUrl'], limit, 'HackMD');
}

export async function saveUnifiedWordpressResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  let liveWordpressPostUrl = row.wordpressPostUrl ?? '';
  let liveLastPostedWordpress = row.lastPostedWordpress ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'WordPress Post URL', 'wordpress post url');
    const dateIdx = col(colMap, 'lastPostedWordpress', 'lastpostedwordpress');
    if (urlIdx !== undefined) liveWordpressPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedWordpress = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical */ }

  const newUrl = appendValue(liveWordpressPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedWordpress, today)
    : liveLastPostedWordpress;

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['WordPress Post URL', 'wordpress post url'], value: newUrl },
    { names: ['WordPress Status', 'wordpress status'], value: result.status },
    { names: ['WordPress Error', 'wordpress error'], value: result.error ?? '' },
    { names: ['wordpressBatch', 'wordpress batch', 'WordPress Batch'], value: result.batch ?? '' },
    { names: ['lastPostedWordpress', 'lastpostedwordpress'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

export async function saveUnifiedBloggerResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  let liveBloggerPostUrl = row.bloggerPostUrl ?? '';
  let liveLastPostedBlogger = row.lastPostedBlogger ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'Blogger Post URL', 'blogger post url');
    const dateIdx = col(colMap, 'Last Posted Blogger', 'lastPostedBlogger', 'lastpostedblogger');
    if (urlIdx !== undefined) liveBloggerPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedBlogger = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical */ }

  const newUrl = appendValue(liveBloggerPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedBlogger, today)
    : liveLastPostedBlogger;

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Blogger Post URL', 'blogger post url'], value: newUrl },
    { names: ['Blogger Status', 'blogger status'], value: result.status },
    { names: ['Blogger Error', 'blogger error'], value: result.error ?? '' },
    { names: ['bloggerBatch', 'blogger batch', 'Blogger Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Blogger', 'lastPostedBlogger', 'lastpostedblogger'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

export async function saveUnifiedPenzuResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  let livePenzuPostUrl = row.penzuPostUrl ?? '';
  let liveLastPostedPenzu = row.lastPostedPenzu ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'Penzu Post URL', 'penzu post url');
    const dateIdx = col(colMap, 'Last Posted Penzu', 'lastPostedPenzu', 'lastpostedpenzu');
    if (urlIdx !== undefined) livePenzuPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedPenzu = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical */ }

  const newUrl = appendValue(livePenzuPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedPenzu, today)
    : liveLastPostedPenzu;

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Penzu Post URL', 'penzu post url'], value: newUrl },
    { names: ['Penzu Status', 'penzu status'], value: result.status },
    { names: ['Penzu Error', 'penzu error'], value: result.error ?? '' },
    { names: ['penzuBatch', 'penzu batch', 'Penzu Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Penzu', 'lastPostedPenzu', 'lastpostedpenzu'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── WriteupCafe Blog Posting ─────────────────────────────────────────────────────

export async function getRowsReadyForWriteupCafe(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForWriteupCafe');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const blogContent = row[col(colMap, 'Content', 'content', 'Blog Content for all', 'blog content for all') ?? -1] ?? '';
    const writeupcafeStatus = row[col(colMap, 'WriteupCafe Status', 'writeupcafe status') ?? -1] ?? '';
    if (!blogContent.trim()) continue;
    if (writeupcafeStatus.trim()) continue;
    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Found ${results.length} rows ready for WriteupCafe`);
  return results;
}

export async function getRowsForContinuousWriteupCafePosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousWriteupCafePosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['WriteupCafe Post URL', 'writeupcafe post url', 'writeupcafePostUrl'], limit, 'WriteupCafe');
}

export async function saveUnifiedWriteupCafeResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  let liveWriteupcafePostUrl = row.writeupcafePostUrl ?? '';
  let liveLastPostedWriteupcafe = row.lastPostedWriteupcafe ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'WriteupCafe Post URL', 'writeupcafe post url');
    const dateIdx = col(colMap, 'Last Posted WriteupCafe', 'lastPostedWriteupcafe', 'lastpostedwriteupcafe');
    if (urlIdx !== undefined) liveWriteupcafePostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedWriteupcafe = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical */ }

  const newUrl = appendValue(liveWriteupcafePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedWriteupcafe, today)
    : liveLastPostedWriteupcafe;

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['WriteupCafe Post URL', 'writeupcafe post url'], value: newUrl },
    { names: ['WriteupCafe Status', 'writeupcafe status'], value: result.status },
    { names: ['WriteupCafe Error', 'writeupcafe error'], value: result.error ?? '' },
    { names: ['writeupcafeBatch', 'writeupcafe batch', 'WriteupCafe Batch'], value: result.batch ?? '' },
    { names: ['Last Posted WriteupCafe', 'lastPostedWriteupcafe', 'lastpostedwriteupcafe'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 WriteupCafe updated for row ${row.rowIndex}: ${result.status}`);
}

export async function saveUnifiedHackmdResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  // Re-read live cell values so we always append to the current sheet data,
  // not the stale row object fetched at batch-start.
  let liveHackmdPostUrl = row.hackmdPostUrl ?? '';
  let liveLastPostedHackmd = row.lastPostedHackmd ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'HackMD Post URL', 'Hackmd Post URL', 'hackmd post url');
    const dateIdx = col(colMap, 'lastPostedHackmd', 'lastPostedHackMD', 'lastpostedhackmd');
    if (urlIdx !== undefined) liveHackmdPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedHackmd = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical — fall back to row object */ }

  console.log(`   [HackMD save] row ${row.rowIndex} | existing URL: "${liveHackmdPostUrl}" | new URL: "${result.postUrl}"`);
  const newUrl = appendValue(liveHackmdPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedHackmd, today)
    : liveLastPostedHackmd;
  console.log(`   [HackMD save] → writing URL: "${newUrl}" | date: "${newLastPosted}"`);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['HackMD Post URL', 'Hackmd Post URL', 'hackmd post url'], value: newUrl },
    { names: ['HackMD Status',   'Hackmd Status',   'hackmd status'],   value: result.status },
    { names: ['HackMD Error',    'Hackmd Error',    'hackmd error'],    value: result.error ?? '' },
    { names: ['hackmdBatch', 'hackmd batch', 'HackMD Batch'],           value: result.batch ?? '' },
    { names: ['lastPostedHackmd', 'lastPostedHackMD', 'lastpostedhackmd'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}
