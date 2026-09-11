import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function jsClick(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) (el as HTMLElement).click();
  }, selector);
}

export async function postToSubstack(
  page: Page,
  title: string,
  htmlContent: string,
  _publicationUrl?: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Substack);

  // Step 1: Navigate to Substack home
  console.log('   Navigating to Substack home...');
  await page.goto('https://substack.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Step 2: Click Create button
  console.log('   Clicking Create button...');
  await page.click('button[aria-label="Create"]', { timeout: 10000 });
  await sleep(1500);

  // Step 3: Click Article from dropdown
  console.log('   Clicking Article...');
  try {
    // Try the menu item link first
    await page.click('a[role="menuitem"][href*="/publish/post"]', { timeout: 5000 });
  } catch {
    // Fallback: click by text
    await page.getByRole('menuitem').filter({ hasText: 'Article' }).click({ timeout: 5000 });
  }
  console.log('   ✅ Article clicked — waiting for editor...');
  await sleep(4000);

  // Step 4: Fill title
  console.log('   Typing title...');
  await page.click('textarea[data-testid="post-title"]', { timeout: 10000 });
  await sleep(300);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(title).trim(), { delay: 40 });
  console.log('   ✅ Title typed');

  // Step 5: Render HTML in temp page → copy to clipboard → paste into editor
  console.log('   Rendering HTML in temp page and copying...');
  try {
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(300);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
      console.log('   ✅ HTML rendered and copied');
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not render/copy HTML: ${err.message}`);
  }

  // Click editor body and paste
  console.log('   Clicking editor and pasting...');
  await page.click('div[contenteditable="true"][data-testid="editor"]', { timeout: 10000 });
  await sleep(1000);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');
  await sleep(2000);

  // Step 6: Click Publish button
  console.log('   Clicking Publish...');
  await page.click('button[data-testid="publish-button"]', { timeout: 10000 });
  console.log('   ✅ Publish clicked');
  await sleep(3000);

  // Step 7: Click "Send to everyone now"
  console.log('   Clicking Send to everyone now...');
  try {
    await page.getByRole('button', { name: 'Send to everyone now' }).click({ timeout: 10000 });
    console.log('   ✅ Sent to everyone');
  } catch {
    // Fallback text match
    await page.locator('button:has-text("Send to everyone now")').click({ timeout: 5000 });
  }
  await sleep(5000);

  // Step 8: Click the post attachment link which opens the published post in a new tab
  console.log('   Clicking post attachment link to get published URL...');
  let postUrl = page.url();
  try {
    const attachmentLink = page.locator('[data-testid="feed-attachment-link"].postAttachment-eYV3fM').first();
    await attachmentLink.waitFor({ state: 'visible', timeout: 10000 });

    const [newTab] = await Promise.all([
      page.context().waitForEvent('page'),
      attachmentLink.click(),
    ]);

    await newTab.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await sleep(2000);
    postUrl = newTab.url();
    console.log(`   ✅ Got URL from new tab: ${postUrl}`);
    await newTab.close();
  } catch (err: any) {
    console.warn(`   ⚠️ Could not get URL from attachment link, using address bar: ${err.message}`);
    postUrl = page.url();
  }

  console.log(`   ✅ Published. URL: ${postUrl}`);

  return {
    success: true,
    postUrl,
    postedAt: new Date(),
  };
}
