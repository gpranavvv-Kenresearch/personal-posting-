import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const HACKMD_ACCOUNTS_FILE = '.accounts/accounts-hackmd.json';
const SESSION_ROOT = path.resolve('.sessions/hackmd');

export interface HackMDAccount {
  email: string;
  password: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getHackMDAccounts(): HackMDAccount[] {
  if (!fs.existsSync(HACKMD_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(HACKMD_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveHackMDAccount(): HackMDAccount | null {
  return getHackMDAccounts().find(a => a.active) || null;
}

export function getHackMDAccountByNickname(nickname: string): HackMDAccount | null {
  return getHackMDAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeHackMDBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   HackMD browser closed.');
  }
}

async function isAlreadyLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('https://hackmd.io/?nav=overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    const loggedInSelectors = [
      'a[href="/logout"]',
      'img.avatar',
      'div.navbar-user-dropdown',
      'a[href*="settings"]',
      'li.nav-item.dropdown.user',
    ];

    for (const selector of loggedInSelectors) {
      const el = await page.$(selector);
      if (el) {
        console.log(`   [session] ✅ Session active — found: ${selector}`);
        return true;
      }
    }

    const currentUrl = page.url();
    // If not on login page, session is active (HackMD may redirect to /, team page, etc.)
    if (!currentUrl.includes('/login') && !currentUrl.includes('accounts.')) {
      console.log('   [session] ✅ Session active — not on login page');
      return true;
    }

    return false;
  } catch (err: any) {
    console.warn('   [session] ⚠️ Error checking login state:', err.message);
    return false;
  }
}

export async function loginToHackMD(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getHackMDAccountByNickname(options.nickname) ?? getActiveHackMDAccount()
    : getActiveHackMDAccount();

  const email    = options?.email    || account?.email    || process.env.HACKMD_EMAIL!;
  const password = options?.password || account?.password || process.env.HACKMD_PASSWORD!;

  if (!email || !password) {
    throw new Error('HackMD credentials missing. Set HACKMD_EMAIL and HACKMD_PASSWORD env vars or add to accounts-hackmd.json.');
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  fs.mkdirSync(sessionDir, { recursive: true });

  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching HackMD browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: chromePath,
    viewport: { width: 1280, height: 800 },
    slowMo: 120,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-minimized',
      '--window-size=1366,768',
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

  await browserContext.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
  });

  // Minimize window immediately so it doesn't disturb the screen
  try {
    const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
    const cdp = await browserContext.newCDPSession(tmpPage);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore — non-critical */ }

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  // Check if already logged in via saved session
  console.log('   Checking saved session...');
  const loggedIn = await isAlreadyLoggedIn(page);
  if (loggedIn) {
    console.log('   ✅ Already logged in to HackMD via saved session');
    return page;
  }

  // Attempt credential login
  console.log('   Session not valid — proceeding with credential login...');
  await page.goto('https://hackmd.io/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  const emailInput = page.locator('input[name="email"]:visible, input[type="email"]:visible').first();
  const passwordInput = page.locator('input[name="password"]:visible, input[type="password"]:visible').first();

  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await passwordInput.waitFor({ state: 'visible', timeout: 15000 });

  await emailInput.fill(email);
  await passwordInput.fill(password);

  const submitCandidates = [
    page.locator('button[type="submit"]'),
    page.getByRole('button', { name: /login|sign in/i }),
    page.locator('text=Login'),
    page.locator('text=Sign in'),
  ];

  let submitButton = null;
  for (const candidate of submitCandidates) {
    const first = candidate.first();
    if (await first.isVisible().catch(() => false)) {
      submitButton = first;
      break;
    }
  }

  if (!submitButton) {
    submitButton = submitCandidates[0].first();
    await submitButton.waitFor({ state: 'visible', timeout: 15000 });
  }

  await submitButton.click();
  await sleep(3000);

  // Check login success
  const loginSucceeded = await isAlreadyLoggedIn(page);
  if (loginSucceeded) {
    console.log('   ✅ Login successful — session saved');
    return page;
  }

  await closeHackMDBrowser();
  throw new Error(`Unable to log in to HackMD as ${email}. Session expired — run save-hackmd-session manually.`);
}

