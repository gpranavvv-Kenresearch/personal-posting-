import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const GOOGLESITE_ACCOUNTS_FILE = '.accounts/accounts-googlesite.json';
const SESSION_ROOT = path.resolve('.sessions/googlesite');

export interface GoogleSiteAccount {
  email: string;
  password: string;
  sessionDir?: string;
  nickname?: string;
  active: boolean;
}

export function getGoogleSiteAccounts(): GoogleSiteAccount[] {
  if (!fs.existsSync(GOOGLESITE_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(GOOGLESITE_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveGoogleSiteAccount(): GoogleSiteAccount | null {
  return getGoogleSiteAccounts().find(a => a.active) || null;
}

export function getGoogleSiteAccountByNickname(nickname: string): GoogleSiteAccount | null {
  return getGoogleSiteAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeGoogleSiteBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Google Sites browser closed.');
  }
}

export async function loginToGoogleSite(options?: {
  email?: string;
  password?: string;
  nickname?: string;
  headless?: boolean;
}): Promise<Page> {
  const account = options?.nickname
    ? getGoogleSiteAccountByNickname(options.nickname) ?? getActiveGoogleSiteAccount()
    : getActiveGoogleSiteAccount();

  const email = options?.email || account?.email || process.env.GOOGLESITE_EMAIL;

  if (!email) {
    throw new Error(`Google Sites email missing. Add account to accounts-googlesite.json or set GOOGLESITE_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Google Sites browser...');

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

  // Grant clipboard permissions so we can paste HTML content
  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Minimize window immediately so it doesn't disturb the screen
  if (!options?.manualLogin) {
    try {
      const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
      const cdp = await browserContext.newCDPSession(tmpPage);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.detach().catch(() => {});
    } catch { /* ignore — non-critical */ }
  }

  // Reuse the page the persistent context opened; close any extras
  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  // Go to Google Sites
  console.log('   Navigating to Google Sites...');
  await page.goto('https://sites.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait 5 seconds for session check
  console.log('   Waiting 5 seconds for session check...');
  await sleep(5000);

  // Check if already logged in
  const loggedIn = !(await page.url()).includes('accounts.google.com');
  if (loggedIn) {
    console.log(`   ✅ Already logged in to Google Sites`);
    return page;
  }

  // If not logged in, wait indefinitely for manual login
  console.log(`   ⏳ Not logged in – waiting for manual login...`);
  console.log(`   💻 Close the browser when done logging in.`);

  // Keep checking until login succeeds or browser is closed
  let loginSucceeded = false;
  while (!loginSucceeded) {
    await sleep(2000); // Check every 2 seconds
    try {
      const currentUrl = await page.url();
      if (!currentUrl.includes('accounts.google.com')) {
        loginSucceeded = true;
        break;
      }
    } catch {
      // Browser closed by user
      throw new Error('Browser closed by user');
    }
  }

  console.log(`   ✅ Login successful`);
  return page;
}
