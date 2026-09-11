import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

export interface InstagramAccount {
  nickname: string;
  username: string;
  password: string;
  active: boolean;
}

const ACCOUNTS_FILE = '.accounts/accounts-instagram.json';
const SESSION_ROOT  = '.sessions';

let browserContext: BrowserContext | null = null;

export function getInstagramAccounts(): InstagramAccount[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

export function getInstagramAccountByNickname(nickname: string): InstagramAccount | undefined {
  const accounts = getInstagramAccounts();
  const needle = nickname.toLowerCase();
  return accounts.find(a => a.active && a.nickname.toLowerCase() === needle) ?? accounts.find(a => a.active);
}

export async function closeInstagramBrowser(): Promise<void> {
  if (browserContext) {
    try { await browserContext.close(); } catch { /* already closed */ }
    browserContext = null;
  }
}

export async function loginToInstagram(account: InstagramAccount): Promise<Page> {
  if (browserContext) {
    try { await browserContext.close(); } catch {}
    browserContext = null;
  }

  const sessionDir = path.resolve(`${SESSION_ROOT}/instagram-${account.nickname}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}. Set CHROME_PATH env var.`);
  }

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: chromePath,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-minimized',
      '--window-size=1366,768',
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const existingPages = browserContext.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await browserContext.newPage();
  for (const p of existingPages.slice(1)) await p.close().catch(() => {});

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if already logged in
  const homeIcon = page.locator('svg[aria-label="Home"], svg[aria-label="Search"]').first();
  if (await homeIcon.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log(`   Already logged in as ${account.username}`);
    return page;
  }

  console.log(`   Logging in as ${account.username}...`);

  // Go to login page if not already there
  if (!page.url().includes('login')) {
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  const userField = page.locator('input[name="username"]').first();
  const passField = page.locator('input[name="password"]').first();
  const loginBtn  = page.locator('button[type="submit"]').first();

  await userField.waitFor({ state: 'visible', timeout: 15000 });
  await userField.fill(account.username);
  await page.waitForTimeout(500);
  await passField.fill(account.password);
  await page.waitForTimeout(500);
  await loginBtn.click();

  await page.waitForTimeout(5000);

  // Dismiss "Save your login info?" / "Turn on notifications?" dialogs
  for (const text of ['Not now', 'Not Now', 'Later']) {
    try {
      const btn = page.locator(`button:has-text("${text}"), [role="button"]:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1000);
      }
    } catch { /* ignore */ }
  }

  const loggedIn = await homeIcon.isVisible({ timeout: 8000 }).catch(() => false);
  if (!loggedIn) {
    console.warn(`   ⚠️  Login may not have completed for ${account.username} — check browser manually`);
  } else {
    console.log(`   ✅ Logged in as ${account.username}`);
  }

  return page;
}

