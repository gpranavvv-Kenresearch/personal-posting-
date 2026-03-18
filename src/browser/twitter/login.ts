import { chromium, BrowserContext, Page } from 'playwright';
import { humanDelay } from '../stagehand.js';
import { Account } from '../../config/accounts.js';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

let browserContext: BrowserContext | null = null;
let loginPage: Page | null = null;

export async function closeBrowser() {
  if (browserContext) {
    try {
      await browserContext.close();
    } catch { /* already closed */ }
    browserContext = null;
    loginPage = null;
    console.log('   Browser closed.');
  }
}

const SESSION_DIR = path.resolve('.sessions/chrome-profile');

export async function loginToX(account?: Account): Promise<Page> {
  // Close any existing browser before opening a new one (prevents two browsers from appearing)
  if (browserContext) {
    console.log('   Closing existing browser before opening new one...');
    await closeBrowser();
  }

  console.log('   Launching stealth browser...');

  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : SESSION_DIR;
  const username = account?.username || process.env.X_USERNAME!;
  const password = account?.password || process.env.X_PASSWORD!;

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}. Set CHROME_PATH env var to your chrome.exe path.`);
  }

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  await browserContext.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
  });

  // Reuse first existing page (persistent context restores previous session tabs)
  const existingPages = browserContext.pages();
  if (existingPages.length > 0) {
    loginPage = existingPages[0];
    for (const p of existingPages.slice(1)) {
      await p.close().catch(() => {});
    }
  } else {
    loginPage = await browserContext.newPage();
  }
  console.log('   Browser launched!');

  // Go to /home first — session check
  await loginPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(3000, 5000);

  const urlAfterHome = loginPage.url();
  console.log(`   URL after goto /home: ${urlAfterHome}`);

  // Already logged in
  if (!urlAfterHome.includes('/flow/login') && !urlAfterHome.includes('/login')) {
    console.log('   Already logged in!');
    console.log('✅ Login done!');
    return loginPage;
  }

  console.log('   Not logged in — starting login flow...');

  // Fill username
  console.log('   Typing username...');
  const userInput = loginPage.locator('input[name="text"], input[autocomplete="username"]').first();
  await userInput.waitFor({ state: 'visible', timeout: 30000 });
  await userInput.click();
  await humanDelay(400, 700);
  await userInput.fill(username);
  await humanDelay(800, 1200);

  // Click Next button (fallback to Enter)
  const nextButton = loginPage.locator('div[role="button"]:has-text("Next"), button[role="button"]:has-text("Next")');
  if (await nextButton.first().isVisible().catch(() => false)) {
    await nextButton.first().click();
  } else {
    await loginPage.keyboard.press('Enter');
  }
  await humanDelay(2000, 3000);
  console.log(`   URL after username: ${loginPage.url()}`);

  // Security check (unusual activity — enter username again)
  try {
    const sec = loginPage.locator('input[data-testid="ocfEnterTextTextInput"]');
    if (await sec.isVisible({ timeout: 3000 })) {
      console.log('   Security check...');
      await sec.click();
      await sec.fill(username);
      await humanDelay(800, 1200);
      const secNext = loginPage.locator('div[role="button"]:has-text("Next"), button:has-text("Next")');
      if (await secNext.first().isVisible().catch(() => false)) {
        await secNext.first().click();
      } else {
        await loginPage.keyboard.press('Enter');
      }
      await humanDelay(2000, 3000);
    }
  } catch { /* no security check */ }

  // Fill password
  console.log('   Typing password...');
  const passInput = loginPage.locator('input[name="password"]').first();
  await passInput.waitFor({ state: 'visible', timeout: 30000 });
  await passInput.click();
  await humanDelay(400, 700);
  await passInput.fill(password);
  await humanDelay(800, 1200);

  // Click Log in button (fallback to Enter)
  const loginButton = loginPage.locator('div[role="button"]:has-text("Log in"), button:has-text("Log in")');
  if (await loginButton.first().isVisible().catch(() => false)) {
    await loginButton.first().click();
  } else {
    await loginPage.keyboard.press('Enter');
  }
  await humanDelay(3000, 4000);

  // Handle possible phone/email verification challenge
  try {
    const verifyInput = loginPage.locator('input[data-testid="ocfEnterTextTextInput"]');
    if (await verifyInput.isVisible({ timeout: 3000 })) {
      console.log('   Phone/email verification challenge...');
      await verifyInput.click();
      await verifyInput.fill(username);
      await humanDelay(800, 1200);
      const verifyNext = loginPage.locator('div[role="button"]:has-text("Next"), button:has-text("Next")');
      if (await verifyNext.first().isVisible().catch(() => false)) {
        await verifyNext.first().click();
      } else {
        await loginPage.keyboard.press('Enter');
      }
      await humanDelay(3000, 4000);
    }
  } catch { /* no verification challenge */ }

  // Wait for navigation away from login page
  try {
    await loginPage.waitForFunction(
      () => !window.location.href.includes('/flow/login'),
      { timeout: 15000 }
    );
  } catch {
    console.log('   ⚠️  Still on login page — may need manual intervention');
  }

  console.log(`   URL after login: ${loginPage.url()}`);
  console.log('✅ Login done!');
  return loginPage;
}
