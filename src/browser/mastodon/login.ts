import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const MASTODON_LOGIN_URL = 'https://mastodon.social/auth/sign_in';
const MASTODON_HOME_URL = 'https://mastodon.social/';

const MASTODON_ACCOUNTS_FILE = '.accounts/accounts-mastodon.json';
const SESSION_ROOT = path.resolve('.sessions/mastodon');

export interface MastodonAccount {
  email: string;
  password?: string;
  nickname?: string;
  sessionDir?: string;
  active: boolean;
}

export function getMastodonAccounts(): MastodonAccount[] {
  if (!fs.existsSync(MASTODON_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(MASTODON_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveMastodonAccount(): MastodonAccount | null {
  return getMastodonAccounts().find(a => a.active) || null;
}

export function getMastodonAccountByNickname(nickname: string): MastodonAccount | null {
  return getMastodonAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeMastodonBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Mastodon browser closed.');
  }
}

function pageLooksLoggedIn(url: string): boolean {
  if (url.includes('/auth/sign_in') || url.includes('/auth/sign_up')) return false;
  return url.includes('mastodon.social');
}

// URL alone is not enough — /home renders publicly (with "Login"/"Create
// account" buttons) even when logged OUT, so a URL-only check reports a
// false positive "already logged in" on a session that was never actually
// authenticated. Confirmed by live inspection: the only reliable signal is
// whether the sign-in link is present in the DOM.
async function isActuallyLoggedIn(page: Page): Promise<boolean> {
  if (!pageLooksLoggedIn(page.url())) return false;
  try {
    const signInLink = page.locator('a[href="/auth/sign_in"]').first();
    const stillLoggedOut = await signInLink.isVisible({ timeout: 3000 }).catch(() => false);
    return !stillLoggedOut;
  } catch {
    return false;
  }
}

async function findLoggedInPage(context: BrowserContext): Promise<Page | null> {
  for (const p of context.pages()) {
    if (await isActuallyLoggedIn(p)) return p;
  }
  return null;
}

export async function loginToMastodon(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getMastodonAccountByNickname(options.nickname) ?? getActiveMastodonAccount()
    : getActiveMastodonAccount();

  if (!account) throw new Error('No Mastodon account found in .accounts/accounts-mastodon.json');

  const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Mastodon session: ${sessionDir}`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: process.env.HEADLESS !== 'false',
    permissions: ['clipboard-read', 'clipboard-write'],
    executablePath: chromePath && fs.existsSync(chromePath) ? chromePath : undefined,
    channel: chromePath && fs.existsSync(chromePath) ? undefined : 'chrome',
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

  console.log('   Opening Mastodon with saved session...');
  await page.goto(MASTODON_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Verify against the DOM, not just the URL — /home is publicly viewable
  // while logged out, so a URL-only check was reporting false positives.
  if (await isActuallyLoggedIn(page)) {
    console.log(`   ✅ Using saved Mastodon session (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Mastodon login...');
  await page.goto(MASTODON_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  if (account.email && account.password) {
    try {
      const emailInput = page.locator('input[name="user[email]"], input[type="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.fill(account.email);
      await sleep(500);
      const passInput = page.locator('input[name="user[password]"], input[type="password"]').first();
      if (await passInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passInput.fill(account.password);
        await sleep(300);
        await page.keyboard.press('Enter');
        await sleep(3000);
      } else {
        console.log(`\n   📧 Extra step required for ${account.email} (2FA likely)`);
        console.log('   👉 Complete login in the browser window...\n');
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Mastodon login: ${err.message}`);
      console.log('   👉 Please log in manually in the browser window.\n');
    }
  } else {
    // Manual-login-first rollout, same as Coda/Tumblr — no credentials on file yet.
    console.log('   👉 Please log in manually in the browser window.\n');
  }

  console.log('   ⏳ Waiting for login (up to 3 minutes)...');
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const loggedInPage = await findLoggedInPage(browserContext);
    if (loggedInPage) {
      for (const p of browserContext.pages()) {
        if (p !== loggedInPage) await p.close().catch(() => {});
      }
      console.log(`\n   ✅ Mastodon login detected! Session saved.`);
      return loggedInPage;
    }
    if ((i + 1) % 10 === 0) console.log(`   ⏳ Still waiting... (${(i + 1) * 3}s)`);
  }

  await closeMastodonBrowser();
  throw new Error('Mastodon login timed out after 3 minutes.');
}

// Standalone: npx tsx src/browser/mastodon/login.ts --nickname pranav
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Mastodon Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToMastodon({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('mastodon/login') || process.argv[1]?.includes('mastodon\\login')) main();
