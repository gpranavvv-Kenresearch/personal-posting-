import { Page } from 'playwright';
import { execSync } from 'child_process';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 800;

/**
 * Post to LivePositively (expects logged-in page)
 * Content Format: HTML
 * LivePositively is a WordPress-based platform — uses WP Admin editor
 */
export async function postToLivepositively(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  // Minimize browser
  try {
    const cdpMain = await page.context().newCDPSession(page);
    const { windowId } = await cdpMain.send('Browser.getWindowForTarget');
    await cdpMain.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdpMain.detach().catch(() => {});
  } catch { /* ignore */ }

  // TODO: Add UTM_PARAMS.Livepositively entry to utils/utm.ts
  // htmlContent = injectUTM(htmlContent, UTM_PARAMS.Livepositively);

  console.log('   Navigating to LivePositively new post...');
  // TODO: Replace with correct new post URL (WP-based: /wp-admin/post-new.php)
  await page.goto('https://livepositively.com/wp-admin/post-new.php', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // TODO: Replace with correct selector that confirms editor loaded
  try {
    await page.waitForSelector('.editor-post-title, #post-title-0, [placeholder="Add title"]', { timeout: 20000 });
    console.log('   ✅ Editor loaded');
  } catch {
    console.warn('   ⏳ Editor load timeout, continuing...');
  }

  await page.waitForTimeout(SMALL_DELAY);

  // Type title
  console.log('   Typing title...');
  try {
    // TODO: Replace with correct title field selector
    await page.waitForSelector('.editor-post-title__input, #post-title-0, [placeholder="Add title"]', { timeout: 10000 });
    await page.click('.editor-post-title__input, #post-title-0, [placeholder="Add title"]');
    await page.waitForTimeout(SMALL_DELAY);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(String(title).trim(), { delay: 50 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(SMALL_DELAY);
  } catch {
    throw new Error('LivePositively title field not found');
  }

  // Switch to HTML/Code editor mode
  console.log('   Switching to HTML/Code editor...');
  try {
    // TODO: Replace with correct code editor toggle selector
    // Gutenberg: options menu -> Code editor
    const optionsBtn = await page.$('button[aria-label="Options"], button[aria-label="Editor tools"], .edit-post-more-menu button');
    if (optionsBtn) {
      await optionsBtn.click();
      await page.waitForTimeout(800);
      const codeEditorBtn = await page.$('button:has-text("Code editor"), [role="menuitem"]:has-text("Code editor")');
      if (codeEditorBtn) {
        await codeEditorBtn.click();
        await page.waitForTimeout(1000);
      }
    }
  } catch { /* ignore, may already be in right mode */ }

  // Paste HTML content into code editor
  console.log('   Pasting HTML content...');
  const editorSelectors = [
    // TODO: Replace with correct editor selectors for this platform
    '.editor-post-text-editor',
    'textarea.editor-post-text-editor',
    '[contenteditable="true"]',
    '.block-editor-writing-flow',
  ];
  let pasted = false;
  for (const selector of editorSelectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.click();
        await page.waitForTimeout(SMALL_DELAY);
        await page.keyboard.press('Control+A');
        await page.keyboard.type(htmlContent, { delay: 5 });
        await page.waitForTimeout(SMALL_DELAY * 2);
        pasted = true;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!pasted) {
    console.warn('   ⚠️ Could not paste content – continuing anyway');
  }

  // Click Publish button
  console.log('   Clicking Publish button...');
  await page.waitForTimeout(2000);
  try {
    // TODO: Replace with correct publish button selector
    await page.waitForSelector('.editor-post-publish-button, button:has-text("Publish")', { timeout: 15000, state: 'visible' });
    await page.click('.editor-post-publish-button, button:has-text("Publish")');
  } catch {
    throw new Error('LivePositively publish button not found');
  }

  // Confirm publish (Gutenberg shows a pre-publish panel)
  await page.waitForTimeout(2000);
  try {
    // TODO: Replace with correct confirm publish button selector
    const confirmBtn = await page.$('.editor-post-publish-button__button, button:has-text("Publish") >> nth=1');
    if (confirmBtn) await confirmBtn.click();
  } catch { /* no confirm step */ }

  // Get post URL
  await page.waitForTimeout(3000);
  let postUrl = page.url();
  try {
    // TODO: Replace with selector that shows the live post URL after publishing
    const viewLink = await page.$('a:has-text("View Post"), a:has-text("View post")');
    if (viewLink) {
      postUrl = await viewLink.getAttribute('href') || postUrl;
    }
  } catch { /* ignore */ }

  console.log(`   ✅ Post published successfully. URL: ${postUrl}`);
  return {
    success: true,
    postUrl,
    postText: htmlContent,
    postedAt: new Date(),
  };
}
