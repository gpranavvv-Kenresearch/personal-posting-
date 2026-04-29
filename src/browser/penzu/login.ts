import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const PENZU_ACCOUNTS_FILE = '.accounts/accounts-penzu.json';
const SESSION_ROOT = path.resolve('.sessions/penzu');

export interface PenzuAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getPenzuAccounts(): PenzuAccount[] {
  if (!fs.existsSync(PENZU_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PENZU_ACCOUNTS_FILE, 'utf8'));
}

export function getActivePenzuAccount(): PenzuAccount | null {
  return getPenzuAccounts().find(a => a.active) || null;
}

export function getPenzuAccountByNickname(nickname: string): PenzuAccount | null {
  return getPenzuAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closePenzuBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Penzu browser closed.');
  }
}

export async function loginToPenzu(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getPenzuAccountByNickname(options.nickname) ?? getActivePenzuAccount()
    : getActivePenzuAccount();

  const email    = options?.email    || account?.email    || process.env.PENZU_EMAIL;
  const password = options?.password || account?.password || process.env.PENZU_PASSWORD;

  if (!email) {
    throw new Error(`Penzu email missing. Add account to .accounts/accounts-penzu.json or set PENZU_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Penzu browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: null,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  console.log('   Navigating to Penzu...');
  await page.goto('https://penzu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('   Waiting 5 seconds for session check...');
  await sleep(5000);

  const currentUrl = page.url();
  const loggedIn = currentUrl.includes('/journals') || currentUrl.includes('/home') || !currentUrl.includes('penzu.com/#');
  if (loggedIn && !currentUrl.endsWith('penzu.com/') && !currentUrl.endsWith('penzu.com')) {
    console.log(`   ✅ Already logged in to Penzu (session restored)`);
    return page;
  }

  console.log(`   ⏳ Not logged in – waiting for manual login...`);
  await sleep(20000);

  console.log(`   ✅ Login assumed`);
  return page;
}
