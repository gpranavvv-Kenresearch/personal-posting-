import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';

// TODO(locators): 4shared's login form is best-effort — confirm field names
// against the live DOM on first authenticated test run, same convention as
// every other platform in this repo. 4shared also allows anonymous uploads
// (no account required, same as PdfHost), so login is only attempted when
// credentials are on file.
const FOURSHARED_LOGIN_URL = 'https://www.4shared.com/web/login';
const FOURSHARED_HOME_URL = 'https://www.4shared.com/';
const FOURSHARED_MYFILES_URL = 'https://www.4shared.com/web/account/myFiles';

const FOURSHARED_ACCOUNTS_FILE = '.accounts/accounts-fourshared.json';
const SESSION_ROOT = path.resolve('.sessions/fourshared');

export interface FourSharedAccount {
  email: string;
  password?: string;
  nickname?: string;
  sessionDir?: string;
  active: boolean;
}

export function getFourSharedAccounts(): FourSharedAccount[] {
  if (!fs.existsSync(FOURSHARED_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(FOURSHARED_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveFourSharedAccount(): FourSharedAccount | null {
  return getFourSharedAccounts().find(a => a.active) || null;
}

export function getFourSharedAccountByNickname(nickname: string): FourSharedAccount | null {
  return getFourSharedAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeFourSharedBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   4shared browser closed.');
  }
}

// A "not redirected to /login" check was a false positive — 4shared can
// show myFiles in some logged-out state without the URL ever containing
// "/login". Require a real logged-in-only element instead: the "+Add"
// button (button._addBtn_1r54u_48) confirmed live on the myFiles page only
// appears once actually authenticated.
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto(FOURSHARED_MYFILES_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    if (page.url().includes('/login')) return false;
    return await page.locator('button._addBtn_1r54u_48').first().isVisible({ timeout: 5000 }).catch(() => false);
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
  console.log(`   Using 4shared session: ${sessionDir}`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
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

export async function loginToFourShared(options?: { nickname?: string; interactive?: boolean }): Promise<Page> {
  const account = options?.nickname
    ? getFourSharedAccountByNickname(options.nickname) ?? getActiveFourSharedAccount()
    : getActiveFourSharedAccount();

  if (!account) throw new Error('No 4shared account found in .accounts/accounts-fourshared.json');

  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');
  const page = await launchContext(sessionDir);

  const hasCredentials = !!(account.email && account.password);

  // Always check the saved session first, regardless of whether credentials
  // are on file — a manual/interactive login (no password ever stored) can
  // still have left a perfectly valid persistent session behind, and that
  // must not get thrown away in favor of anonymous mode just because the
  // JSON entry has no password.
  console.log('   Checking 4shared session...');
  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to 4shared (${account.nickname})`);
    return page;
  }

  // No valid session AND no way to establish one (no stored credentials to
  // auto-fill, and this isn't an interactive/manual run with a human at the
  // terminal) → anonymous upload mode, the only option left.
  if (!hasCredentials && !options?.interactive) {
    console.log('   Not logged in and no stored credentials — proceeding anonymously.');
    await page.goto(FOURSHARED_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    return page;
  }

  console.log('   Not logged in — starting 4shared login...');
  await page.goto(FOURSHARED_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Auto-fill only if real credentials are on file. When called with
  // interactive:true and no stored password (the manual-onboarding path —
  // no credentials ever get typed or saved by this script), skip straight
  // to the manual wait below.
  if (hasCredentials) {
    try {
      const emailInput = page.locator('input[name="login"], input[name="email"], input[type="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.click();
      await page.keyboard.type(account.email, { delay: 80 });
      await sleep(300);

      const pwInput = page.locator('input[name="password"], input[type="password"]').first();
      await pwInput.click();
      await page.keyboard.type(account.password!, { delay: 80 });
      await sleep(300);

      const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await sleep(2500);
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill 4shared login: ${err.message}`);
      console.log('   👉 Please log in manually in the browser window.\n');
    }
  } else {
    console.log('   👉 Please log in manually in the browser window (no stored credentials — this script never types or saves a password).\n');
  }

  if (!(await isLoggedIn(page))) {
    console.log('   ⏳ Not detected as logged in yet.');
    await waitForEnter('   If you need to finish logging in manually (captcha, 2FA, etc.), do so now, then press Enter here... ');
  }

  if (!(await isLoggedIn(page))) {
    await closeFourSharedBrowser();
    throw new Error('4shared login failed — still redirected to login after confirmation.');
  }

  console.log(`   ✅ 4shared login confirmed (${account.nickname}).`);
  return page;
}

// Standalone: npx tsx src/browser/fourshared/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 4shared Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToFourShared({ nickname, interactive: true });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('fourshared/login') || process.argv[1]?.includes('fourshared\\login')) main();
