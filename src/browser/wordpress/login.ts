import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const WORDPRESS_ACCOUNTS_FILE = '.accounts/accounts-wordpress.json';
const SESSION_ROOT = path.resolve('.sessions/wordpress');

export interface WordpressAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  blogUrl?: string;
  active: boolean;
}

export function getWordpressAccounts(): WordpressAccount[] {
  if (!fs.existsSync(WORDPRESS_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(WORDPRESS_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveWordpressAccount(): WordpressAccount | null {
  return getWordpressAccounts().find(a => a.active) || null;
}

export function getWordpressAccountByNickname(nickname: string): WordpressAccount | null {
  return getWordpressAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeWordpressBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   WordPress browser closed.');
  }
}

export async function loginToWordpress(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getWordpressAccountByNickname(options.nickname) ?? getActiveWordpressAccount()
    : getActiveWordpressAccount();

  const email    = options?.email    || account?.email    || process.env.WORDPRESS_EMAIL;
  const password = options?.password || account?.password || process.env.WORDPRESS_PASSWORD;

  if (!email) {
    throw new Error(`WordPress email missing. Add account to .accounts/accounts-wordpress.json or set WORDPRESS_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching WordPress browser...');

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

  console.log('   Navigating to WordPress...');
  await page.goto('https://wordpress.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('   Waiting 5 seconds for session check...');
  await sleep(5000);

  // TODO: Update this check with the correct logged-in indicator selector
  const currentUrl = await page.url();
  const loggedIn = currentUrl.includes('/home') || currentUrl.includes('/dashboard') || currentUrl.includes('/posts');
  if (loggedIn) {
    console.log(`   ✅ Already logged in to WordPress (session restored)`);
    return page;
  }

  // Auto-login if password provided
  if (email && password) {
    console.log(`   Attempting auto-login...`);
    try {
      // TODO: Replace with correct login page URL and selectors
      await page.goto('https://wordpress.com/log-in', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);

      // TODO: Replace '#usernameOrEmail' with actual email field selector
      await page.waitForSelector('#usernameOrEmail', { timeout: 10000 });
      await page.click('#usernameOrEmail');
      await page.keyboard.type(email, { delay: 80 });
      await page.keyboard.press('Enter');
      await sleep(1500);

      // TODO: Replace '#password' with actual password field selector
      await page.waitForSelector('#password', { timeout: 10000 });
      await page.click('#password');
      await page.keyboard.type(password, { delay: 80 });
      await page.keyboard.press('Enter');
      await sleep(5000);

      const afterLogin = await page.url();
      if (afterLogin.includes('/home') || afterLogin.includes('/dashboard')) {
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
  const finalCheck = finalUrl.includes('/home') || finalUrl.includes('/dashboard') || finalUrl.includes('/posts');
  if (!finalCheck) {
    await closeWordpressBrowser();
    throw new Error(`Unable to log in to WordPress as ${email}.`);
  }

  console.log(`   ✅ Login successful`);
  return page;
}
