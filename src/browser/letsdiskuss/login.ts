import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const LETSDISKUSS_ACCOUNTS_FILE = '.accounts/accounts-letsdiskuss.json';
const SESSION_ROOT = path.resolve('.sessions/letsdiskuss');

export interface LetsdiskussAccount {
  email: string;
  password?: string;
  nickname?: string;
  sessionDir?: string;
  active: boolean;
}

export function getLetsdiskussAccounts(): LetsdiskussAccount[] {
  if (!fs.existsSync(LETSDISKUSS_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(LETSDISKUSS_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveLetsdiskussAccount(): LetsdiskussAccount | null {
  return getLetsdiskussAccounts().find(a => a.active) || null;
}

export function getLetsdiskussAccountByNickname(nickname: string): LetsdiskussAccount | null {
  return getLetsdiskussAccounts().find(
    a => a.nickname?.toLowerCase() === nickname.toLowerCase()
  ) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeLetsdiskussBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Letsdiskuss browser closed.');
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('https://www.letsdiskuss.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Logged-in indicators — update selectors once confirmed on letsdiskuss.com
    const indicators = [
      'a[href*="logout"]',
      'a[href*="profile"]',
      '.user-avatar',
      '.nav-user',
      'button:has-text("Write")',
    ];
    for (const sel of indicators) {
      if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
        return true;
      }
    }

    // If login/signup button visible → not logged in
    const loginVisible = await page
      .locator('a[href*="login"], a[href*="signin"], button:has-text("Login"), a:has-text("Sign In")')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (loginVisible) return false;

    return false;
  } catch {
    return false;
  }
}

export async function loginToLetsdiskuss(options?: {
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getLetsdiskussAccountByNickname(options.nickname) ?? getActiveLetsdiskussAccount()
    : getActiveLetsdiskussAccount();

  if (!account) {
    throw new Error('No active Letsdiskuss account found in .accounts/accounts-letsdiskuss.json');
  }

  const sessionDir = account.sessionDir
    ? path.resolve(account.sessionDir)
    : sessionDirFor(account.nickname || account.email);

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`   Letsdiskuss session: ${sessionDir} (${account.email})`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-minimized',
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

  console.log('   Checking Letsdiskuss session...');
  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Letsdiskuss (${account.email})`);
    return page;
  }

  // Navigate to login page
  console.log('   Navigating to Letsdiskuss login...');
  await page.goto('https://www.letsdiskuss.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Try Google OAuth first
  const googleBtnSelectors = [
    'a[href*="google"]',
    'button:has-text("Google")',
    'a:has-text("Continue with Google")',
    'a:has-text("Sign in with Google")',
    '.google-login',
  ];

  let usedGoogle = false;
  const popupPromise = browserContext.waitForEvent('page', { timeout: 8000 }).catch(() => null);

  for (const sel of googleBtnSelectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log(`   Clicking Google login: ${sel}`);
      await page.locator(sel).first().click();
      usedGoogle = true;
      break;
    }
  }

  if (usedGoogle) {
    const popup = await popupPromise;
    if (popup) {
      console.log('   Google OAuth popup detected...');
      await sleep(2000);
      const accountBtn = popup.locator(`[data-email="${account.email}"], [data-identifier="${account.email}"]`).first();
      if (await accountBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await accountBtn.click();
      } else {
        const byEmail = popup.locator(`div:has-text("${account.email}")`).first();
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
    }
    await sleep(4000);
  } else if (account.password) {
    // Email/password fallback
    console.log('   Using email/password login...');
    const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    const passSel = 'input[type="password"], input[name="password"]';
    const submitSel = 'button[type="submit"], button:has-text("Login"), button:has-text("Sign In")';

    await page.waitForSelector(emailSel, { timeout: 10000 });
    await page.click(emailSel);
    await page.keyboard.type(account.email, { delay: 80 });
    await sleep(500);
    await page.click(passSel);
    await page.keyboard.type(account.password, { delay: 80 });
    await sleep(500);
    await page.click(submitSel);
    await sleep(4000);
  } else {
    throw new Error(
      `Letsdiskuss: no Google button found and no password configured for ${account.email}.\n` +
      `Add "password" to the account entry or log in manually and save the session.`
    );
  }

  if (!await isLoggedIn(page)) {
    throw new Error(`Letsdiskuss login failed for ${account.email}. Check credentials or session.`);
  }

  console.log(`   ✅ Letsdiskuss logged in (${account.email})`);
  return page;
}
