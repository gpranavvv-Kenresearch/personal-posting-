import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const ARTICLESCAD_ACCOUNTS_FILE = '.accounts/accounts-articlescad.json';
const SESSION_ROOT = path.resolve('.sessions/articlescad');

export interface ArticlescadAccount {
  email: string;
  password: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getArticlescadAccounts(): ArticlescadAccount[] {
  if (!fs.existsSync(ARTICLESCAD_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ARTICLESCAD_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveArticlescadAccount(): ArticlescadAccount | null {
  return getArticlescadAccounts().find(a => a.active) || null;
}

export function getArticlescadAccountByNickname(nickname: string): ArticlescadAccount | null {
  return getArticlescadAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeArticlescadBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Articlescad browser closed.');
  }
}

async function isAlreadyLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('https://articlescad.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const url = page.url();
    if (url.includes('/login') || url.includes('/signin')) return false;
    const loggedInEl = await page.$('a[href*="logout"], a[href*="/dashboard"], a[href*="/account"], a[href*="/profile"], a[href*="/new"], a[href*="/submit"]');
    return !!loggedInEl;
  } catch {
    return false;
  }
}

export async function loginToArticlescad(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getArticlescadAccountByNickname(options.nickname)
    : getActiveArticlescadAccount();

  if (options?.nickname && !account) {
    throw new Error(`Articlescad account "${options.nickname}" not found in ${ARTICLESCAD_ACCOUNTS_FILE}`);
  }

  const email    = options?.email    || account?.email    || process.env.ARTICLESCAD_EMAIL    || '';
  const password = options?.password || account?.password || process.env.ARTICLESCAD_PASSWORD || '';

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Articlescad browser...');

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

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  try {
    const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
    const cdp = await browserContext.newCDPSession(tmpPage);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  console.log('   Checking saved session...');
  const loggedIn = await isAlreadyLoggedIn(page);
  if (loggedIn) {
    console.log('   âœ… Already logged in to Articlescad via saved session');
    return page;
  }

  console.log('   Opening Articlescad login page...');
  await page.goto('https://articlescad.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  if (email && password) {
    await page.fill('input[name="email"], input[type="email"]', email).catch(() => {});
    await sleep(500);
    await page.fill('input[name="password"], input[type="password"]', password).catch(() => {});
    await sleep(500);
    await page.keyboard.press('Enter');
    await sleep(4000);

    const loginSucceeded = await isAlreadyLoggedIn(page);
    if (loginSucceeded) {
      console.log('   âœ… Login successful');
      return page;
    }
  }

  console.log(`   ðŸ‘‰ Complete login in the browser window...`);
  return page;
}

async function waitForY(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write('\nðŸ‘‰ Complete login in the browser, then press Y + Enter to save session: ');
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      if (chunk.toString().trim().toLowerCase() === 'y') {
        process.stdin.pause();
        resolve();
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : (args[0] && !args[0].startsWith('--') ? args[0] : undefined);

  console.log(`\nðŸ” Articlescad Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToArticlescad({ nickname });
    await waitForY();
    console.log('\nâœ… Session saved. Exiting.');
    process.exit(0);
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('articlescad/login') || process.argv[1]?.includes('articlescad\\login')) main();

