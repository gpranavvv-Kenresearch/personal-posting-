import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const PATREON_ACCOUNTS_FILE = '.accounts/accounts-patreon.json';
const SESSION_ROOT = path.resolve('.sessions/patreon');

export interface PatreonAccount {
  email: string;
  password: string;
  nickname?: string;
  creatorUrl?: string;
  sessionDir?: string;
  active: boolean;
}

export function getPatreonAccounts(): PatreonAccount[] {
  if (!fs.existsSync(PATREON_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PATREON_ACCOUNTS_FILE, 'utf8'));
}

export function getActivePatreonAccount(): PatreonAccount | null {
  return getPatreonAccounts().find(a => a.active) || null;
}

export function getPatreonAccountByNickname(nickname: string): PatreonAccount | null {
  return getPatreonAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closePatreonBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Patreon browser closed.');
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes('/login') || url.includes('/signup')) return false;
    // Creator account confirmed when URL contains /c/ slug
    if (url.includes('/c/')) return true;
    const selectors = [
      '[data-tag="create-content-button"]',
      '[data-tag="user-avatar"]',
      'a[href*="/c/"]',
      'a[href*="/settings"]',
      '[data-testid="creator-nav"]',
    ];
    for (const sel of selectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) return true;
    }
    const loginForm = await page.locator('input[name="email"]').first().isVisible({ timeout: 800 }).catch(() => false);
    if (!loginForm && !url.includes('login')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function loginToPatreon(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getPatreonAccountByNickname(options.nickname) ?? getActivePatreonAccount()
    : getActivePatreonAccount();

  if (!account) throw new Error('No Patreon account found in .accounts/accounts-patreon.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Patreon session: ${sessionDir}`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: null,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-minimized',
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

  // Position window top-left so it's visible for CAPTCHA / 2FA interaction
  try {
    const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
    const cdp = await browserContext.newCDPSession(tmpPage);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  // Check saved session — navigate to creator page (/c/ slug) if available
  const checkUrl = 'https://www.patreon.com/home';
  console.log(`   Checking Patreon session at: ${checkUrl}`);
  await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Patreon (${account.nickname})`);
    return page;
  }

  // Login flow
  console.log('   Not logged in — running Patreon login...');
  await page.goto('https://www.patreon.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Email
  try {
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.click();
    await emailInput.fill(account.email);
    await sleep(500);
  } catch (err: any) {
    throw new Error(`Patreon email field not found: ${err.message}`);
  }

  // Password — Patreon puts email+password on the same page; password input is in DOM
  // but may be hidden. Use Tab to reach it, then type.
  await page.keyboard.press('Tab');
  await sleep(300);
  try {
    // Try filling via JS directly (bypasses visibility)
    const filled = await page.evaluate((pwd: string) => {
      const el = document.querySelector<HTMLInputElement>('input[name="current-password"], input[type="password"]');
      if (!el) return false;
      el.focus();
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeInputValueSetter?.call(el, pwd);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, account.password);

    if (!filled) throw new Error('password input not found in DOM');
    console.log('   ✅ Password filled via JS');
    await sleep(500);
  } catch (err: any) {
    throw new Error(`Patreon password fill failed: ${err.message}`);
  }

  // Submit login
  const loginBtn = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")').first();
  if (await loginBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await loginBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }
  await sleep(4000);

  // Handle potential 2FA or CAPTCHA — wait up to 2 minutes for manual intervention
  if (!await isLoggedIn(page)) {
    console.log('   ⏳ Waiting for manual login completion (CAPTCHA / 2FA)...');
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      if (await isLoggedIn(page)) break;
      if ((i + 1) % 10 === 0) console.log(`   ⏳ Still waiting... (${(i + 1) * 3}s)`);
    }
  }

  if (!await isLoggedIn(page)) {
    await closePatreonBrowser();
    throw new Error('Patreon login failed — logged-in UI not detected');
  }

  console.log(`   ✅ Patreon login successful (${account.nickname})`);
  return page;
}

// Standalone: npx tsx src/browser/patreon/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Patreon Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToPatreon({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('patreon/login')) main();

