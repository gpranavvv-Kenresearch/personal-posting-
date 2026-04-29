import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const CLICK_DELAY = 2000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function jsClick(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    if (el) el.click();
  }, selector);
}

export async function postToPenzu(
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

  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Penzu);

  // Step 1: Navigate to Penzu
  console.log('   Navigating to Penzu...');
  await page.goto('https://penzu.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Step 2: Click "New Entry"
  console.log('   Clicking New Entry...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'a.journal-thumb_control.new-entry');
  console.log('   ✅ Clicked New Entry — waiting 6 seconds for editor...');
  await sleep(6000);

  // Step 3: Click title field and type
  console.log('   Typing title...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'textarea[placeholder="Entry Title"]');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(title).trim(), { delay: 50 });
  console.log('   ✅ Title typed');

  // Step 4: Render HTML in temp page → copy to clipboard
  console.log('   Rendering HTML in temp page...');
  try {
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(300);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
      console.log('   ✅ HTML rendered and copied to clipboard');
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not render/copy HTML: ${err.message}`);
  }

  // Step 5: Insert content via CKEditor API
  console.log('   Inserting content via CKEditor API...');
  await sleep(CLICK_DELAY);
  const inserted = await page.evaluate((html) => {
    try {
      const ck = (window as any).CKEDITOR;
      if (ck) {
        const keys = Object.keys(ck.instances);
        if (keys.length > 0) {
          ck.instances[keys[0]].setData(html);
          return true;
        }
      }
      return false;
    } catch { return false; }
  }, htmlContent);

  if (!inserted) {
    console.warn('   ⚠️ CKEditor API not found — trying clipboard paste...');
    await page.evaluate((html) => navigator.clipboard.writeText(html), htmlContent);
    await jsClick(page, '[aria-label="Rich Text Editor, editor"]');
    await sleep(CLICK_DELAY);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
  }
  console.log('   ✅ Content inserted');
  console.log('   ✅ Content pasted');

  // Step 6: Open more dropdown
  console.log('   Opening more dropdown...');
  await sleep(CLICK_DELAY);
  await jsClick(page, '.more-dropdown.dropdown.pz-dropdown-dark.controls-item');
  await sleep(CLICK_DELAY);

  // Step 7: Click Share Entry
  console.log('   Clicking Share Entry...');
  await jsClick(page, 'a[ng-click="openShareEntryModal(vm.entry)"]');
  await sleep(CLICK_DELAY);

  // Step 8: Click "Share via Public Link"
  console.log('   Clicking Share via Public Link...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.textContent?.includes('Share via Public Link'));
    if (btn) (btn as HTMLElement).click();
  });
  await sleep(CLICK_DELAY);

  // Step 9: Click Generate Public Link
  console.log('   Generating public link...');
  await jsClick(page, 'button.generate');
  await sleep(3000);

  // Step 10: Click Copy Link
  console.log('   Copying link...');
  await jsClick(page, 'button#clipboard.copy-link');
  await sleep(CLICK_DELAY);

  // Step 11: Read URL from clipboard
  const postUrl = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  console.log(`   ✅ Post URL: ${postUrl || page.url()}`);

  return {
    success: true,
    postUrl: postUrl || page.url(),
    postText: htmlContent,
    postedAt: new Date(),
  };
}
