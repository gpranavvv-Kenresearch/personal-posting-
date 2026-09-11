import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const CLICK_DELAY = 2000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function postToBlogger(
  page: Page,
  title: string,
  htmlContent: string,
  _nickname?: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  // Position window top-left
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, windowState: 'normal' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Blogger);

  // Step 1: Navigate to Blogger dashboard
  console.log('   Navigating to Blogger dashboard...');
  await page.goto('https://www.blogger.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(CLICK_DELAY);

  // Step 2: Click "Create new post" — retry until URL contains post/edit
  console.log('   Clicking New Post...');
  const MAX_TRIES = 5;
  let editorOpen = false;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    await sleep(CLICK_DELAY);
    if (attempt === 1) {
      const btns = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="button"],[role="link"],a,button')).map(el => ({
          tag: (el as HTMLElement).tagName,
          aria: el.getAttribute('aria-label') || '',
          text: ((el as HTMLElement).textContent || '').trim().slice(0, 40),
        })).filter(b => b.aria || b.text)
      );
      console.log('   [DEBUG] clickable elements:');
      for (const b of btns.slice(0, 20)) console.log(`     ${b.tag} aria="${b.aria}" text="${b.text}"`);
    }
    try {
      await page.getByRole('button', { name: 'Create new post' }).click();
    } catch { /* try other selectors */ }
    try {
      await page.waitForURL(/\/(post\/edit|post\/create|post\/g)/, { timeout: 8000 });
      editorOpen = true;
      console.log(`   ✅ Editor opened on try ${attempt}: ${page.url()}`);
      break;
    } catch {
      console.log(`   ⚠️ Still on ${page.url()} — retrying (${attempt}/${MAX_TRIES})`);
    }
  }
  if (!editorOpen) throw new Error(`Failed to open Blogger editor after ${MAX_TRIES} tries`);
  console.log('   ⏳ Waiting 6 seconds for editor to load...');
  await sleep(6000);

  // Step 3: Switch to HTML view
  console.log('   Switching to HTML view...');
  await page.getByRole('listbox', { name: 'Toggle view' }).click();
  await sleep(1500);
  await page.getByRole('option', { name: 'HTML view' }).click();
  console.log('   ✅ HTML view selected');
  await sleep(1500);

  // Step 4: Type title
  console.log('   Typing title...');
  await page.click('input[aria-label="Title"]', { force: true });
  await sleep(500);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(title).trim(), { delay: 50 });
  console.log('   ✅ Title typed');

  // Step 5: Set HTML content directly into CodeMirror (images embedded in HTML)
  console.log('   Setting HTML content in CodeMirror...');
  const cmSet = await page.evaluate((html) => {
    const cm = (document.querySelector('.CodeMirror') as any)?.CodeMirror;
    if (cm) { cm.setValue(html); cm.focus(); return true; }
    return false;
  }, htmlContent);
  if (!cmSet) {
    console.warn('   ⚠️ CodeMirror not found — clipboard paste fallback');
    await page.evaluate((html) => navigator.clipboard.writeText(html), htmlContent);
    await page.click('.CodeMirror', { force: true }).catch(() => {});
    await sleep(500);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await sleep(300);
    await page.keyboard.press('Control+V');
  }
  console.log('   ✅ HTML content set');
  await sleep(CLICK_DELAY);

  // Step 6: Click Publish button (class O0WRkf = editor primary, not post-list)
  console.log('   Clicking Publish...');
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
  const pub1 = await page.evaluate(() => {
    const all = document.querySelectorAll('[aria-label="Publish"]');
    for (const el of Array.from(all)) {
      if ((el as HTMLElement).classList.contains('O0WRkf')) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  });
  if (!pub1) throw new Error('Publish button not found');
  console.log('   ✅ Clicked Publish');
  await sleep(3000);

  // Step 7: Confirm publish in alertdialog
  console.log('   Confirming publish...');
  try {
    await page.getByRole('button', { name: 'Confirm' }).click({ timeout: 15000 });
    console.log('   ✅ Confirmed publish');
  } catch {
    throw new Error('Confirm Publish button not found');
  }
  await sleep(6000);

  // Step 8: Wait for posts list and read View link href
  console.log('   Reading post URL from posts list...');
  let postUrl = '';
  try {
    await page.waitForURL(/\/blog\/posts\//, { timeout: 15000 });
    await sleep(2000);
    postUrl = await page.evaluate(() => {
      const el = document.querySelector('a[aria-label="View"].FKF6mc') as HTMLAnchorElement | null;
      return el ? el.getAttribute('href') || '' : '';
    });
    console.log(`   ✅ Post URL: ${postUrl}`);
  } catch {
    postUrl = page.url();
    console.warn(`   ⚠️ Could not read View href, using page URL: ${postUrl}`);
  }
  if (!postUrl) postUrl = page.url();

  return {
    success: true,
    postUrl,
    postText: htmlContent,
    postedAt: new Date(),
  };
}
