import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const LINKMATE_ACCOUNTS_FILE = '.accounts/accounts-linkmate.json';
const SESSION_ROOT = path.resolve('.sessions/linkmate');

export interface LinkmateAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  utm?: string;
  active: boolean;
}

export function getLinkmateAccounts(): LinkmateAccount[] {
  if (!fs.existsSync(LINKMATE_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(LINKMATE_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveLinkmateAccount(): LinkmateAccount | null {
  return getLinkmateAccounts().find(a => a.active) || null;
}

export function getLinkmateAccountByNickname(nickname: string): LinkmateAccount | null {
  return getLinkmateAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeLinkmeateBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Linkmate browser closed.');
  }
}

export async function loginToLinkmate(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getLinkmateAccountByNickname(options.nickname) ?? getActiveLinkmateAccount()
    : getActiveLinkmateAccount();

  const email    = options?.email    || account?.email    || process.env.LINKMATE_EMAIL;
  const password = options?.password || account?.password || process.env.LINKMATE_PASSWORD;

  if (!email) {
    throw new Error(`Linkmate email missing. Add account to .accounts/accounts-linkmate.json or set LINKMATE_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  // Don't create if it doesn't exist - use existing saved session
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Linkmate browser...');

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

  // Minimize window immediately so it doesn't disturb the screen
  try {
    const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
    const cdp = await browserContext.newCDPSession(tmpPage);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore — non-critical */ }

  // Reuse the page the persistent context opened; close any extras
  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  // Go to Linkmate — trust the saved session, no waiting
  console.log('   Navigating to Linkmate...');
  await page.goto('https://linkmate.mn.co/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  const url = page.url();
  if (url.includes('/sign_in') || url.includes('/login')) {
    await closeLinkmeateBrowser();
    throw new Error(`No active Linkmate session for "${options?.nickname}". Run: npm run dev -- save-linkmate-session ${options?.nickname}`);
  }

  console.log(`   ✅ Session loaded for Linkmate (${options?.nickname ?? email})`);
  return page;
}
