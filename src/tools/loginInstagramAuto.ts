/**
 * Semi-auto login to Instagram — opens a visible browser, fills in the
 * account's saved username/password from accounts-instagram.json, clicks
 * Log in, then waits for you to solve any checkpoint/2FA by hand. Press
 * Enter here once you're fully logged in to save the session and close.
 *   npx tsx src/tools/loginInstagramAuto.ts <nickname>
 */
import 'dotenv/config';
import { chromium, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { killChromeForProfile } from '../utils/killChrome.js';
import { getInstagramAccountByNickname } from '../browser/instagram/login.js';

const nickname = process.argv[2];
if (!nickname) {
  console.error('Usage: npx tsx src/tools/loginInstagramAuto.ts <nickname>');
  process.exit(1);
}

const account = getInstagramAccountByNickname(nickname);
if (!account || !account.password) {
  console.error(`❌ Account "${nickname}" not found, or has no saved password in accounts-instagram.json`);
  process.exit(1);
}

const SESSION_ROOT = '.sessions';

(async () => {
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = path.resolve(`${SESSION_ROOT}/instagram-${account!.nickname}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`\nOpening browser for Instagram (${nickname}: ${account!.username})...`);
  console.log(`Session folder: ${sessionDir}`);

  const ctx: BrowserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 768 },
    slowMo: 80,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--disable-infobars'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  try {
    const userField = page.locator('input[name="email"], input[name="username"]').first();
    const passField = page.locator('input[name="pass"], input[name="password"], input[type="password"]').first();
    const loginBtn  = page.locator('div[role="button"][aria-label="Log In"], button[type="submit"]').first();

    await userField.waitFor({ state: 'visible', timeout: 15000 });
    await userField.fill(account!.username);
    await page.waitForTimeout(500);
    await passField.fill(account!.password!);
    await page.waitForTimeout(500);
    await loginBtn.click();
    console.log('   Filled username/password and clicked Log in.');
  } catch (err: any) {
    console.warn(`   ⚠️  Auto-fill step failed (${err.message}) — fill in manually in the browser.`);
  }

  console.log('\n✅ If Instagram asks for a verification code/checkpoint, solve it by hand in the browser now.');
  console.log('Once you are fully logged in (home feed visible), press ENTER here to save the session and close.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => rl.question('', () => { rl.close(); resolve(); }));

  console.log(`Session saved to: ${sessionDir}`);
  await ctx.close();
  console.log('Done.');
  process.exit(0);
})();
