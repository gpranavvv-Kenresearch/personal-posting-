import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const CLICK_DELAY = 2000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function jsClickAnyFrame(page: Page, selector: string): Promise<void> {
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement;
        if (el) {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }
        return false;
      }, selector);
      if (found) return;
    } catch { continue; }
  }
}

function extractFirstImageUrl(html: string): string | null {
  const match = html.match(/<img[^>]+src="([^"]+)"/i);
  return match ? match[1] : null;
}

export async function postToBlogger(
  page: Page,
  title: string,
  htmlContent: string,
  nickname?: string,
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

  // Step 2: Click "Create New Post"
  console.log('   Clicking New Post...');
  await jsClickAnyFrame(page, '[aria-label="Create New Post"]');
  console.log('   ✅ Clicked New Post — waiting 8 seconds for editor...');
  await sleep(8000);

  // Step 3: Click title field and type
  console.log('   Typing title...');
  await sleep(CLICK_DELAY);
  await page.click('input[aria-label="Title"]', { force: true }).catch(() => {});
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(title).trim(), { delay: 50 });
  console.log('   ✅ Title typed');

  // Step 4: Write HTML to clipboard and paste into CodeMirror
  console.log('   Writing HTML to clipboard...');
  await page.evaluate((html) => navigator.clipboard.writeText(html), htmlContent);
  await sleep(CLICK_DELAY);
  await page.click('.CodeMirror.cm-s-default', { force: true }).catch(() => {});
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+V');
  console.log('   ✅ HTML content pasted');

  // Step 5: Insert image via URL
  const imageUrl = extractFirstImageUrl(htmlContent);
  if (imageUrl) {
    console.log(`   Inserting image: ${imageUrl}`);

    await sleep(CLICK_DELAY);
    await jsClickAnyFrame(page, '[jsname="ksKsZd"]');
    console.log('   ✅ Clicked Insert image — waiting 5 seconds to check dropdown...');
    console.log('   ✅ Clicked Insert image — waiting 5 seconds to check dropdown...');
    await sleep(5000);

    await jsClickAnyFrame(page, '[aria-label="By URL"]');
    console.log('   ✅ Clicked By URL');

    await sleep(CLICK_DELAY);
    await jsClickAnyFrame(page, '[jsname="vhZMvf"]');
    await sleep(CLICK_DELAY);
    await page.keyboard.type(imageUrl, { delay: 30 });
    console.log('   ✅ Image URL typed');

    await sleep(CLICK_DELAY);
    await jsClickAnyFrame(page, '[jsname="Slj9he"]');
    console.log('   ✅ Image inserted — waiting 3 seconds...');
    await sleep(3000);
  } else {
    console.log('   ⚠️ No image found in content — skipping image insert');
  }

  // Step 6: Click Publish button
  console.log('   Clicking Publish...');
  await sleep(CLICK_DELAY);
  await jsClickAnyFrame(page, '[jsname="vdQQuc"]');
  console.log('   ✅ Clicked Publish — waiting 3 seconds...');
  await sleep(3000);

  // Step 7: Click confirm Publish
  console.log('   Confirming publish...');
  await sleep(CLICK_DELAY);
  await jsClickAnyFrame(page, '[jsname="LgbsSe"][data-id="EBS5u"]');
  console.log('   ✅ Confirmed — waiting 5 seconds...');
  await sleep(5000);

  // Step 8: Get post URL
  const postUrl = page.url();
  console.log(`   ✅ Published. URL: ${postUrl}`);

  return {
    success: true,
    postUrl,
    postText: htmlContent,
    postedAt: new Date(),
  };
}
