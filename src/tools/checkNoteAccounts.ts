/**
 * checkNoteAccounts.ts — Actually verify each Note session is still logged
 * in, rather than just checking whether a session folder exists on disk.
 *
 * Usage: npx tsx src/tools/checkNoteAccounts.ts
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const accounts = JSON.parse(fs.readFileSync('.accounts/accounts-note.json', 'utf8'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const results: { nickname: string; status: string }[] = [];

  for (const acc of accounts) {
    const sessionDir = path.resolve(acc.sessionDir || `.sessions/note/${acc.nickname}`);
    const hasSession = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;

    if (!hasSession) {
      console.log(`${acc.nickname.padEnd(12)} → ⚠️  No session saved`);
      results.push({ nickname: acc.nickname, status: '⚠️ No session' });
      continue;
    }

    let ctx: any;
    try {
      ctx = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
        channel: fs.existsSync(CHROME_PATH) ? undefined : 'chrome',
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2500);

      const url = page.url();
      let status = '';
      if (url.includes('/login')) {
        status = '❌ Not logged in';
      } else {
        const loggedInEl = await page.$('a[href*="/notes/new"], button[data-testid="header-post-button"], a[href*="/settings"]');
        status = loggedInEl ? '✅ Active' : '❌ Not logged in';
      }

      console.log(`${acc.nickname.padEnd(12)} → ${status}  (${url.slice(0, 60)})`);
      results.push({ nickname: acc.nickname, status });
    } catch (err: any) {
      console.log(`${acc.nickname.padEnd(12)} → ⚠️  Error: ${err.message.slice(0, 50)}`);
      results.push({ nickname: acc.nickname, status: '⚠️ Error' });
    } finally {
      await ctx?.close().catch(() => {});
    }
  }

  console.log('\n--- SUMMARY ---');
  const active = results.filter(r => r.status.includes('Active'));
  const bad = results.filter(r => !r.status.includes('Active'));
  console.log(`✅ Active (${active.length}): ${active.map(r => r.nickname).join(', ')}`);
  console.log(`❌ Issues (${bad.length}): ${bad.map(r => `${r.nickname}(${r.status.trim()})`).join(', ')}`);
})();
