import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

// TODO(locators): coda.io login supports Google OAuth and email magic-link.
// Confirm which flow the automation accounts use and update CODA_LOGIN_URL /
// the fill-in flow below accordingly.
const CODA_LOGIN_URL = 'https://coda.io/login';
const CODA_HOME_URL = 'https://coda.io/docs';

const CODA_ACCOUNTS_FILE = '.accounts/accounts-coda.json';
const SESSION_ROOT = path.resolve('.sessions/coda');

export interface CodaAccount {
  email: string;
  password?: string;
  nickname?: string;
  docUrl?: string; // target Coda doc to publish pages into
  sessionDir?: string;
  active: boolean;
}

export function getCodaAccounts(): CodaAccount[] {
  if (!fs.existsSync(CODA_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(CODA_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveCodaAccount(): CodaAccount | null {
  return getCodaAccounts().find(a => a.active) || null;
}

export function getCodaAccountByNickname(nickname: string): CodaAccount | null {
  return getCodaAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeCodaBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Coda browser closed.');
  }
}

function pageLooksLoggedIn(url: string): boolean {
  if (url.includes('/login') || url.includes('accounts.google.com') || url.includes('accounts.youtube.com')) {
    return false;
  }
  // coda.io redirects unauthenticated visitors to /login (or Google OAuth) —
  // landing anywhere else under coda.io means the session is authenticated.
  return url.includes('coda.io');
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return pageLooksLoggedIn(page.url());
  } catch {
    return false;
  }
}

// Google OAuth can open the account picker in a new tab/popup, leaving the
// originally-tracked page stuck on /login while a different tab in the same
// context reaches the real Coda home page — so scan every open tab.
function findLoggedInPage(context: BrowserContext): Page | null {
  for (const p of context.pages()) {
    if (pageLooksLoggedIn(p.url())) return p;
  }
  return null;
}

export async function loginToCoda(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getCodaAccountByNickname(options.nickname) ?? getActiveCodaAccount()
    : getActiveCodaAccount();

  if (!account) throw new Error('No Coda account found in .accounts/accounts-coda.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Coda session: ${sessionDir}`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
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

  console.log('   Opening Coda with saved session...');
  await page.goto(CODA_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // The persistent profile (.sessions/coda/<nickname>) already holds a valid
  // login — skip the login-state verification/redirect check entirely and
  // trust the saved session, per explicit instruction to stop probing for
  // login state on every run.
  if (!page.url().includes('/login')) {
    console.log(`   ✅ Using saved Coda session (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Coda login...');
  await page.goto(CODA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // TODO(locators): fill in email/password or Google OAuth handoff once
  // confirmed. Left as manual fallback for now.
  if (account.email && account.password) {
    try {
      const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.fill(account.email);
      await sleep(500);
      const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await sleep(1500);
      }
      const passInput = page.locator('input[type="password"]').first();
      if (await passInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passInput.fill(account.password);
        await sleep(300);
        await page.keyboard.press('Enter');
        await sleep(3000);
      } else {
        console.log(`\n   📧 Magic link / OAuth likely required for ${account.email}`);
        console.log('   👉 Complete login in the browser window...\n');
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Coda login: ${err.message}`);
      console.log('   👉 Please log in manually in the browser window.\n');
    }
  } else {
    console.log('   👉 Please log in manually in the browser window.\n');
  }

  console.log('   ⏳ Waiting for login (up to 3 minutes)...');
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const loggedInPage = findLoggedInPage(browserContext);
    if (loggedInPage) {
      for (const p of browserContext.pages()) {
        if (p !== loggedInPage) await p.close().catch(() => {});
      }
      console.log(`\n   ✅ Coda login detected! Session saved.`);
      return loggedInPage;
    }
    if ((i + 1) % 10 === 0) console.log(`   ⏳ Still waiting... (${(i + 1) * 3}s)`);
  }

  await closeCodaBrowser();
  throw new Error('Coda login timed out after 3 minutes.');
}

// Standalone: npx tsx src/browser/coda/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Coda Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToCoda({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('coda/login') || process.argv[1]?.includes('coda\\login')) main();
