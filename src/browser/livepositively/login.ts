import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const LIVEPOSITIVELY_ACCOUNTS_FILE = '.accounts/accounts-livepositively.json';
const SESSION_ROOT = path.resolve('.sessions/livepositively');

export interface LivepositivelyAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getLivepositivelyAccounts(): LivepositivelyAccount[] {
  if (!fs.existsSync(LIVEPOSITIVELY_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(LIVEPOSITIVELY_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveLivepositivelyAccount(): LivepositivelyAccount | null {
  return getLivepositivelyAccounts().find(a => a.active) || null;
}

export function getLivepositivelyAccountByNickname(nickname: string): LivepositivelyAccount | null {
  return getLivepositivelyAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeLivepositivelyBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   LivePositively browser closed.');
  }
}

export async function loginToLivepositively(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getLivepositivelyAccountByNickname(options.nickname) ?? getActiveLivepositivelyAccount()
    : getActiveLivepositivelyAccount();

  const email    = options?.email    || account?.email    || process.env.LIVEPOSITIVELY_EMAIL;
  const password = options?.password || account?.password || process.env.LIVEPOSITIVELY_PASSWORD;

  if (!email) {
    throw new Error(`LivePositively email missing. Add account to .accounts/accounts-livepositively.json or set LIVEPOSITIVELY_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching LivePositively browser...');

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

  console.log('   Navigating to LivePositively...');
  await page.goto('https://livepositively.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('   Waiting 5 seconds for session check...');
  await sleep(5000);

  // TODO: Update this check with the correct logged-in indicator selector
  const currentUrl = await page.url();
  const loggedIn = !currentUrl.includes('/login') && !currentUrl.includes('/sign-in') && !currentUrl.includes('/wp-login');
  // Additional check: look for user dashboard element
  const dashboardEl = await page.$('[class*="dashboard"], [class*="logged-in"], .user-menu, #wpadminbar').catch(() => null);
  if (loggedIn && dashboardEl) {
    console.log(`   ✅ Already logged in to LivePositively (session restored)`);
    return page;
  }

  // Auto-login
  if (email && password) {
    console.log(`   Attempting auto-login...`);
    try {
      // TODO: Replace with correct login URL and selectors
      await page.goto('https://livepositively.com/wp-login.php', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000);

      // TODO: Replace '#user_login' with actual email/username field selector
      await page.waitForSelector('#user_login', { timeout: 10000 });
      await page.click('#user_login');
      await page.keyboard.type(email, { delay: 80 });

      // TODO: Replace '#user_pass' with actual password field selector
      await page.waitForSelector('#user_pass', { timeout: 10000 });
      await page.click('#user_pass');
      await page.keyboard.type(password, { delay: 80 });

      // TODO: Replace '#wp-submit' with correct submit button selector
      await page.waitForSelector('#wp-submit', { timeout: 5000 });
      await page.click('#wp-submit');
      await sleep(5000);

      const afterLogin = await page.url();
      if (!afterLogin.includes('/wp-login') && !afterLogin.includes('/login')) {
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
  if (finalUrl.includes('/wp-login') || finalUrl.includes('/login')) {
    await closeLivepositivelyBrowser();
    throw new Error(`Unable to log in to LivePositively as ${email}.`);
  }

  console.log(`   ✅ Login successful`);
  return page;
}
