/**
 * Manual login to Instagram — opens a visible browser, you log in by hand,
 * press Enter to save the session. No username/password ever stored on disk.
 *   npx tsx src/tools/loginInstagram.ts <nickname>
 */
import 'dotenv/config';
import { chromium, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';
import { killChromeForProfile } from '../utils/killChrome.js';
import readline from 'readline';

const nickname = process.argv[2];
if (!nickname) {
  console.error('Usage: npx tsx src/tools/loginInstagram.ts <nickname>');
  process.exit(1);
}

const SESSION_ROOT = '.sessions';

(async () => {
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = path.resolve(`${SESSION_ROOT}/instagram-${nickname}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`\nOpening browser for Instagram (${nickname})...`);
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

  console.log('\n✅ Browser open — log in manually (solve any checkpoint/2FA if asked), then press ENTER here to save session and close.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => rl.question('', () => { rl.close(); resolve(); }));

  console.log(`Session saved to: ${sessionDir}`);
  await ctx.close();
  console.log('Done.');
  process.exit(0);
})();
