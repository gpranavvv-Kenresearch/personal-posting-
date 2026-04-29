import { Page } from 'playwright';
import { getWordpressAccounts } from './login.js';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const CLICK_DELAY = 2000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function jsClick(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) (el as HTMLElement).click();
  }, selector);
}

/**
 * Post to WordPress.com (expects logged-in page)
 * Content Format: HTML
 */
export async function postToWordpress(
  page: Page,
  title: string,
  htmlContent: string,
  nickname?: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  // Minimize browser
  try {
    const cdpMain = await page.context().newCDPSession(page);
    const { windowId } = await cdpMain.send('Browser.getWindowForTarget');
    await cdpMain.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdpMain.detach().catch(() => {});
  } catch { /* ignore */ }

  // Resolve blog URL from accounts
  const accounts = getWordpressAccounts();
  const account = nickname
    ? accounts.find(a => a.nickname?.toLowerCase() === nickname.toLowerCase())
    : accounts.find(a => a.active);
  const blogUrl = account?.blogUrl || 'https://wordpress.com';

  // Inject WordPress UTM into all kenresearch.com links
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.WordPress);

  // Navigate to blog homepage (admin bar lives here)
  console.log(`   Navigating to blog: ${blogUrl}`);
  await page.goto(blogUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Step 1: If landed on login page, click Continue
  if (page.url().includes('/log-in')) {
    console.log('   Detected login page — clicking Continue...');
    await sleep(CLICK_DELAY);
    await jsClick(page, 'a.continue-as-user__continue-button');
    await sleep(5000);
    console.log('   ✅ Clicked Continue');
  }

  // Step 2: Click "New Post" in admin bar
  console.log('   Clicking New Post in admin bar...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'a[href="/wp-admin/post-new.php?post_type=post"]');
  console.log('   ✅ Clicked New Post — waiting 10 seconds for editor...');
  await sleep(10000);

  // Step 3: Click title field and type
  console.log('   Typing title...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'h1[aria-label="Add title"]');
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

  // Step 5: Click editor body and paste
  console.log('   Clicking editor content area and pasting...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'span[data-rich-text-placeholder="Type / to choose a block"]');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');

  // Step 6: Click first Publish button (opens pre-publish panel)
  console.log('   Clicking first Publish button...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.editor-post-publish-panel__toggle.editor-post-publish-button__button.is-primary');
  console.log('   ✅ Pre-publish panel opened');

  // Step 7: Click Upload button
  console.log('   Clicking Upload button...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.components-button.is-primary.is-compact');
  console.log('   ✅ Clicked Upload — waiting 5 seconds...');
  await sleep(5000);

  // Step 8: Click final Publish button
  console.log('   Clicking final Publish button...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.editor-post-publish-button.editor-post-publish-button__button.is-primary');
  console.log('   ✅ Published');

  // Step 9: Click "Add these tags"
  console.log('   Clicking Add these tags...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.wpcom-block-editor-post-published-recommended-tags-modal__save-tags.is-primary');
  console.log('   ✅ Tags added — waiting 5 seconds...');
  await sleep(5000);

  // Step 10: Click "Copy" button and read URL from clipboard
  console.log('   Clicking Copy button...');
  let postUrl = page.url();
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.components-button.is-next-40px-default-size.is-secondary');
  await sleep(1000);
  try {
    postUrl = await page.evaluate(() => navigator.clipboard.readText());
  } catch {
    try {
      const { execSync } = await import('child_process');
      postUrl = execSync('powershell -command Get-Clipboard').toString().trim();
    } catch {
      postUrl = page.url();
    }
  }
  console.log(`   ✅ Post URL copied: ${postUrl}`);

  return {
    success: true,
    postUrl,
    postText: htmlContent,
    postedAt: new Date(),
  };
}
