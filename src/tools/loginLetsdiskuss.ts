/**
 * Manual login to Letsdiskuss — opens browser, you log in, press y to save session.
 *   npx tsx src/tools/loginLetsdiskuss.ts <nickname>
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { getLetsdiskussAccountByNickname } from '../browser/letsdiskuss/login.js';

const nickname = process.argv[2];
if (!nickname) {
  console.error('Usage: npx tsx src/tools/loginLetsdiskuss.ts <nickname>');
  process.exit(1);
}

const account = getLetsdiskussAccountByNickname(nickname);
if (!account) {
  console.error(`❌ No account found with nickname "${nickname}" in .accounts/accounts-letsdiskuss.json`);
  process.exit(1);
}

const sessionDir = account.sessionDir
  ? path.resolve(account.sessionDir)
  : path.resolve(`.sessions/letsdiskuss/${nickname}`);

const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`\nOpening browser for Letsdiskuss (${nickname} — ${account.email})`);
  console.log(`Session folder: ${sessionDir}\n`);

  const ctx = await chromium.launchPersistentContext(sessionDir, {
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
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
  });

  await ctx.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
  });

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.letsdiskuss.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('Browser open — log in manually.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise<string>(resolve =>
    rl.question('Save session? (y/n): ', resolve)
  );
  rl.close();

  if (answer.trim().toLowerCase() === 'y') {
    await ctx.close();
    console.log(`\n✅ Session saved to: ${sessionDir}`);
  } else {
    await ctx.close();
    console.log('\n❌ Session discarded.');
  }

  process.exit(0);
})();
