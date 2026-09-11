import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';

// PdfHost.io allows anonymous uploads (no account required), but an account
// keeps uploaded files listed/manageable — so login is attempted only when
// credentials are on file, same as the manual-login-first rollout used for
// Coda/Naver. Anonymous mode just opens the persistent session and proceeds.
const PDFHOST_LOGIN_URL = 'https://pdfhost.io/login';
const PDFHOST_HOME_URL = 'https://pdfhost.io/';
const PDFHOST_DASHBOARD_URL = 'https://pdfhost.io/dashboard';

const PDFHOST_ACCOUNTS_FILE = '.accounts/accounts-pdfhost.json';
const SESSION_ROOT = path.resolve('.sessions/pdfhost');

export interface PdfHostAccount {
  email: string;
  password?: string;
  nickname?: string;
  sessionDir?: string;
  active: boolean;
}

export function getPdfHostAccounts(): PdfHostAccount[] {
  if (!fs.existsSync(PDFHOST_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PDFHOST_ACCOUNTS_FILE, 'utf8'));
}

export function getActivePdfHostAccount(): PdfHostAccount | null {
  return getPdfHostAccounts().find(a => a.active) || null;
}

export function getPdfHostAccountByNickname(nickname: string): PdfHostAccount | null {
  return getPdfHostAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closePdfHostBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   PdfHost browser closed.');
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto(PDFHOST_DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(1500);
    return !page.url().includes('/login');
  } catch {
    return false;
  }
}

async function waitForEnter(promptText: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(promptText);
  rl.close();
}

async function launchContext(sessionDir: string): Promise<Page> {
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  console.log(`   Using PdfHost session: ${sessionDir}`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: process.env.HEADLESS !== 'false',
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: null,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });

  await browserContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    (window as any).chrome = (window as any).chrome || { runtime: {} };
  });

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }
  return page;
}

export async function loginToPdfHost(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getPdfHostAccountByNickname(options.nickname) ?? getActivePdfHostAccount()
    : getActivePdfHostAccount();

  if (!account) throw new Error('No PdfHost account found in .accounts/accounts-pdfhost.json');

  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');
  const page = await launchContext(sessionDir);

  // No credentials on file → anonymous upload mode, no login needed.
  if (!account.email || !account.password) {
    console.log('   No PdfHost credentials on file — proceeding anonymously.');
    await page.goto(PDFHOST_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    return page;
  }

  console.log('   Checking PdfHost session...');
  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to PdfHost (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting PdfHost login...');
  await page.goto(PDFHOST_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  try {
    const emailInput = page.locator('input[name="email"], input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.click();
    await page.keyboard.type(account.email, { delay: 80 });
    await sleep(300);

    const pwInput = page.locator('input[name="password"], input[type="password"]').first();
    await pwInput.click();
    await page.keyboard.type(account.password, { delay: 80 });
    await sleep(300);

    const submitBtn = page.locator('button[type="submit"]').first();
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await sleep(2500);
  } catch (err: any) {
    console.warn(`   ⚠️ Could not auto-fill PdfHost login: ${err.message}`);
    console.log('   👉 Please log in manually in the browser window.\n');
  }

  if (!(await isLoggedIn(page))) {
    console.log('   ⏳ Not detected as logged in yet.');
    await waitForEnter('   If you need to finish logging in manually (captcha, 2FA, etc.), do so now, then press Enter here... ');
  }

  if (!(await isLoggedIn(page))) {
    await closePdfHostBrowser();
    throw new Error('PdfHost login failed — still redirected to login after confirmation.');
  }

  console.log(`   ✅ PdfHost login confirmed (${account.nickname}).`);
  return page;
}

// Standalone: npx tsx src/browser/pdfhost/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 PdfHost Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToPdfHost({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('pdfhost/login') || process.argv[1]?.includes('pdfhost\\login')) main();
