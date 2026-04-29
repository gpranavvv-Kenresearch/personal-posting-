import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome';

const GUFFIZ_ACCOUNTS_FILE = '.accounts/accounts-guffiz.json';
const SESSION_ROOT = path.resolve('.sessions/guffiz');

export interface GuffizAccount {
  email: string;
  password: string;
  sessionDir?: string;
  nickname?: string;
  active: boolean;
}

export function getGuffizAccounts(): GuffizAccount[] {
  if (!fs.existsSync(GUFFIZ_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(GUFFIZ_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveGuffizAccount(): GuffizAccount | null {
  return getGuffizAccounts().find(a => a.active) || null;
}

export function getGuffizAccountByNickname(nickname: string): GuffizAccount | null {
  return getGuffizAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeGuffizBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Guffiz browser closed.');
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('https://guffiz.com/blog', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(3000);
    const url = page.url();
    // If redirected to login page → not logged in
    if (url.includes('/login') || url.includes('/signup')) return false;
    // Check for any logged-in indicator
    const loggedIn = await page.locator([
      'button:has(i.fa-pencil-alt)',
      'i.fa-pencil-alt',
      'a[href*="/logout"]',
      '.UserCard',
      '.Avatar',
      'button:has-text("Write")',
      'a:has-text("Write article")',
      '.item-session',
      'a[href*="/u/"]',
      '.username',
    ].join(', ')).isVisible({ timeout: 5000 }).catch(() => false);
    return loggedIn;
  } catch {
    return false;
  }
}

export async function loginToGuffiz(options?: {
  email?: string;
  password?: string;
  nickname?: string;
  manualMode?: boolean;
  failFast?: boolean;  // if true, throw immediately when no session found (batch mode)
}): Promise<Page> {
  const account = options?.nickname
    ? getGuffizAccountByNickname(options.nickname) ?? getActiveGuffizAccount()
    : getActiveGuffizAccount();

  const email    = options?.email    || account?.email    || process.env.GUFFIZ_EMAIL!;
  const password = options?.password || account?.password || process.env.GUFFIZ_PASSWORD!;

  if (!email) {
    throw new Error('Guffiz credentials missing. Add to .accounts/accounts-guffiz.json');
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Guffiz browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--simulate-outdated-no-au=Tue, 31 Dec 2099 00:00:00 GMT',
      '--disable-component-update',
      '--disable-features=ChromeWhatsNewUI',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });

  await browserContext.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
  });

  // Get or reuse page
  const allPages = browserContext.pages();
  let page: Page;
  if (allPages.length > 0) {
    page = allPages[0];
    for (const p of allPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  if (options?.manualMode) {
    console.log('   Navigating to Guffiz...');
    await page.goto('https://guffiz.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);

    console.log(`   ⚠️  Please log in manually in the browser window...`);
    console.log(`   ⏳ Waiting up to 3 minutes for login...`);
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      // Check DOM only — no page.goto to avoid refresh
      const loggedIn = await page.evaluate(() => {
        return !!(
          document.querySelector('i.fa-pencil-alt') ||
          document.querySelector('a[href*="/logout"]') ||
          document.querySelector('.Avatar') ||
          document.querySelector('.username')
        );
      }).catch(() => false);
      if (loggedIn) {
        console.log(`   ✅ Login detected!`);
        return page;
      }
    }
    console.log(`   ⚠️  Login not detected after 3 minutes — returning page anyway`);
  }

  // Batch mode: just return page — if not logged in, posting will fail naturally
  console.log(`   ✅ Session loaded for ${options?.nickname ?? 'default'}`);
  return page;
}
