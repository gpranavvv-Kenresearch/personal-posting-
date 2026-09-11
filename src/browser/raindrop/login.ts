import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';

// TODO(locators): Raindrop.io's app shell is a React SPA — selectors below
// are best-effort guesses against the public /login form. Confirm against
// the real DOM on first authenticated test run and fix any that miss, same
// convention as Issuu/Naver.
const RAINDROP_LOGIN_URL = 'https://app.raindrop.io/login';
const RAINDROP_HOME_URL = 'https://app.raindrop.io/my/0';

const RAINDROP_ACCOUNTS_FILE = '.accounts/accounts-raindrop.json';
const SESSION_ROOT = path.resolve('.sessions/raindrop');

export interface RaindropAccount {
  email: string;
  password?: string;
  nickname?: string;
  collection?: string; // target collection name, defaults to "Unsorted"
  sessionDir?: string;
  active: boolean;
}

export function getRaindropAccounts(): RaindropAccount[] {
  if (!fs.existsSync(RAINDROP_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(RAINDROP_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveRaindropAccount(): RaindropAccount | null {
  return getRaindropAccounts().find(a => a.active) || null;
}

export function getRaindropAccountByNickname(nickname: string): RaindropAccount | null {
  return getRaindropAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeRaindropBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Raindrop browser closed.');
  }
}

// Checks the CURRENT page first (no reload) — Raindrop is a heavy SPA, and a
// hard reload straight to a deep collection URL right after login can race
// the session hydration and bounce back to /login even though the account is
// actually authenticated. Only reload as a fallback if the current URL is
// inconclusive.
async function isLoggedIn(page: Page, opts?: { forceReload?: boolean }): Promise<boolean> {
  try {
    if (!opts?.forceReload && page.url().includes('app.raindrop.io') && !page.url().includes('/login')) {
      return true;
    }
    await page.goto(RAINDROP_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(4000);
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
  console.log(`   Using Raindrop session: ${sessionDir}`);

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

export async function loginToRaindrop(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getRaindropAccountByNickname(options.nickname) ?? getActiveRaindropAccount()
    : getActiveRaindropAccount();

  if (!account) throw new Error('No Raindrop account found in .accounts/accounts-raindrop.json');

  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');
  const page = await launchContext(sessionDir);

  console.log('   Checking Raindrop session...');
  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Raindrop (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Raindrop login...');
  await page.goto(RAINDROP_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);

  if (account.email && account.password) {
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
      await sleep(3000);
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Raindrop login: ${err.message}`);
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
    await closeRaindropBrowser();
    throw new Error('Raindrop login failed — still redirected to login after confirmation.');
  }

  console.log(`   ✅ Raindrop login confirmed (${account.nickname}).`);
  return page;
}

// Standalone: npx tsx src/browser/raindrop/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Raindrop Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToRaindrop({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('raindrop/login') || process.argv[1]?.includes('raindrop\\login')) main();
