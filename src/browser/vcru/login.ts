import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';
import { safeCloseContext } from '../../utils/safeClose.js';

const VCRU_ACCOUNTS_FILE = '.accounts/accounts-vcru.json';
const SESSION_ROOT = path.resolve('.sessions/vcru');

export interface VcruAccount {
  email: string;
  password: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getVcruAccounts(): VcruAccount[] {
  if (!fs.existsSync(VCRU_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(VCRU_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveVcruAccount(): VcruAccount | null {
  return getVcruAccounts().find(a => a.active) || null;
}

export function getVcruAccountByNickname(nickname: string): VcruAccount | null {
  return getVcruAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;
let currentSessionDir: string | null = null;

export async function closeVcruBrowser(): Promise<void> {
  await safeCloseContext(browserContext, { label: 'Vcru', sessionDir: currentSessionDir });
  browserContext = null;
}

export async function loginToVcru(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getVcruAccountByNickname(options.nickname)
    : getActiveVcruAccount();

  if (options?.nickname && !account) {
    throw new Error(`vc.ru account "${options.nickname}" not found in ${VCRU_ACCOUNTS_FILE}`);
  }

  const email = options?.email || account?.email || process.env.VCRU_EMAIL || '';

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);
  currentSessionDir = sessionDir;

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching vc.ru browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: process.env.HEADLESS !== 'false',
    executablePath: chromePath,
    viewport: { width: 1280, height: 800 },
    slowMo: 120,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
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

  // Only minimize in headless mode (a no-op there, but harmless) — a manual
  // login needs the window actually visible when HEADLESS=false.
  if (process.env.HEADLESS !== 'false') {
    try {
      const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
      const cdp = await browserContext.newCDPSession(tmpPage);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.detach().catch(() => {});
    } catch { /* ignore */ }
  }

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  // Trust the saved session profile — no login-state check, no explicit
  // /login navigation. Just open vc.ru, give it a moment to settle, and hand
  // the page straight to the automation.
  //
  // TODO (awaiting real selectors from the user): if a fresh session needs
  // an explicit login form filled (email/password fields, submit button),
  // that flow goes here — currently this only opens the site and relies on
  // a session already saved via `waitForY()` below during manual first-run.
  console.log('   Opening vc.ru with saved session...');
  await page.goto('https://vc.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000 + Math.floor(Math.random() * 1000));
  return page;
}

async function waitForY(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write('\n👉 Complete login in the browser, then press Y + Enter to save session: ');
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

  console.log(`\n🔐 vc.ru Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToVcru({ nickname });
    await waitForY();
    console.log('\n✅ Session saved. Exiting.');
    process.exit(0);
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('vcru/login') || process.argv[1]?.includes('vcru\\login')) main();
