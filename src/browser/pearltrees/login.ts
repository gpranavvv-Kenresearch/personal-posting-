import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';

// Confirmed live (2026-08-13): Pearltrees has no dedicated /login route (it
// 404s to /ooops) — the login form lives on the homepage itself, revealed by
// clicking the "Log in" tab next to the default "Join" (signup) tab. Once
// clicked, the real form fields are #log_username / #log_password with a
// plain input[type="submit"]. Signup itself sits behind a live reCAPTCHA
// Enterprise widget, so new accounts must be created manually — this file
// only handles logging into an already-created account.
const PEARLTREES_HOME_URL = 'https://www.pearltrees.com/';

const PEARLTREES_ACCOUNTS_FILE = '.accounts/accounts-pearltrees.json';
const SESSION_ROOT = path.resolve('.sessions/pearltrees');

export interface PearltreesAccount {
  email: string;
  username?: string;
  password?: string;
  nickname?: string;
  sessionDir?: string;
  active: boolean;
}

export function getPearltreesAccounts(): PearltreesAccount[] {
  if (!fs.existsSync(PEARLTREES_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PEARLTREES_ACCOUNTS_FILE, 'utf8'));
}

export function getActivePearltreesAccount(): PearltreesAccount | null {
  return getPearltreesAccounts().find(a => a.active) || null;
}

export function getPearltreesAccountByNickname(nickname: string): PearltreesAccount | null {
  return getPearltreesAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closePearltreesBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Pearltrees browser closed.');
  }
}

// The homepage renders the "Join / Log in" form for logged-out visitors and
// a normal browse UI (with a user avatar/menu, no #log_username field) once
// logged in — presence of the login field is the most stable signal.
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto(PEARLTREES_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    const loginFieldVisible = await page.locator('#log_username').isVisible({ timeout: 3000 }).catch(() => false);
    return !loginFieldVisible;
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
  console.log(`   Using Pearltrees session: ${sessionDir}`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: process.env.HEADLESS !== 'false',
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    permissions: ['clipboard-read', 'clipboard-write'],
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

export async function loginToPearltrees(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getPearltreesAccountByNickname(options.nickname) ?? getActivePearltreesAccount()
    : getActivePearltreesAccount();

  if (!account) throw new Error('No Pearltrees account found in .accounts/accounts-pearltrees.json');

  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');
  const page = await launchContext(sessionDir);

  console.log('   Checking Pearltrees session...');
  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Pearltrees (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Pearltrees login...');
  if (account.username && account.password) {
    try {
      // The "Log in" tab must be clicked first — #log_username/#log_password
      // are hidden behind the default "Join" (signup) tab on page load.
      const loginTab = page.getByText('Log in', { exact: true }).first();
      await loginTab.click({ timeout: 8000 });
      await sleep(600);

      const userInput = page.locator('#log_username').first();
      await userInput.waitFor({ state: 'visible', timeout: 8000 });
      await userInput.click();
      await page.keyboard.type(account.username, { delay: 80 });
      await sleep(300);

      const pwInput = page.locator('#log_password').first();
      await pwInput.click();
      await page.keyboard.type(account.password, { delay: 80 });
      await sleep(300);

      const submitBtn = page.locator('#log_username').locator('xpath=ancestor::form[1]//input[@type="submit"]').first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await sleep(3000);
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Pearltrees login: ${err.message}`);
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
    await closePearltreesBrowser();
    throw new Error('Pearltrees login failed — still on the logged-out homepage after confirmation.');
  }

  console.log(`   ✅ Pearltrees login confirmed (${account.nickname}).`);
  return page;
}

// Standalone: npx tsx src/browser/pearltrees/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Pearltrees Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToPearltrees({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('pearltrees/login') || process.argv[1]?.includes('pearltrees\\login')) main();
