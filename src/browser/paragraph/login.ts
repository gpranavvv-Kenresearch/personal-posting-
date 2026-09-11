import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome';

const PARAGRAPH_ACCOUNTS_FILE = '.accounts/accounts-paragraph.json';
const SESSION_ROOT = path.resolve('.sessions/paragraph');

export interface ParagraphAccount {
  email: string;
  password?: string;
  nickname?: string;
  sessionDir?: string;
  active: boolean;
}

export function getParagraphAccounts(): ParagraphAccount[] {
  if (!fs.existsSync(PARAGRAPH_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PARAGRAPH_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveParagraphAccount(): ParagraphAccount | null {
  return getParagraphAccounts().find(a => a.active) || null;
}

export function getParagraphAccountByNickname(nickname: string): ParagraphAccount | null {
  return getParagraphAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeParagraphBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Paragraph browser closed.');
  }
}

export async function loginToParagraph(options?: {
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getParagraphAccountByNickname(options.nickname) ?? getActiveParagraphAccount()
    : getActiveParagraphAccount();

  if (!account) {
    throw new Error('No Paragraph account found in .accounts/accounts-paragraph.json');
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir
    ? path.resolve(account.sessionDir)
    : sessionDirFor(options?.nickname || account.nickname || account.email);

  fs.mkdirSync(sessionDir, { recursive: true });

  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Paragraph browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: process.env.HEADLESS !== 'false',
    executablePath: chromePath,
    viewport: { width: 1280, height: 720 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-infobars'],
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Minimize window
  try {
    const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
    const cdp = await browserContext.newCDPSession(tmpPage);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
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

  console.log('   Navigating to Paragraph...');
  await page.goto('https://paragraph.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Paragraph (${account.nickname})`);
    return page;
  }

  // Auto-login with email + password if available
  if (account.email && account.password) {
    console.log(`   Attempting auto-login for ${account.email}...`);
    try {
      // Look for email input
      const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
      await emailInput.fill(account.email);
      await sleep(500);

      const passwordInput = page.locator('input[type="password"]').first();
      if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passwordInput.fill(account.password);
        await sleep(400);
        await page.keyboard.press('Enter');
        await sleep(5000);
      } else {
        // May be a magic-link / OTP flow — click continue
        const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
        if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await continueBtn.click();
          await sleep(1000);
        }
        console.log(`\n   📧 Check ${account.email} for a magic link / OTP and complete login in the browser.`);
      }

      if (await isLoggedIn(page)) {
        console.log(`   ✅ Auto-login successful`);
        return page;
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Auto-login failed: ${err.message}`);
    }
  }

  // Wait up to 3 minutes for manual login
  console.log('   ⏳ Waiting for manual login (up to 3 min)...');
  for (let i = 0; i < 180; i += 3) {
    await sleep(3000);
    if (await isLoggedIn(page)) {
      console.log(`\n   ✅ Login detected!`);
      return page;
    }
    if ((i + 3) % 30 === 0) {
      console.log(`   ⏳ Still waiting... (${i + 3}s elapsed)`);
    }
  }

  await closeParagraphBrowser();
  throw new Error('Login timed out after 3 minutes.');
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes('/login') || url.includes('/signin') || url.includes('/auth')) return false;

    // paragraph.com/home after login shows the dashboard / write button
    const indicators = [
      'a[href*="/write"]',
      'button:has-text("New post")',
      '[data-editor-field="title"]',
      'a[href="/home"]',
    ];
    for (const sel of indicators) {
      if (await page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)) return true;
    }

    // If URL is /home and no login form, assume logged in
    const loginVisible = await page.locator('input[type="email"]').first().isVisible({ timeout: 800 }).catch(() => false);
    if (!loginVisible && url.includes('paragraph.com')) return true;

    return false;
  } catch {
    return false;
  }
}

