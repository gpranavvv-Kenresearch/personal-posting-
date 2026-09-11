import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

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

// Keyed by account nickname so N accounts can run concurrently (e.g. two
// overlapping cron batches, or a manual retry landing mid-batch) without one
// account's login/close ever touching a different account's live browser —
// same reasoning as the fbPages/liPages maps in browserTools.ts.
const contexts = new Map<string, BrowserContext>();

function keyFor(nickname?: string): string {
  return nickname || 'default';
}

export async function closeGoogleSiteBrowser(nickname?: string): Promise<void> {
  const key = keyFor(nickname);
  const ctx = contexts.get(key);
  if (ctx) {
    await ctx.close().catch(() => {});
    if (contexts.get(key) === ctx) contexts.delete(key);
    console.log(`   Google Sites browser closed (${key}).`);
  }
}

// Cleanup-all — used by the process-wide "close everything" path. Closes
// every account's context, not just one.
export async function closeAllGoogleSiteBrowsers(): Promise<void> {
  for (const [key, ctx] of contexts) {
    await ctx.close().catch(() => {});
    contexts.delete(key);
  }
}

export async function loginToGoogleSite(options?: {
  email?: string;
  password?: string;
  nickname?: string;
  headless?: boolean;
  batchMode?: boolean;
}): Promise<Page> {
  const account = options?.nickname
    ? getGoogleSiteAccountByNickname(options.nickname) ?? getActiveGoogleSiteAccount()
    : getActiveGoogleSiteAccount();

  const key = keyFor(options?.nickname || account?.nickname);
  const email = options?.email || account?.email || process.env.GOOGLESITE_EMAIL || '';

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir
    ? path.resolve(account.sessionDir)
    : email
      ? sessionDirFor(email)
      : path.join(SESSION_ROOT, account?.nickname || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  // Remove Chrome's singleton lock files that get left behind after crashes.
  // If these exist, Chrome opens about:blank and exits without creating a window.
  for (const lockFile of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const lockPath = path.join(sessionDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); console.log(`   🧹 Removed stale lock: ${lockFile}`); } catch { /* ignore */ }
    }
  }

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Google Sites browser...');

  const headless = options?.headless ?? true;
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      ...(headless ? ['--start-minimized'] : []),
      '--disable-gpu',
      '--disable-software-rasterizer',
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

  // Register this account's context immediately so a concurrent call for a
  // different account can never see/close it, and closeGoogleSiteBrowser(key)
  // works even if login fails partway through below.
  contexts.set(key, context);

  await context.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
  });

  // Grant clipboard permissions so we can paste HTML content
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Minimize window immediately so it doesn't disturb the screen (skip when
  // running with a visible window for manual login — minimizing would defeat it)
  if (headless) {
    try {
      const tmpPage = context.pages()[0] || await context.newPage();
      const cdp = await context.newCDPSession(tmpPage);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.detach().catch(() => {});
    } catch { /* ignore — non-critical */ }
  }

  // Reuse the page the persistent context opened; close any extras
  const existingPages = context.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await context.newPage();
  }

  // Let Chrome fully initialise before navigating
  await sleep(2000);

  // Go to Google Sites — retry up to 5 times if we land on about:blank
  console.log('   Navigating to Google Sites...');
  let navUrl = 'about:blank';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.goto('https://sites.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr: any) {
      console.log(`   ⚠️ goto error on attempt ${attempt}: ${navErr.message?.split('\n')[0]}`);
    }
    navUrl = page.url();
    if (navUrl !== 'about:blank' && navUrl !== '') break;
    console.log(`   ⚠️ Got about:blank on attempt ${attempt} — retrying in 5s...`);
    await sleep(5000);
  }
  if (navUrl === 'about:blank' || navUrl === '') {
    throw new Error('Google Sites failed to load after 5 attempts (about:blank)');
  }

  // Wait 5 seconds for session check
  console.log('   Waiting 5 seconds for session check...');
  await sleep(5000);

  // Check if already logged in — must be on sites.google.com, not accounts.google.com
  const isLoggedIn = () => {
    const url = page.url();
    return url.includes('sites.google.com') && !url.includes('accounts.google.com');
  };
  if (isLoggedIn()) {
    console.log(`   ✅ Already logged in to Google Sites`);
    return page;
  }

  if (!headless) {
    // Manual mode: keep the window open and poll until the user finishes
    // logging in through the visible browser, instead of failing immediately.
    console.log(`   ⏳ Not logged in — complete the login in the visible browser window.`);
    const timeoutMs = 5 * 60 * 1000;
    const pollMs = 3000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (isLoggedIn()) {
        console.log(`   ✅ Login detected`);
        return page;
      }
    }
    await closeGoogleSiteBrowser(key);
    throw new Error(`Google Sites: manual login timed out after ${timeoutMs / 1000}s for ${email}`);
  }

  // Automated (headless) mode: fail fast — session must be pre-saved via manual login
  await closeGoogleSiteBrowser();
  throw new Error(`Google Sites session expired for ${email} — re-run save-googlesite-session`);
}

