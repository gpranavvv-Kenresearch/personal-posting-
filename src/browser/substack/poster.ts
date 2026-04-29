import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 800;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Post to Substack (expects logged-in page)
 * Content Format: HTML (pasted directly — Substack's Prosemirror editor renders it)
 */
export async function postToSubstack(
  page: Page,
  title: string,
  htmlContent: string,
  publicationUrl: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Substack);

  const newPostUrl = `https://${publicationUrl}/publish/post`;
  console.log(`   Navigating to new post editor: ${newPostUrl}`);
  await page.goto(newPostUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Fill title
  console.log('   Filling title...');
  const titleSelectors = [
    '[data-testid="post-title"]',
    'h1[contenteditable]',
    'div[contenteditable][data-placeholder*="Title"]',
    'div[contenteditable][data-placeholder*="title"]',
    '.post-title [contenteditable]',
    'textarea[placeholder*="Title"]',
    'input[placeholder*="Title"]',
  ];

  let titleFilled = false;
  for (const sel of titleSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        await sleep(300);
        await page.keyboard.press('Control+A');
        await sleep(200);
        await page.keyboard.type(title, { delay: 30 });
        await sleep(SMALL_DELAY);
        titleFilled = true;
        console.log(`   Title filled via: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!titleFilled) {
    throw new Error('Title field not found in Substack editor');
  }

  // Click body editor and paste HTML content
  console.log('   Pasting HTML content...');
  const bodySelectors = [
    '.ProseMirror',
    'div[contenteditable="true"]:not(h1):not([data-placeholder*="Title"])',
    '[data-testid="post-body"] [contenteditable]',
    '.editor-content [contenteditable]',
  ];

  let bodyFilled = false;
  for (const sel of bodySelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        await sleep(500);

        // Insert HTML directly — no clipboard
        await page.evaluate((html) => {
          document.execCommand('insertHTML', false, html);
        }, htmlContent);
        await sleep(2000);

        bodyFilled = true;
        console.log(`   Body pasted via: ${sel}`);
        break;
      }
    } catch {}
  }

  if (!bodyFilled) {
    throw new Error('Body editor not found in Substack editor');
  }

  // Click Publish button
  console.log('   Clicking Publish...');
  const publishSelectors = [
    'button:has-text("Publish")',
    'button:has-text("Publish now")',
    '[data-testid="publish-button"]',
  ];

  let published = false;
  for (const sel of publishSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await btn.click();
        await sleep(2000);
        published = true;
        break;
      }
    } catch {}
  }

  if (!published) {
    throw new Error('Publish button not found in Substack editor');
  }

  // Confirm in publish modal if present (second "Publish" / "Publish now" button)
  try {
    const confirmBtn = page.locator('button:has-text("Publish now"), button:has-text("Publish post")').first();
    if (await confirmBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await confirmBtn.click();
      await sleep(3000);
    }
  } catch {}

  // Wait for redirect to published post
  try {
    await page.waitForURL(`https://${publicationUrl}/p/**`, { timeout: 15000 });
  } catch {
    // URL may not redirect — continue and return current URL
  }

  const publishedUrl = page.url();
  console.log(`   ✅ Post published. URL: ${publishedUrl}`);

  return {
    success: true,
    postUrl: publishedUrl,
    postedAt: new Date(),
  };
}
