/**
 * loginXInteractive.ts — Manual X login + session saver
 *
 * Usage:
 *   npx tsx src/tools/loginXInteractive.ts <handle>
 *
 * Unlike loginX.ts (which types username/password automatically), this opens
 * a real visible Chrome window at x.com and waits for YOU to log in by hand
 * (handles 2FA/captcha/verification with no automation involved). Once
 * logged in, come back to this terminal and press Enter to confirm — the
 * session is then saved to the account's profile dir for future runs.
 *
 * The account must already exist in .accounts/accounts.json (add it first
 * via `npx tsx src/config/accounts.ts add`, password can be a placeholder
 * since this script never types it) so the session dir is known.
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { getAccountByHandle } from '../config/accounts.js';
import { killChromeForProfile } from '../utils/killChrome.js';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function isLoggedIn(page: Page): Promise<boolean> {
  const selectors = [
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="tweetButtonInline"]',
    'a[href="/compose/tweet"]',
    'a[data-testid="AppTabBar_Home_Link"]',
  ];
  for (const sel of selectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) return true;
  }
  return false;
}

async function waitForEnter(promptText: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(promptText);
  rl.close();
}

async function main(): Promise<void> {
  const handleArg = process.argv[2];
  if (!handleArg) {
    console.error('Usage: npx tsx src/tools/loginXInteractive.ts <handle>');
    process.exit(1);
  }

  const account = getAccountByHandle(handleArg);
  const profileDir = path.resolve(account?.sessionDir || `.sessions/chrome-${handleArg}`);
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`\n🔐 X Manual Login — @${handleArg}`);
  console.log(`   Profile dir: ${profileDir}`);

  await killChromeForProfile(profileDir);

  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
      channel: fs.existsSync(CHROME_PATH) ? undefined : 'chrome',
      slowMo: 50,
      viewport: { width: 1280, height: 900 },
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
    });

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://x.com' }).catch(() => {});

    const page = context.pages()[0] || await context.newPage();
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (await isLoggedIn(page)) {
      console.log(`\n✅ @${handleArg} is already logged in — session is valid.`);
      await context.close();
      return;
    }

    console.log('   ⚠️  Not logged in — please log in manually in the open browser window.');
    await waitForEnter('   Press Enter here once you have finished logging in... ');

    if (!(await isLoggedIn(page))) {
      console.log('   Not detected yet — waiting a bit longer...');
      await page.waitForTimeout(3000);
    }

    if (!(await isLoggedIn(page))) {
      throw new Error(`Login not confirmed for @${handleArg} — still doesn't look logged in after pressing Enter.`);
    }

    console.log(`\n✅ Login confirmed for @${handleArg} — session saved.`);
  } catch (err: any) {
    console.error(`\n❌ ${err.message}`);
    await context?.close().catch(() => {});
    process.exit(1);
  }

  await context?.close().catch(() => {});
}

main();
