import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';
import { waitForPageReady } from '../stagehand.js';

// Confirmed live (2026-08-18): Scribd's login form actually lives on
// auth.scribd.com (Auth0), reached by navigating to scribd.com/login and
// following the redirect. Real fields: input#username, input#password,
// button[name="action"] (text "Continue"). A hidden captcha field is
// present in the DOM — normally inert, but can activate on suspicious
// automated logins, in which case this falls back to manual completion
// like every other platform in this repo.
const SCRIBD_LOGIN_URL = 'https://www.scribd.com/login';
const SCRIBD_UPLOAD_URL = 'https://www.scribd.com/upload-document';

const SCRIBD_ACCOUNTS_FILE = '.accounts/accounts-scribd.json';
const SESSION_ROOT = path.resolve('.sessions/scribd');

export interface ScribdAccount {
  email: string;
  password?: string;
  nickname?: string;
  sessionDir?: string;
  active: boolean;
}

export function getScribdAccounts(): ScribdAccount[] {
  if (!fs.existsSync(SCRIBD_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(SCRIBD_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveScribdAccount(): ScribdAccount | null {
  return getScribdAccounts().find(a => a.active) || null;
}

export function getScribdAccountByNickname(nickname: string): ScribdAccount | null {
  return getScribdAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeScribdBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Scribd browser closed.');
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto(SCRIBD_UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await waitForPageReady(page);
    await sleep(1000);
    // Logged-out upload page shows a "Sign in" button; logged-in shows the
    // uploader's own account menu instead.
    const signInVisible = await page.getByRole('button', { name: /^sign in$/i }).first().isVisible({ timeout: 3000 }).catch(() => false);
    return !signInVisible;
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
  console.log(`   Using Scribd session: ${sessionDir}`);

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

export async function loginToScribd(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getScribdAccountByNickname(options.nickname) ?? getActiveScribdAccount()
    : getActiveScribdAccount();

  if (!account) throw new Error('No Scribd account found in .accounts/accounts-scribd.json');

  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');
  const page = await launchContext(sessionDir);

  console.log('   Checking Scribd session...');
  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Scribd (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Scribd login...');
  await page.goto(SCRIBD_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForPageReady(page);
  await sleep(1500);

  if (account.email && account.password) {
    try {
      const emailInput = page.locator('input#username, input[name="username"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 15000 });
      await emailInput.click();
      await page.keyboard.type(account.email, { delay: 80 });
      await sleep(300);

      // Explicitly wait for the password field rather than clicking blind —
      // on a slow-loading auth.scribd.com redirect it may not have rendered
      // yet even though the email field already had.
      const pwInput = page.locator('input#password, input[name="password"]').first();
      await pwInput.waitFor({ state: 'visible', timeout: 10000 });
      await pwInput.click();
      await page.keyboard.type(account.password, { delay: 80 });
      await sleep(300);

      const submitBtn = page.locator('button[name="action"]').first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await sleep(3000);
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Scribd login: ${err.message}`);
      console.log('   👉 Please log in manually in the browser window.\n');
    }
  } else {
    console.log('   👉 Please log in manually in the browser window.\n');
  }

  if (!(await isLoggedIn(page))) {
    console.log('   ⏳ Not detected as logged in yet.');
    await waitForEnter('   If you need to finish logging in manually (captcha, 2FA, etc.), do so now, then press Enter here... ');
  }

  if (!(await isLoggedIn(page))) {
    await closeScribdBrowser();
    throw new Error('Scribd login failed — still detected as logged out after confirmation.');
  }

  console.log(`   ✅ Scribd login confirmed (${account.nickname}).`);
  return page;
}

// Standalone: npx tsx src/browser/scribd/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Scribd Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToScribd({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('scribd/login') || process.argv[1]?.includes('scribd\\login')) main();
