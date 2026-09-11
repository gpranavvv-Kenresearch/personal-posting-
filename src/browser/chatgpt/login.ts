import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';
import { sessionDirForAccount } from '../../config/chatGptAccountTracker.js';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MANUAL_LOGIN_TIMEOUT_MS = 120_000; // logging into chatgpt.com by hand (incl. any challenge) takes longer than a password field

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Composer is a contenteditable ProseMirror div, not a <textarea>, in current chatgpt.com.
const COMPOSER_SELECTOR = '#prompt-textarea';
const LOGIN_BUTTON_SELECTOR = 'button:has-text("Log in"), a:has-text("Log in")';

let browserContext: BrowserContext | null = null;
let page: Page | null = null;
let activeAccount: string | null = null;

export async function closeChatGptBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    page = null;
    activeAccount = null;
    console.log('   ChatGPT browser closed.');
  }
}

async function launchBrowser(accountName: string): Promise<Page> {
  // Already have a live page for this exact account — reuse it.
  if (page && !page.isClosed() && activeAccount === accountName) return page;

  // Switching accounts (or first launch) — close whatever's open first,
  // since a persistent context is tied to one profile directory.
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    page = null;
  }

  const sessionDir = sessionDirForAccount(accountName);
  fs.mkdirSync(sessionDir, { recursive: true });

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  await killChromeForProfile(sessionDir);

  console.log(`   Using ChatGPT session folder (account: ${accountName}): ${sessionDir}`);
  console.log('   Launching ChatGPT browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  page = await browserContext.newPage();
  await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded' });
  activeAccount = accountName;
  return page;
}

/**
 * Opens (or reuses) a persistent ChatGPT browser session for the given
 * account. On first run there is no saved session, so the composer won't be
 * present — the browser stays open and visible until you log in by hand (and
 * clear any verification challenge), auto-detected by polling for the
 * composer; the session is then reused on every future run. Used by the
 * unattended generate scripts.
 */
export async function ensureChatGptPage(accountName: string): Promise<Page> {
  const p = await launchBrowser(accountName);
  const loggedIn = await waitUntilLoggedIn(p);
  if (!loggedIn) {
    await closeChatGptBrowser();
    throw new Error(`ChatGPT (account: ${accountName}): not logged in and manual login was not completed in time.`);
  }
  return p;
}

/**
 * Same as ensureChatGptPage(), but for the interactive one-time login script:
 * instead of polling with a timeout, explicitly asks you to press Enter in
 * the terminal once you've finished logging in.
 */
export async function ensureChatGptPageInteractive(accountName: string): Promise<Page> {
  const p = await launchBrowser(accountName);

  if (await isComposerVisible(p)) {
    console.log('   ✅ ChatGPT: already logged in (session restored)');
    return p;
  }

  const loginBtn = p.locator(LOGIN_BUTTON_SELECTOR).first();
  if (await loginBtn.isVisible().catch(() => false)) {
    await loginBtn.click().catch(() => {});
  }

  console.log('   ⚠️  ChatGPT: no active session — please log in manually in the open browser window.');
  await waitForEnter('   Press Enter here once you have finished logging in... ');

  if (!(await isComposerVisible(p))) {
    console.log('   Composer not visible yet — waiting a bit longer...');
    await p.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  }

  if (!(await isComposerVisible(p))) {
    await closeChatGptBrowser();
    throw new Error('ChatGPT: composer still not visible after login confirmation.');
  }

  console.log('   ✅ ChatGPT: login confirmed — session saved for future runs');
  return p;
}

async function waitForEnter(promptText: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(promptText);
  rl.close();
}

async function isComposerVisible(p: Page): Promise<boolean> {
  return await p.locator(COMPOSER_SELECTOR).first().isVisible().catch(() => false);
}

async function waitUntilLoggedIn(p: Page): Promise<boolean> {
  // Already logged in from a prior run (persisted session)?
  const already = await p.locator(COMPOSER_SELECTOR).first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (already) {
    console.log('   ✅ ChatGPT: already logged in (session restored)');
    return true;
  }

  // Not logged in — surface the login button if present, then wait for the
  // user to complete login (and any challenge) by hand.
  const loginBtn = p.locator(LOGIN_BUTTON_SELECTOR).first();
  if (await loginBtn.isVisible().catch(() => false)) {
    await loginBtn.click().catch(() => {});
  }

  console.log(`   ⚠️  ChatGPT: no active session — please log in manually in the open browser window (waiting up to ${MANUAL_LOGIN_TIMEOUT_MS / 1000}s)...`);
  try {
    await p.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: MANUAL_LOGIN_TIMEOUT_MS });
    console.log('   ✅ ChatGPT: manual login detected — session saved for future runs');
    await sleep(1000);
    return true;
  } catch {
    console.error(`   ❌ ChatGPT: manual login not detected within ${MANUAL_LOGIN_TIMEOUT_MS / 1000}s`);
    return false;
  }
}

export { COMPOSER_SELECTOR };
