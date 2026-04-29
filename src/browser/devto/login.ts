import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const DEVTO_ACCOUNTS_FILE = '.accounts/accounts-devto.json';

export interface DevtoAccount {
  email: string;
  nickname?: string;
  sessionDir: string;
  active: boolean;
}

export function getDevtoAccounts(): DevtoAccount[] {
  if (!fs.existsSync(DEVTO_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(DEVTO_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveDevtoAccount(): DevtoAccount | null {
  return getDevtoAccounts().find(a => a.active) || null;
}

export function getDevtoAccountByNickname(nickname: string): DevtoAccount | null {
  return getDevtoAccounts().find(
    a => a.nickname?.toLowerCase() === nickname.toLowerCase()
  ) || null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeDevtoBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Dev.to browser closed.');
  }
}

async function isLoggedInToDevto(page: Page): Promise<boolean> {
  // Most reliable: try to load /dashboard — redirects to /enter if not logged in
  try {
    await page.goto('https://dev.to/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2000);
    const url = page.url();
    if (url.includes('/enter') || url.includes('/sign_in') || url.includes('/login')) return false;
    if (url.includes('/dashboard')) return true;
  } catch { /* fall through to selector check */ }

  // Fallback: look for the "Write a post" button (only visible when logged in)
  const writeBtn = await page.locator('.js-policy-article-create').first()
    .isVisible({ timeout: 2000 }).catch(() => false);
  if (writeBtn) return true;

  // If "Log in" or "Create account" buttons are visible → not logged in
  const loginBtn = await page.locator('a[href="/enter"], button:has-text("Log in"), a:has-text("Log in")').first()
    .isVisible({ timeout: 2000 }).catch(() => false);
  if (loginBtn) return false;

  return false;
}

async function clickContinueWithGoogle(page: Page, browserCtx: BrowserContext, email: string): Promise<void> {
  console.log('   Clicking Continue with Google on Dev.to...');
  await page.goto('https://dev.to/enter', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  const googleBtnSelectors = [
    'a[href*="users/auth/google"]',
    'a[href*="google_oauth2"]',
    'button:has-text("Continue with Google")',
    'a:has-text("Continue with Google")',
    '.js-google-sign-in',
  ];

  // Listen for popup before clicking
  const popupPromise = browserCtx.waitForEvent('page', { timeout: 8000 }).catch(() => null);

  let clicked = false;
  for (const sel of googleBtnSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`   Found Google button: ${sel}`);
      await btn.click();
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    throw new Error(`Dev.to "Continue with Google" button not found. Check dev.to/enter is accessible.`);
  }

  const popup = await popupPromise;

  if (popup) {
    console.log('   Google OAuth popup detected...');
    await sleep(2000);

    // Pick the correct account if account chooser appears
    const accountBtn = popup.locator(`[data-email="${email}"], [data-identifier="${email}"]`).first();
    if (await accountBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log(`   Selecting account: ${email}`);
      await accountBtn.click();
    } else {
      // Try text-based picker
      const byEmail = popup.locator(`div:has-text("${email}")`).first();
      if (await byEmail.isVisible({ timeout: 3000 }).catch(() => false)) {
        await byEmail.click();
      }
    }

    try {
      await popup.waitForEvent('close', { timeout: 20000 });
      console.log('   Google OAuth popup closed');
    } catch {
      console.log('   Popup may have auto-completed');
    }
  } else {
    console.log('   Waiting for Google OAuth redirect...');
    await sleep(5000);
  }
}

export async function loginToDevto(options?: {
  nickname?: string;
  email?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getDevtoAccountByNickname(options.nickname) ?? getActiveDevtoAccount()
    : getActiveDevtoAccount();

  if (!account) {
    throw new Error('No active Dev.to account found in .accounts/accounts-devto.json');
  }

  const sessionDir = path.resolve(account.sessionDir);
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  // Create session dir if it doesn't exist yet (fresh account)
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`   Dev.to session: ${sessionDir} (${account.email})`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
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
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
  });

  const existingPages = browserContext.pages();
  let page: Page = existingPages[0] || await browserContext.newPage();
  for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  page.on('dialog', async (d) => { await d.dismiss().catch(() => {}); });

  // ── Check if already logged into Dev.to ───────────────────────────────────
  console.log('   Checking Dev.to session...');
  await page.goto('https://dev.to/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (await isLoggedInToDevto(page)) {
    console.log(`   ✅ Already logged in to Dev.to (${account.email})`);
    return page;
  }

  // ── Click Continue with Google on Dev.to ──────────────────────────────────
  await clickContinueWithGoogle(page, browserContext, account.email);

  // ── Confirm Dev.to login ───────────────────────────────────────────────────
  await page.goto('https://dev.to/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (!await isLoggedInToDevto(page)) {
    throw new Error(
      `Dev.to login via Google failed for ${account.email}.\n` +
      `Make sure a Dev.to account exists for this email (created via "Continue with Google").\n` +
      `If not, open dev.to/enter manually and create one first.`
    );
  }

  console.log(`   ✅ Dev.to logged in via Google (${account.email})`);
  return page;
}
