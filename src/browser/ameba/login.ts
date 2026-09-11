import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const AMEBA_ACCOUNTS_FILE = '.accounts/accounts-ameba.json';
const SESSION_ROOT = path.resolve('.sessions/ameba');

export interface AmebaAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  active: boolean;
}

export function getAmebaAccounts(): AmebaAccount[] {
  if (!fs.existsSync(AMEBA_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(AMEBA_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveAmebaAccount(): AmebaAccount | null {
  return getAmebaAccounts().find(a => a.active) || null;
}

export function getAmebaAccountByNickname(nickname: string): AmebaAccount | null {
  return getAmebaAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeAmebaBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Ameba browser closed.');
  }
}

export async function loginToAmeba(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getAmebaAccountByNickname(options.nickname) ?? getActiveAmebaAccount()
    : getActiveAmebaAccount();

  const email    = options?.email    || account?.email    || process.env.AMEBA_EMAIL;
  const password = options?.password || account?.password || process.env.AMEBA_PASSWORD;

  if (!email) {
    throw new Error(`Ameba email missing. Add account to .accounts/accounts-ameba.json or set AMEBA_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(options?.nickname || email);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Ameba browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: chromePath,
    viewport: null,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  await browserContext.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
  });

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  console.log('   Navigating to Ameba...');
  await page.goto('https://www.ameba.jp/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  // TODO: Update logged-in check with correct selector after inspecting the page
  const currentUrl = page.url();
  const loggedIn = currentUrl.includes('ameba.jp') && !currentUrl.includes('login') && !currentUrl.includes('signin');
  if (loggedIn) {
    console.log(`   ✅ Already logged in to Ameba (session restored)`);
    return page;
  }

  // Auto-login if credentials provided
  if (email && password) {
    console.log(`   Attempting auto-login...`);
    try {
      // TODO: Replace with correct login URL and selectors after inspection
      await page.goto('https://ameba.jp/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);

      await page.waitForSelector('input[name="accountName"], input[name="username"], input[type="email"], #accountName', { timeout: 10000 });
      await page.click('input[name="accountName"], input[name="username"], input[type="email"], #accountName');
      await page.keyboard.type(email, { delay: 80 });

      await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 10000 });
      await page.click('input[name="password"], input[type="password"]');
      await page.keyboard.type(password, { delay: 80 });
      await page.keyboard.press('Enter');
      await sleep(5000);

      const afterUrl = page.url();
      if (afterUrl.includes('ameba.jp') && !afterUrl.includes('login')) {
        console.log(`   ✅ Auto-login successful`);
        return page;
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Auto-login failed: ${err.message}`);
    }
  }

  await closeAmebaBrowser();
  throw new Error(`Unable to log in to Ameba as ${email}. Session expired — run save-ameba-session manually.`);
}

