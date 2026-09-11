import { chromium } from 'playwright';
import fs from 'fs';

const accounts = JSON.parse(fs.readFileSync('.accounts/accounts.json', 'utf8'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const results: { nickname: string; handle: string; status: string }[] = [];

  for (const acc of accounts) {
    const url = `https://x.com/${acc.handle}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000);
      const text = await page.evaluate(() => document.body.innerText.slice(0, 500));
      let status = 'unknown';
      if (/account suspended/i.test(text)) status = '❌ Suspended';
      else if (/this account doesn.*t exist/i.test(text) || /page doesn.*t exist/i.test(text)) status = '❌ Not found';
      else status = '✅ Active';
      console.log(`${acc.nickname.padEnd(12)} @${acc.handle.padEnd(20)} → ${status}`);
      results.push({ nickname: acc.nickname, handle: acc.handle, status });
    } catch (err: any) {
      console.log(`${acc.nickname.padEnd(12)} @${acc.handle.padEnd(20)} → ⚠️ Error: ${err.message.slice(0, 50)}`);
      results.push({ nickname: acc.nickname, handle: acc.handle, status: '⚠️ Error' });
    }
  }

  await browser.close();

  console.log('\n--- SUMMARY ---');
  const active = results.filter(r => r.status.includes('Active'));
  const suspended = results.filter(r => !r.status.includes('Active'));
  console.log(`Active (${active.length}): ${active.map(r => r.nickname).join(', ')}`);
  console.log(`Suspended/Other (${suspended.length}): ${suspended.map(r => `${r.nickname}(${r.status})`).join(', ')}`);
})();
