/**
 * Quick Velog test — logs in and posts one sample article.
 * Usage: npx tsx src/tools/testVelog.ts [nickname]
 */
import 'dotenv/config';
import path from 'path';
import { loginToVelog, closeVelogBrowser } from '../browser/velog/login.js';
import { postToVelog } from '../browser/velog/poster.js';

const nickname = process.argv[2] || 'pranav';

const SAMPLE_TITLE = 'Global Aerogel Market Outlook 2025–2030';
const SAMPLE_HTML = `
<h2>Market Overview</h2>
<p>The global aerogel market is projected to grow significantly over the next five years, driven by rising demand in construction, oil &amp; gas, and aerospace sectors.</p>
<h2>Key Highlights</h2>
<ul>
  <li>Market size expected to reach $2.1 billion by 2030</li>
  <li>CAGR of 9.4% during the forecast period</li>
  <li>Asia-Pacific leads regional growth</li>
</ul>
<p>For the full report visit: <a href="https://www.kenresearch.com/aerogel-market">Ken Research – Aerogel Market</a></p>
`;

(async () => {
  console.log(`\n🧪 Velog Test — account: ${nickname}\n`);
  let page;
  try {
    console.log('Step 1: Login...');
    page = await loginToVelog({ nickname });
    console.log('✅ Login success\n');

    const screenshotPath = path.resolve(`velog-after-login.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`📸 Screenshot saved: ${screenshotPath}`);
    console.log(`   Current URL: ${page.url()}\n`);

    console.log('Step 2: Post article...');
    const result = await postToVelog(page, SAMPLE_TITLE, SAMPLE_HTML);
    console.log(`\n✅ Posted successfully!`);
    console.log(`   URL: ${result.postUrl}`);
    console.log(`   At:  ${result.postedAt.toISOString()}`);
  } catch (err: any) {
    if (page) {
      const errPath = path.resolve(`velog-error.png`);
      await page.screenshot({ path: errPath, fullPage: false }).catch(() => {});
      console.log(`📸 Error screenshot: ${errPath}`);
      console.log(`   URL at error: ${page.url()}`);
    }
    console.error(`\n❌ Test failed: ${err.message}`);
    process.exit(1);
  } finally {
    await closeVelogBrowser().catch(() => {});
  }
})();
