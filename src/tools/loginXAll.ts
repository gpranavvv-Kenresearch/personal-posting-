/**
 * Login and save sessions for ALL active X accounts sequentially.
 *   npx tsx src/tools/loginXAll.ts
 *
 * Skips accounts that are already logged in.
 * Saves session to account.sessionDir so npm run dev picks it up.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { getAccounts } from '../config/accounts.js';
import { humanDelay } from '../browser/stagehand.js';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isSessionOnDisk(sessionDir: string): boolean {
  const c1 = path.join(sessionDir, 'Default', 'Cookies');
  const c2 = path.join(sessionDir, 'Default', 'Network', 'Cookies');
  return fs.existsSync(c1) || fs.existsSync(c2);
}

async function isLoggedIn(page: any): Promise<boolean> {
  for (const sel of [
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="tweetButtonInline"]',
    'a[data-testid="AppTabBar_Home_Link"]',
  ]) {
    if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) return true;
  }
  return false;
}

async function loginAccount(account: any): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const profileDir = path.resolve(account.sessionDir || `.sessions/chrome-${account.handle}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    channel: fs.existsSync(CHROME_PATH) ? undefined : 'chrome',
    slowMo: 50,
    viewport: { width: 1280, height: 900 },
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
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  page.on('dialog', async (d: any) => { await d.dismiss().catch(() => {}); });

  try {
    // Check existing session
    if (isSessionOnDisk(profileDir)) {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 40000 });
      await sleep(3000);
      if (await isLoggedIn(page)) {
        console.log(`   ✅ Already logged in`);
        await context.close();
        return { success: true, skipped: true };
      }
      console.log(`   Session stale — running login flow...`);
    }

    // Login flow
    await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(2500, 3500);

    // Username
    const userEl = page.locator('input[name="text"], input[autocomplete="username"]').first();
    await userEl.waitFor({ state: 'visible', timeout: 20000 });
    await userEl.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type(account.username, { delay: 80 });
    await humanDelay(600, 900);

    // Next
    const nextBtn = page.locator('[data-testid="LoginForm_Login_Button"], div[role="button"]:has-text("Next"), button:has-text("Next")').first();
    if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) await nextBtn.click();
    else await page.keyboard.press('Enter');
    await humanDelay(2500, 3500);

    // Security check (handle)
    const secEl = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
    if (await secEl.isVisible({ timeout: 4000 }).catch(() => false)) {
      await secEl.click();
      await page.keyboard.type(account.handle, { delay: 80 });
      await humanDelay(600, 900);
      const secNext = page.locator('[data-testid="ocfEnterTextNextButton"], div[role="button"]:has-text("Next")').first();
      if (await secNext.isVisible({ timeout: 2000 }).catch(() => false)) await secNext.click();
      else await page.keyboard.press('Enter');
      await humanDelay(2500, 3500);
    }

    // Password
    const passEl = page.locator('input[name="password"]').first();
    await passEl.waitFor({ state: 'visible', timeout: 20000 });
    await passEl.click();
    await page.keyboard.type(account.password, { delay: 80 });
    await humanDelay(600, 900);

    const loginBtn = page.locator('div[role="button"]:has-text("Log in"), button:has-text("Log in")').first();
    if (await loginBtn.isVisible({ timeout: 2000 }).catch(() => false)) await loginBtn.click();
    else await page.keyboard.press('Enter');
    await humanDelay(4000, 5000);

    // Post-login verification
    const postVer = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
    if (await postVer.isVisible({ timeout: 3000 }).catch(() => false)) {
      await postVer.click();
      await page.keyboard.type(account.handle, { delay: 80 });
      await humanDelay(600, 900);
      const pvNext = page.locator('[data-testid="ocfEnterTextNextButton"], div[role="button"]:has-text("Next")').first();
      if (await pvNext.isVisible({ timeout: 2000 }).catch(() => false)) await pvNext.click();
      else await page.keyboard.press('Enter');
      await humanDelay(3000, 4000);
    }

    try {
      await page.waitForFunction(() => !window.location.href.includes('/flow/login'), { timeout: 20000 });
    } catch { /* check UI anyway */ }

    await sleep(2000);

    if (!await isLoggedIn(page)) {
      await context.close();
      return { success: false, error: 'Login UI not detected after login flow' };
    }

    await context.close(); // persistent context auto-saves session on close
    return { success: true };
  } catch (err: any) {
    await context.close().catch(() => {});
    return { success: false, error: err.message };
  }
}

(async () => {
  const accounts = getAccounts().filter(a => a.active);
  console.log(`\n🔐 X Batch Login — ${accounts.length} accounts\n`);

  const results: any[] = [];

  for (const account of accounts) {
    console.log(`\n[${account.handle}] Logging in...`);
    let r: any;
    try {
      r = await loginAccount(account);
    } catch (fatalErr: any) {
      r = { success: false, error: `Fatal: ${fatalErr.message}` };
    }
    results.push({ handle: account.handle, ...r });
    if (r.skipped) console.log(`   ⏭  Skipped (already logged in)`);
    else if (r.success) console.log(`   ✅ Session saved: ${account.sessionDir}`);
    else console.log(`   ❌ Failed: ${r.error}`);
    await sleep(1000);
  }

  console.log('\n=== Summary ===');
  const ok = results.filter(r => r.success);
  const fail = results.filter(r => !r.success);
  console.log(`✅ ${ok.length} success | ❌ ${fail.length} failed`);
  if (fail.length) console.log('Failed:', fail.map(r => r.handle).join(', '));
  process.exit(fail.length > 0 ? 1 : 0);
})();

