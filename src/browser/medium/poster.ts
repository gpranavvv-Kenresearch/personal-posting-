import { Page } from 'playwright';
import { execSync } from 'child_process';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 800;

/**
 * Post to Medium (expects logged-in page)
 * Content Format: HTML
 */
export async function postToMedium(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  // Minimize browser at start — stays minimized throughout
  try {
    const cdpMain = await page.context().newCDPSession(page);
    const { windowId } = await cdpMain.send('Browser.getWindowForTarget');
    await cdpMain.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdpMain.detach().catch(() => {});
  } catch { /* ignore */ }

  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Medium);

  console.log('   Navigating to Medium feed...');
  await page.goto('https://medium.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for feed
  try {
    await page.waitForSelector('[data-testid="headerWriteButton"]', { timeout: 20000 });
    console.log('   ✅ Feed loaded');
  } catch {
    console.warn('   ⏳ Feed load timeout, continuing...');
  }

  // Click "Write" button
  console.log('   Clicking Write button...');
  try {
    await page.waitForSelector('[data-testid="headerWriteButton"]', { timeout: 10000 });
    await page.click('[data-testid="headerWriteButton"]');
  } catch {
    throw new Error('Write button not found');
  }

  // Wait for new story page
  try {
    await page.waitForURL('**/new-story**', { timeout: 15000 });
    console.log('   New story page opened');
  } catch {
    throw new Error('New story page did not load');
  }

  await page.waitForTimeout(SMALL_DELAY);

  // Fill title — type character by character (no paste)
  console.log('   Typing title...');
  try {
    await page.waitForSelector('[data-testid="editorTitleParagraph"]', { timeout: 10000 });
    await page.click('[data-testid="editorTitleParagraph"]');
    await page.waitForTimeout(SMALL_DELAY);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(String(title).trim(), { delay: 50 });
    await page.waitForTimeout(1000);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(SMALL_DELAY);
  } catch {
    throw new Error('Title field not found or not writable');
  }

  // Render HTML in temp page → copy to clipboard → paste into Medium editor
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

  // Click into the editor body and paste
  console.log('   Clicking paragraph field and pasting...');
  const editorSelectors = [
    '[data-testid="editorParagraphText"]',
    'div.public-DraftEditor-content',
    'div[role="textbox"]',
    '[contenteditable="true"]',
  ];
  let pasted = false;
  for (const selector of editorSelectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        await el.click();
        await page.waitForTimeout(SMALL_DELAY);
        await page.keyboard.press('Control+V');
        await page.waitForTimeout(SMALL_DELAY * 3);
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

  // Click publish button
  console.log('   Waiting 2 seconds before clicking Publish...');
  await page.waitForTimeout(2000);
  console.log('   Clicking pre-publish button...');
  try {
    await page.waitForSelector('button[data-action="show-prepublish"], button.js-publishButton', { timeout: 15000, state: 'visible' });
    await page.click('button[data-action="show-prepublish"], button.js-publishButton');
  } catch {
    throw new Error('Publish button not found');
  }

  // Wait and click final publish
  console.log('   Waiting 3 seconds before final Publish...');
  await page.waitForTimeout(3000);
  console.log('   Clicking final Publish button...');
  try {
    await page.waitForSelector('button:has-text("Publish")', { timeout: 15000, state: 'visible' });
    await page.click('button:has-text("Publish")');
  } catch {
    throw new Error('Final Publish button not found');
  }

  // Wait for success and copy link
  console.log('   Waiting 3 seconds for publish success popup...');
  await page.waitForTimeout(3000);
  console.log('   Clicking Copy Link button...');
  try {
    await page.waitForSelector('[data-testid="publishSuccessCopyLinkButton"]', { timeout: 15000, state: 'visible' });
    await page.click('[data-testid="publishSuccessCopyLinkButton"]');
    await page.waitForTimeout(1000);
  } catch {
    throw new Error('Medium rate limit — cannot post for 24 hr');
  }

  // Read clipboard
  let postUrl = '';
  try {
    postUrl = await page.evaluate(() => navigator.clipboard.readText());
  } catch {
    try {
      postUrl = execSync('powershell -command Get-Clipboard').toString().trim();
    } catch {
      postUrl = page.url();
    }
  }

  console.log(`   ✅ Post published successfully. URL: ${postUrl}`);
  return {
    success: true,
    postUrl,
    postText: htmlContent,
    postedAt: new Date(),
  };
}
