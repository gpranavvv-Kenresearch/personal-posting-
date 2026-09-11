import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function postToParagraph(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  // Minimize browser window
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Paragraph);

  // Step 1: Navigate to home
  console.log('   Navigating to Paragraph home...');
  await page.goto('https://paragraph.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Step 2: Click the "…" / New post button (top-left compose button)
  console.log('   Clicking New Post button...');
  const newPostBtn = page.locator(
    'button.bg-primary-button[class*="w-12"][class*="rounded-xl"]'
  ).first();
  await newPostBtn.waitFor({ state: 'visible', timeout: 15000 });
  await newPostBtn.click();
  await sleep(3000);

  // Step 3: Fill the title
  console.log('   Filling title...');
  const titleField = page.locator('textarea[data-editor-field="title"], textarea[placeholder="Add a title..."]').first();
  await titleField.waitFor({ state: 'visible', timeout: 15000 });
  await titleField.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(title).trim().slice(0, 150), { delay: 40 });
  console.log('   ✅ Title filled');
  await sleep(1000);

  // Step 4: Render HTML into a temp page, copy to clipboard, then paste into editor
  console.log('   Rendering HTML and copying to clipboard...');
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

  console.log('   Clicking editor body and pasting...');
  const editor = page.locator('div[contenteditable="true"]#paragraph-tiptap-editor, div.tiptap.ProseMirror[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.click();
  await sleep(500);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await sleep(300);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');
  await sleep(2000);

  // Step 5: Click the "…" toolbar button (opens a new tab) then come back
  console.log('   Clicking "…" toolbar button...');
  try {
    const ellipsisBtn = page.locator(
      'button.border.border-input.text-foreground.bg-background.hover\\:bg-secondary.rounded-xl'
    ).filter({ hasText: '…' }).first();
    await ellipsisBtn.waitFor({ state: 'visible', timeout: 10000 });

    const [newTab] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
      ellipsisBtn.click(),
    ]);

    if (newTab) {
      console.log('   New tab opened — closing it and returning to editor tab...');
      await newTab.close().catch(() => {});
    }
    await page.bringToFront();
    await sleep(1500);
    console.log('   ✅ Back on editor tab');
  } catch (err: any) {
    console.warn(`   ⚠️ Could not click "…" button: ${err.message}`);
  }

  // Step 6: Click Continue button
  console.log('   Clicking Continue...');
  const continueBtn = page.locator('button:has-text("Continue")').first();
  await continueBtn.waitFor({ state: 'visible', timeout: 15000 });
  await continueBtn.click();
  await sleep(2000);

  // Step 7: Click Publish button
  console.log('   Clicking Publish...');
  const publishBtn = page.locator('button:has-text("Publish")').first();
  await publishBtn.waitFor({ state: 'visible', timeout: 15000 });
  await publishBtn.click();
  await sleep(3000);

  // Step 8: Wait for publish success popup then click Copy link
  console.log('   Waiting 5s for publish success popup...');
  await sleep(5000);

  let postUrl = page.url();
  try {
    console.log('   Clicking Copy link button in popup...');
    const copyBtn = page.locator(
      'button.border-input.bg-background.text-muted-foreground.gap-2.flex-shrink-0'
    ).first();
    await copyBtn.waitFor({ state: 'visible', timeout: 15000 });
    await copyBtn.click();
    console.log('   ✅ Copy link button clicked');
    await sleep(1000);

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    if (clipboardText && clipboardText.includes('paragraph.com')) {
      postUrl = clipboardText.trim();
      console.log(`   ✅ URL from clipboard: ${postUrl}`);
    } else {
      console.warn('   ⚠️ Clipboard did not contain a paragraph.com URL — using page URL');
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not click Copy link button: ${err.message}`);
    postUrl = page.url();
  }

  console.log(`   ✅ Published to Paragraph: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
