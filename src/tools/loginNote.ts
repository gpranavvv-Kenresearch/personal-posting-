/**
 * Manual login to Note.com — opens browser, you log in, press Enter to save session.
 *   npx tsx src/tools/loginNote.ts <nickname>
 */
import 'dotenv/config';
import { chromium, BrowserContext } from 'playwright';
import path from 'path';
import fs from 'fs';
import { getNoteAccountByNickname, getActiveNoteAccount } from '../browser/note/login.js';
import { killChromeForProfile } from '../utils/killChrome.js';
import readline from 'readline';

const nickname = process.argv[2];
if (!nickname) {
  console.error('Usage: npx tsx src/tools/loginNote.ts <nickname>');
  process.exit(1);
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.resolve(`.sessions/note/${safe || 'default'}`);
}

(async () => {
  const account = getNoteAccountByNickname(nickname) ?? getActiveNoteAccount();
  if (!account) {
    console.error(`❌ No account found with nickname "${nickname}" in .accounts/accounts-note.json`);
    process.exit(1);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.email);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`\nOpening browser for Note (${nickname})...`);
  console.log(`Session folder: ${sessionDir}`);

  const ctx: BrowserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: chromePath,
    viewport: { width: 1280, height: 800 },
    slowMo: 80,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-minimized', '--disable-blink-features=AutomationControlled', '--no-first-run', '--disable-infobars'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://note.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('\n✅ Browser open — log in manually, then press ENTER here to save session and close.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>(resolve => rl.question('', () => { rl.close(); resolve(); }));

  console.log(`Session saved to: ${sessionDir}`);
  await ctx.close();
  console.log('Done.');
  process.exit(0);
})();

