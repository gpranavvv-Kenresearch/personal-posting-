import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const NOTE_ACCOUNTS_FILE = '.accounts/accounts-note.json';
const SESSION_ROOT = path.resolve('.sessions/note');

export interface NoteAccount {
  email: string;
  password: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getNoteAccounts(): NoteAccount[] {
  if (!fs.existsSync(NOTE_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(NOTE_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveNoteAccount(): NoteAccount | null {
  return getNoteAccounts().find(a => a.active) || null;
}

export function getNoteAccountByNickname(nickname: string): NoteAccount | null {
  return getNoteAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeNoteBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Note browser closed.');
  }
}

async function isAlreadyLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
    const url = page.url();
    if (url.includes('/login')) return false;
    const loggedInEl = await page.$('a[href*="/notes/new"], button[data-testid="header-post-button"], a[href*="/settings"]');
    return !!loggedInEl;
  } catch {
    return false;
  }
}

export async function loginToNote(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getNoteAccountByNickname(options.nickname)
    : getActiveNoteAccount();

  if (options?.nickname && !account) {
    throw new Error(`Note account "${options.nickname}" not found in ${NOTE_ACCOUNTS_FILE}`);
  }

  const email    = options?.email    || account?.email    || process.env.NOTE_EMAIL    || '';
  const password = options?.password || account?.password || process.env.NOTE_PASSWORD || '';

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Note browser...');

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
  // Google-OAuth login needs the window actually visible when HEADLESS=false.
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

  // Check saved session
  console.log('   Checking saved session...');
  const loggedIn = await isAlreadyLoggedIn(page);
  if (loggedIn) {
    console.log('   ✅ Already logged in to Note via saved session');
    return page;
  }

  // Open login page — user completes via Google
  console.log('   Opening Note login page...');
  await page.goto('https://note.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Auto-fill email+password only if credentials provided
  if (email && password) {
    await page.fill('input[name="email"]', email).catch(() =>
      page.fill('input[type="email"]', email)
    );
    await sleep(500);
    await page.fill('input[name="password"]', password).catch(() =>
      page.fill('input[type="password"]', password)
    );
    await sleep(500);
    await page.keyboard.press('Enter');
    await sleep(4000);

    const loginSucceeded = await isAlreadyLoggedIn(page);
    if (loginSucceeded) {
      console.log('   ✅ Login successful');
      return page;
    }
  }

  // Wait for manual login (Google OAuth or OTP)
  console.log(`   👉 Login with Google in the browser window...`);
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

  console.log(`\n🔐 Note Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToNote({ nickname });
    await waitForY();
    console.log('\n✅ Session saved. Exiting.');
    process.exit(0);
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('note/login') || process.argv[1]?.includes('note\\login')) main();

