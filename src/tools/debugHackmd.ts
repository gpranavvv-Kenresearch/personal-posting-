/**
 * HackMD selector debugger — run with:
 *   npx tsx src/tools/debugHackmd.ts
 * Opens a real HackMD session (aniket by default) and checks every selector
 * used in poster.ts, printing ✅/❌ for each.
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sessionDir = path.resolve('.sessions/hackmd/Nylave_fxzig_com'); // aniket
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function check(page: any, selector: string, label: string) {
  const el = await page.$(selector).catch(() => null);
  const visible = el ? await el.isVisible().catch(() => false) : false;
  console.log(`  ${visible ? '✅' : '❌'} ${label.padEnd(40)} [${selector}]`);
  return visible;
}

(async () => {
  console.log(`\nUsing session: ${sessionDir}`);
  if (!fs.existsSync(sessionDir)) {
    console.error('❌ Session dir not found. Login first.');
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: CHROME_PATH,
    viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-minimized', '--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });

  const page = ctx.pages()[0] || await ctx.newPage();

  console.log('\n1. Navigating to hackmd.io/new ...');
  await page.goto('https://hackmd.io/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(
      () => !window.location.href.includes('/new'),
      { timeout: 10000 }
    );
  } catch { /* ok */ }
  const noteUrl = page.url();
  console.log(`   Note URL: ${noteUrl}`);
  await sleep(3000);

  console.log('\n2. Editor selectors:');
  await check(page, '.CodeMirror', 'CodeMirror editor');
  await check(page, '.ui-note-meta-title', 'Title input (.ui-note-meta-title)');

  // Try to fill title
  const titleEl = await page.$('.ui-note-meta-title');
  if (titleEl) {
    await titleEl.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText('Test Title from Debugger');
    await sleep(500);
    console.log('   ✅ Typed title');
  }

  // Show all visible buttons to discover real selectors
  const allBtns = await page.$$eval('button', (els: any[]) =>
    els.map(el => ({
      text: el.textContent?.trim().slice(0, 50),
      class: el.className.slice(0, 100),
      ariaLabel: el.getAttribute('aria-label'),
      visible: el.offsetParent !== null,
    })).filter(b => b.visible)
  );
  console.log('\n3. All visible buttons on note page:');
  allBtns.forEach((b: any) => console.log(`   text="${b.text}" | aria-label="${b.ariaLabel}" | class="${b.class}"`));

  // --- "..." (more options) button ---
  console.log('\n4. Clicking "..." (more options) button...');
  const moreBtn = await page.$('button[aria-label="More"]') ||
                  await page.$('button[aria-label="More options"]') ||
                  await page.$('button[title="More"]');
  // fallback: last button in top-right nav
  const allButtonEls = await page.$$('button');
  let moreBtnFallback: any = null;
  for (const btn of allButtonEls) {
    const txt = await btn.evaluate((el: any) => el.textContent?.trim());
    if (txt === '...' || txt === '•••') { moreBtnFallback = btn; break; }
  }
  const moreTarget = moreBtn || moreBtnFallback;
  if (moreTarget) {
    await moreTarget.click();
    await sleep(1500);
    await page.screenshot({ path: 'hackmd-more-menu.png', fullPage: false });
    console.log('   Screenshot: hackmd-more-menu.png');
    // close it
    await page.keyboard.press('Escape');
    await sleep(500);
  } else {
    console.log('   ❌ More button not found');
  }

  // --- Share button (blue, top right) ---
  console.log('\n5. Clicking Share button...');
  // Real selector discovered: button.ui-sharing
  const shareTarget = await page.$('button.ui-sharing');
  if (shareTarget) {
    await shareTarget.click();
    await sleep(1500);
    await page.screenshot({ path: 'hackmd-share-panel.png', fullPage: false });
    console.log('   Screenshot: hackmd-share-panel.png');

    const panelBtns = await page.$$eval('button', (els: any[]) =>
      els.map(el => ({
        text: el.textContent?.trim().slice(0, 50),
        class: el.className.slice(0, 100),
        ariaLabel: el.getAttribute('aria-label'),
        visible: el.offsetParent !== null,
      })).filter(b => b.visible)
    );
    console.log('\n   Buttons after Share click:');
    panelBtns.forEach((b: any) => console.log(`   text="${b.text}" | aria-label="${b.ariaLabel}" | class="${b.class}"`));

    // Look for Publish-related text
    const publishBtn = await page.$('button[aria-label="Publish"]');
    let publishFallback: any = null;
    for (const btn of await page.$$('button')) {
      const txt = await btn.evaluate((el: any) => el.textContent?.trim());
      if (/publish/i.test(txt)) { publishFallback = btn; break; }
    }
    const publishTarget = publishBtn || publishFallback;
    if (publishTarget) {
      const txt = await publishTarget.evaluate((el: any) => el.textContent?.trim());
      const cls = await publishTarget.evaluate((el: any) => el.className);
      console.log(`\n   Found Publish button: text="${txt}" class="${cls}"`);
      await publishTarget.click();
      await sleep(1500);
      await page.screenshot({ path: 'hackmd-publish-modal.png', fullPage: false });
      console.log('   Screenshot: hackmd-publish-modal.png');

      const modalBtns = await page.$$eval('button', (els: any[]) =>
        els.map(el => ({
          text: el.textContent?.trim().slice(0, 50),
          class: el.className.slice(0, 100),
          ariaLabel: el.getAttribute('aria-label'),
          visible: el.offsetParent !== null,
        })).filter(b => b.visible)
      );
      console.log('\n   Buttons in publish modal:');
      modalBtns.forEach((b: any) => console.log(`   text="${b.text}" | aria-label="${b.ariaLabel}" | class="${b.class}"`));
    } else {
      console.log('   ❌ No Publish button found after Share click');
    }
  } else {
    console.log('   ❌ Share button NOT found');
  }

  console.log('\n✅ Debug complete. Check screenshots for visual state.');
  await sleep(3000);
  await ctx.close();
})();

