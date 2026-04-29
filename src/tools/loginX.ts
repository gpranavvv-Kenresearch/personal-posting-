/**
 * loginX.ts — Standalone X login + session saver
 *
 * Usage:
 *   npx tsx src/tools/loginX.ts <handle>
 *   npx tsx src/tools/loginX.ts          (uses first account in .accounts/accounts.json)
 *
 * What it does:
 *   1. Checks if session already valid  → exits early if already logged in
 *   2. Opens a real Chrome with persistent profile
 *   3. Walks through X login flow (username → optional security check → password)
 *   4. Saves session automatically via persistent context (no extra step needed)
 *   5. Exits with code 0 on success, 1 on failure
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { humanDelay } from '../browser/stagehand.js';
import { getAccounts, getAccountByHandle, XAccount } from '../config/accounts.js';

// ── helpers ────────────────────────────────────────────────────────────────

function sessionDir(handle: string): string {
  return path.resolve(`.sessions/chrome-${handle}`);
}

function isSessionOnDisk(handle: string): boolean {
  const dir = sessionDir(handle);
  if (!fs.existsSync(dir)) return false;
  const c1 = path.join(dir, 'Default', 'Cookies');
  const c2 = path.join(dir, 'Default', 'Network', 'Cookies');
  return fs.existsSync(c1) || fs.existsSync(c2);
}

async function isLoggedIn(page: Page): Promise<boolean> {
  const selectors = [
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="tweetButtonInline"]',
    'a[href="/compose/tweet"]',
    'a[data-testid="AppTabBar_Home_Link"]',
  ];
  for (const sel of selectors) {
    const visible = await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Type text in a way that triggers React's synthetic events.
 * fill() alone silently updates the DOM but skips React's onChange,
 * so X ignores it and the Next button stays disabled / the step never advances.
 */
async function reactType(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector).first();
  await el.waitFor({ state: 'visible', timeout: 20000 });
  await el.click();
  await humanDelay(300, 500);
  // Clear existing value
  await el.selectText().catch(() => {});
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await humanDelay(200, 300);
  // Type character-by-character so React onChange fires on each keystroke
  await page.keyboard.type(text, { delay: 80 });
  await humanDelay(400, 600);
}

/**
 * Click the visible "Next" / submit button on the current X login step.
 * Returns true if clicked, false if not found (caller should fallback to Enter).
 */
async function clickNext(page: Page): Promise<boolean> {
  // X uses these test-ids on login flow buttons
  const candidates = [
    '[data-testid="LoginForm_Login_Button"]',     // username step "Next"
    '[data-testid="LoginForm_Login_Button_Alt"]',  // alt variant
    '[data-testid="ocfEnterTextNextButton"]',      // security / verification step
    'div[role="button"]:has-text("Next")',
    'button:has-text("Next")',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click();
      return true;
    }
  }
  return false;
}

/**
 * Wait until the current input field (username) disappears, signalling X
 * moved to the next step.  Falls back to a simple delay if it never disappears.
 */
async function waitForStepAdvance(page: Page, currentInputSel: string): Promise<void> {
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return !el || (el as HTMLElement).offsetParent === null;
      },
      currentInputSel,
      { timeout: 8000 }
    );
  } catch {
    // X didn't hide the field — give it extra time anyway
    await humanDelay(2500, 3500);
  }
}

async function saveDebug(page: Page, handle: string, step: string): Promise<void> {
  const dir = path.resolve('debug', `x-login-${handle}`);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${step}.png`), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(dir, `${step}.html`), await page.content().catch(() => ''), 'utf8');
  console.log(`   Debug saved → debug/x-login-${handle}/${step}.png`);
}

// ── main login flow ────────────────────────────────────────────────────────

async function loginFlow(page: Page, account: XAccount): Promise<void> {
  const { username, password, handle } = account;

  console.log('   Navigating to X login...');
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(2500, 3500);

  // ── Step 1: username ───────────────────────────────────────────────────
  const usernameSel = 'input[name="text"], input[autocomplete="username"]';
  console.log('   Typing username...');
  await reactType(page, usernameSel, username);

  console.log('   Clicking Next...');
  const clicked = await clickNext(page);
  if (!clicked) {
    console.log('   Next button not found — pressing Enter');
    await page.keyboard.press('Enter');
  }

  // Wait for X to advance past the username screen
  await waitForStepAdvance(page, 'input[name="text"]');
  console.log(`   URL after username: ${page.url()}`);
  await saveDebug(page, handle, '01-after-username');

  // Detect if stuck on username screen again
  const usernameStillVisible = await page.locator('input[name="text"]').first()
    .isVisible({ timeout: 1500 }).catch(() => false);
  const passwordVisible = await page.locator('input[name="password"]').first()
    .isVisible({ timeout: 1500 }).catch(() => false);
  const securityVisible = await page.locator('input[data-testid="ocfEnterTextTextInput"]').first()
    .isVisible({ timeout: 1500 }).catch(() => false);

  if (usernameStillVisible && !passwordVisible && !securityVisible) {
    await saveDebug(page, handle, '01-username-stuck');
    throw new Error(
      `X_USERNAME_STUCK: X did not advance past the username screen for @${handle}.\n` +
      `This usually means X is blocking automation. Try logging in manually once:\n` +
      `  Open Chrome → navigate to x.com → log in → close Chrome\n` +
      `  Session dir: ${sessionDir(handle)}`
    );
  }

  // ── Step 2: optional security / identity verification ─────────────────
  if (securityVisible || (!passwordVisible && !usernameStillVisible)) {
    const secSel = 'input[data-testid="ocfEnterTextTextInput"]';
    const secInput = page.locator(secSel).first();
    if (await secInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('   Security check — entering handle...');
      await reactType(page, secSel, handle);
      const secClicked = await clickNext(page);
      if (!secClicked) await page.keyboard.press('Enter');
      await waitForStepAdvance(page, secSel);
      await saveDebug(page, handle, '02-after-security');
    }
  }

  // ── Step 3: password ───────────────────────────────────────────────────
  const passSel = 'input[name="password"]';
  const passInput = page.locator(passSel).first();

  if (!await passInput.isVisible({ timeout: 10000 }).catch(() => false)) {
    // One more security/verification step possible
    const verSel = 'input[data-testid="ocfEnterTextTextInput"]';
    if (await page.locator(verSel).first().isVisible({ timeout: 4000 }).catch(() => false)) {
      console.log('   Extra verification step...');
      await reactType(page, verSel, handle);
      const vClicked = await clickNext(page);
      if (!vClicked) await page.keyboard.press('Enter');
      await humanDelay(2000, 3000);
    }
  }

  console.log('   Typing password...');
  await reactType(page, passSel, password);

  // Click "Log in" button
  const loginCandidates = [
    '[data-testid="LoginForm_Login_Button"]',
    'div[role="button"]:has-text("Log in")',
    'button:has-text("Log in")',
  ];
  let logInClicked = false;
  for (const sel of loginCandidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      logInClicked = true;
      break;
    }
  }
  if (!logInClicked) {
    console.log('   Log in button not found — pressing Enter');
    await page.keyboard.press('Enter');
  }

  await humanDelay(3500, 5000);
  await saveDebug(page, handle, '03-after-login-click');

  // ── Step 4: optional post-login verification challenge ─────────────────
  const postVerSel = 'input[data-testid="ocfEnterTextTextInput"]';
  if (await page.locator(postVerSel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('   Post-login verification challenge...');
    await reactType(page, postVerSel, handle);
    const pvClicked = await clickNext(page);
    if (!pvClicked) await page.keyboard.press('Enter');
    await humanDelay(3000, 4000);
  }

  // ── Step 5: confirm login ──────────────────────────────────────────────
  try {
    await page.waitForFunction(
      () => !window.location.href.includes('/flow/login'),
      { timeout: 20000 }
    );
  } catch {
    // not navigated — take debug snapshot and check UI anyway
  }

  await humanDelay(2000, 3000);

  if (!await isLoggedIn(page)) {
    await saveDebug(page, handle, '04-login-failed');
    throw new Error(
      `X_LOGIN_FAILED: Could not confirm logged-in state for @${handle}.\n` +
      `Check debug/x-login-${handle}/04-login-failed.png`
    );
  }

  console.log(`   URL: ${page.url()}`);
}

// ── entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Resolve which account to log in
  const handleArg = process.argv[2];
  let account: XAccount | undefined;

  if (handleArg) {
    account = getAccountByHandle(handleArg);
    if (!account) {
      // Not in accounts.json — build a minimal account from env vars
      const username = process.env.X_USERNAME;
      const password = process.env.X_PASSWORD;
      if (!username || !password) {
        console.error(`Account @${handleArg} not found in .accounts/accounts.json`);
        console.error('Set X_USERNAME and X_PASSWORD env vars or add the account first:');
        console.error('  npx tsx src/config/accounts.ts add');
        process.exit(1);
      }
      account = {
        handle: handleArg,
        username,
        password,
        sessionDir: `.sessions/chrome-${handleArg}`,
        active: true,
      };
    }
  } else {
    const all = getAccounts();
    account = all.find(a => a.active);
    if (!account) {
      const username = process.env.X_USERNAME;
      const password = process.env.X_PASSWORD;
      const handle = process.env.X_HANDLE || 'default';
      if (!username || !password) {
        console.error('No active accounts in .accounts/accounts.json and X_USERNAME/X_PASSWORD not set.');
        console.error('Add an account: npx tsx src/config/accounts.ts add');
        process.exit(1);
      }
      account = { handle, username, password, sessionDir: `.sessions/chrome-${handle}`, active: true };
    }
  }

  const { handle } = account;
  const profileDir = account.sessionDir
    ? path.resolve(account.sessionDir)
    : path.resolve(`.sessions/chrome-${handle}`);

  console.log(`\n🔐 X Login — @${handle}`);
  console.log(`   Profile dir: ${profileDir}`);

  // Quick check: existing session on disk
  if (isSessionOnDisk(handle)) {
    console.log('   Existing session found on disk — verifying...');
  }

  fs.mkdirSync(profileDir, { recursive: true });

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
      channel: fs.existsSync(chromePath) ? undefined : 'chrome',
      slowMo: 50,
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--disable-infobars',
      ],
    });

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://x.com' }).catch(() => {});

    const pages = context.pages();
    page = pages[0] || await context.newPage();

    // Dismiss any dialogs
    page.on('dialog', async (d) => { await d.dismiss().catch(() => {}); });

    // ── If session exists on disk — try reusing it first ──────────────────
    if (isSessionOnDisk(handle)) {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await humanDelay(3000, 4000);

      if (await isLoggedIn(page)) {
        console.log(`\n✅ @${handle} is already logged in — session is valid.`);
        console.log('   Closing browser...');
        await context.close();
        console.log('   Done.\n');
        return;
      }

      console.log('   Session exists but not logged in — running login flow...');
    }

    // ── Full login flow ────────────────────────────────────────────────────
    await loginFlow(page, account);

    // Persistent context auto-saves cookies/storage on close — no extra step needed
    console.log(`\n✅ Login successful for @${handle}`);
    console.log(`   Session saved at: ${profileDir}`);
    console.log('   Closing browser...\n');

  } catch (err: any) {
    console.error(`\n❌ Login failed: ${err.message}`);
    if (page) await saveDebug(page, handle, 'fatal-error').catch(() => {});
    await context?.close().catch(() => {});
    process.exit(1);
  }

  await context?.close().catch(() => {});
}

main();
