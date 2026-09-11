import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const BLOGGER_ACCOUNTS_FILE = '.accounts/accounts-blogger.json';
const SESSION_ROOT = path.resolve('.sessions/blogger');

export interface BloggerAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  blogUrl?: string;
  active: boolean;
}

export function getBloggerAccounts(): BloggerAccount[] {
  if (!fs.existsSync(BLOGGER_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(BLOGGER_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveBloggerAccount(): BloggerAccount | null {
  return getBloggerAccounts().find(a => a.active) || null;
}

export function getBloggerAccountByNickname(nickname: string): BloggerAccount | null {
  return getBloggerAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeBloggerBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Blogger browser closed.');
  }
}

export async function loginToBlogger(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getBloggerAccountByNickname(options.nickname) ?? getActiveBloggerAccount()
    : getActiveBloggerAccount();

  const email    = options?.email    || account?.email    || process.env.BLOGGER_EMAIL;
  const password = options?.password || account?.password || process.env.BLOGGER_PASSWORD;

  if (!email) {
    throw new Error(`Blogger email missing. Add account to .accounts/accounts-blogger.json or set BLOGGER_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Blogger browser...');

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
  // Minimize the window via CDP (--start-minimized flag is unreliable with navigation)
  const _minimizeWindow = async (p: Page) => {
    try {
      const cdp = await browserContext!.newCDPSession(p);
      const { windowId } = await (cdp as any).send('Browser.getWindowForTarget');
      await (cdp as any).send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.detach().catch(() => {});
    } catch { /* ignore if CDP unavailable */ }
  };
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  await _minimizeWindow(page);

  console.log('   Navigating to Blogger...');
  await page.goto('https://www.blogger.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await _minimizeWindow(page);
  await sleep(800);
  await _minimizeWindow(page);

  console.log('   Waiting 5 seconds for session check...');
  await sleep(5000);

  // TODO: Update this check with the correct logged-in indicator
  const currentUrl = await page.url();
  const loggedIn = currentUrl.includes('/blog/') || currentUrl.includes('blogger.com/blog') || !currentUrl.includes('accounts.google.com');
  if (loggedIn && !currentUrl.includes('accounts.google.com')) {
    console.log(`   ✅ Already logged in to Blogger (session restored)`);
    return page;
  }

  // Auto-login via Google account
  if (email && password) {
    console.log(`   Attempting auto-login via Google...`);
    try {
      // TODO: Replace selectors with correct Google sign-in flow selectors
      await page.waitForSelector('input[type="email"]', { timeout: 10000 });
      await page.click('input[type="email"]');
      await page.keyboard.type(email, { delay: 80 });
      await page.keyboard.press('Enter');
      await sleep(2000);

      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await page.click('input[type="password"]');
      await page.keyboard.type(password, { delay: 80 });
      await page.keyboard.press('Enter');
      await sleep(5000);

      const afterLogin = await page.url();
      if (!afterLogin.includes('accounts.google.com')) {
        console.log(`   ✅ Auto-login successful`);
        return page;
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Auto-login failed: ${err.message}`);
    }
  }

  console.log(`   ⏳ Not logged in – waiting 20 seconds for manual login...`);
  await sleep(20000);

  const finalUrl = await page.url();
  if (finalUrl.includes('accounts.google.com')) {
    await closeBloggerBrowser();
    throw new Error(`Unable to log in to Blogger as ${email}.`);
  }

  console.log(`   ✅ Login successful`);
  return page;
}

