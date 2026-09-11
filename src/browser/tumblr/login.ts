import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const TUMBLR_LOGIN_URL = 'https://www.tumblr.com/login';
const TUMBLR_HOME_URL = 'https://www.tumblr.com/';

const TUMBLR_ACCOUNTS_FILE = '.accounts/accounts-tumblr.json';
const SESSION_ROOT = path.resolve('.sessions/tumblr');

export interface TumblrAccount {
  email: string;
  password?: string;
  nickname?: string;
  blogUrl?: string; // e.g. https://kenresearchupdates.tumblr.com — the target blog to post from
  sessionDir?: string;
  active: boolean;
}

export function getTumblrAccounts(): TumblrAccount[] {
  if (!fs.existsSync(TUMBLR_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(TUMBLR_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveTumblrAccount(): TumblrAccount | null {
  return getTumblrAccounts().find(a => a.active) || null;
}

export function getTumblrAccountByNickname(nickname: string): TumblrAccount | null {
  return getTumblrAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeTumblrBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Tumblr browser closed.');
  }
}

function pageLooksLoggedIn(url: string): boolean {
  if (url.includes('/login') || url.includes('/register') || url.includes('accounts.google.com')) {
    return false;
  }
  return url.includes('tumblr.com');
}

function findLoggedInPage(context: BrowserContext): Page | null {
  for (const p of context.pages()) {
    if (pageLooksLoggedIn(p.url())) return p;
  }
  return null;
}

export async function loginToTumblr(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getTumblrAccountByNickname(options.nickname) ?? getActiveTumblrAccount()
    : getActiveTumblrAccount();

  if (!account) throw new Error('No Tumblr account found in .accounts/accounts-tumblr.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Tumblr session: ${sessionDir}`);

  // Switched to headless:true 2026-09-08 per explicit request. Note: this was
  // previously forced visible because Tumblr silently failed to find
  // dashboard buttons (Link / Post now) when run headless via cron — same
  // class of issue Facebook hit with its client-rendered SPA composer (see
  // src/browser/facebook/login.ts). If posting starts silently failing again,
  // this is the first thing to revert.
  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    permissions: ['clipboard-read', 'clipboard-write'],
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: { width: 1920, height: 1080 },
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
      '--start-maximized',
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

  console.log('   Opening Tumblr with saved session...');
  await page.goto(TUMBLR_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Trust the saved persistent-profile session, same convention as Coda —
  // no login-state re-verification once the profile already holds a login.
  if (!page.url().includes('/login') && !page.url().includes('/register')) {
    console.log(`   ✅ Using saved Tumblr session (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Tumblr login...');
  await page.goto(TUMBLR_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  if (account.email && account.password) {
    try {
      const emailInput = page.locator('input[name="email"], input[type="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.fill(account.email);
      await sleep(500);
      const passInput = page.locator('input[name="password"], input[type="password"]').first();
      if (await passInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passInput.fill(account.password);
        await sleep(300);
        await page.keyboard.press('Enter');
        await sleep(3000);
      } else {
        console.log(`\n   📧 Extra step required for ${account.email} (2FA / captcha likely)`);
        console.log('   👉 Complete login in the browser window...\n');
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Tumblr login: ${err.message}`);
      console.log('   👉 Please log in manually in the browser window.\n');
    }
  } else {
    // Manual-login-first rollout, same as Coda/Naver — no credentials on file yet.
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
      console.log(`\n   ✅ Tumblr login detected! Session saved.`);
      return loggedInPage;
    }
    if ((i + 1) % 10 === 0) console.log(`   ⏳ Still waiting... (${(i + 1) * 3}s)`);
  }

  await closeTumblrBrowser();
  throw new Error('Tumblr login timed out after 3 minutes.');
}

// Standalone: npx tsx src/browser/tumblr/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Tumblr Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToTumblr({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('tumblr/login') || process.argv[1]?.includes('tumblr\\login')) main();
