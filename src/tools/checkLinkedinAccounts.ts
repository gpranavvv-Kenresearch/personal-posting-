import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const accounts = JSON.parse(fs.readFileSync('.accounts/linkedin-accounts.json', 'utf8'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const results: { nickname: string; email: string; status: string }[] = [];

  for (const acc of accounts) {
    const sessionDir = path.resolve(acc.sessionDir);
    const hasSession = fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;

    if (!hasSession) {
      console.log(`${acc.nickname.padEnd(12)} ${acc.email.padEnd(35)} → ⚠️  No session saved`);
      results.push({ nickname: acc.nickname, email: acc.email, status: '⚠️ No session' });
      continue;
    }

    let ctx: any;
    try {
      ctx = await chromium.launchPersistentContext(sessionDir, {
        headless: true,
        executablePath: CHROME_PATH,
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--disable-blink-features=AutomationControlled'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      });
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(3000);

      const url = page.url();
      const text = await page.evaluate(() => document.body.innerText.slice(0, 600));

      let status = '';
      if (url.includes('/login') || url.includes('/authwall') || url.includes('/uas/login')) {
        status = '❌ Not logged in';
      } else if (/restricted|suspended|disabled|locked|unusual/i.test(text) || url.includes('checkpoint')) {
        status = '❌ Restricted/Disabled';
      } else if (/something went wrong|error/i.test(text) && !url.includes('/feed')) {
        status = '⚠️  Error page';
      } else {
        status = '✅ Active';
      }

      console.log(`${acc.nickname.padEnd(12)} ${acc.email.padEnd(35)} → ${status}  (${url.slice(0, 60)})`);
      results.push({ nickname: acc.nickname, email: acc.email, status });
    } catch (err: any) {
      console.log(`${acc.nickname.padEnd(12)} ${acc.email.padEnd(35)} → ⚠️  Error: ${err.message.slice(0, 50)}`);
      results.push({ nickname: acc.nickname, email: acc.email, status: '⚠️ Error' });
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
