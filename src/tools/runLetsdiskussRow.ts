/**
 * Run Letsdiskuss posting for a single row by sheet index.
 * Skips login check — opens saved session directly and runs poster.
 *   npx tsx src/tools/runLetsdiskussRow.ts <rowIndex>
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { getSheetRowByIndex, saveUnifiedLetsdiskussResult } from '../sheets/sheets.js';
import { postToLetsdiskuss } from '../browser/letsdiskuss/poster.js';
import { getLetsdiskussAccountByNickname } from '../browser/letsdiskuss/login.js';
import { ensureTargetUrl } from '../utils/utm.js';

const rowIndex = parseInt(process.argv[2] || '0', 10);
if (!rowIndex) {
  console.error('Usage: npx tsx src/tools/runLetsdiskussRow.ts <rowIndex>');
  process.exit(1);
}

(async () => {
  console.log(`\nFetching blog sheet row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'blog');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in Blogs sheet`);
    process.exit(1);
  }

  console.log(`   Title   : ${row.title}`);
  console.log(`   Account : ${row.name}`);
  console.log(`   Content : ${row.blogContent ? row.blogContent.slice(0, 80) + '...' : '(empty)'}`);

  if (!row.blogContent) {
    console.error('❌ No blog content in row — cannot post');
    process.exit(1);
  }

  const account = getLetsdiskussAccountByNickname(row.name);
  if (!account) {
    console.error(`❌ No Letsdiskuss account found for nickname "${row.name}"`);
    process.exit(1);
  }

  const sessionDir = account.sessionDir
    ? path.resolve(account.sessionDir)
    : path.resolve(`.sessions/letsdiskuss/${row.name}`);

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`\nOpening browser with saved session: ${sessionDir}`);

  const ctx = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-minimized',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
  });

  await ctx.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
  });

  const existingPages = ctx.pages();
  const page = existingPages[0] || await ctx.newPage();
  for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  page.on('dialog', async (d) => { await d.dismiss().catch(() => {}); });

  const title = row.title || row.descriptionTitle || '';
  const content = ensureTargetUrl(row.blogContent, row.targetUrl);

  try {
    console.log('\nPosting to Letsdiskuss...');
    const result = await postToLetsdiskuss(page, title, content);
    console.log(`\n✅ Posted: ${result.postUrl}`);
    await saveUnifiedLetsdiskussResult(row, { postUrl: result.postUrl, status: 'Posted', batch: 'Manual' });
  } catch (err: any) {
    console.error(`\n❌ Post failed: ${err.message}`);
    await saveUnifiedLetsdiskussResult(row, { postUrl: '', status: 'Failed', batch: 'Manual', error: err.message });
  } finally {
    await ctx.close();
  }

  process.exit(0);
})();
