import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 500;

/**
 * Post to LinkedIn Pulse (LinkedIn Articles)
 * Expects already-logged-in page from loginToLinkedInPulse()
 * Content Format: HTML
 */
export async function postToLinkedinPulse(
  page: Page,
  title: string,
  htmlContent: string,
  seoTitle?: string,
  seoDescription?: string,
  shareCaption?: string
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const randomDelay = async (min = 800, max = 2200) => {
    await sleep(Math.floor(Math.random() * (max - min + 1)) + min);
  };

  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.LinkedIn);

  try {
    console.log('   Navigating to LinkedIn article composer...');
    await page.goto('https://www.linkedin.com/article/new/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Fill Title
    console.log('   Filling article title...');
    await page.waitForSelector('#article-editor-headline__textarea', { timeout: 20000 }).catch(() => {});
    const titleField = page.locator('#article-editor-headline__textarea').first();

    if (await titleField.isVisible().catch(() => false)) {
      await titleField.click({ delay: 150 });
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await randomDelay(200, 400);
      await page.keyboard.insertText(title);
      await randomDelay(600, 1000);
    }

    // Paste Body — render HTML in temp page → copy → paste into editor
    console.log('   Pasting article body...');
    try {
      const bodyField = page.locator('p.article-editor-paragraph[aria-label*="Write here"]').first();
      if (await bodyField.isVisible().catch(() => false)) {
        // Render HTML in a temp page and copy to clipboard
        const tempPage = await page.context().newPage();
        try {
          await tempPage.setContent(htmlContent, { waitUntil: 'networkidle', timeout: 20000 }).catch(() =>
            tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 10000 })
          );
          await tempPage.waitForTimeout(5000);
          await tempPage.keyboard.press('Control+A');
          await tempPage.waitForTimeout(300);
          await tempPage.keyboard.press('Control+C');
          await tempPage.waitForTimeout(500);
        } finally {
          await tempPage.close();
        }

        await bodyField.click({ delay: 200 }).catch(() => {});
        await randomDelay(400, 700);
        await page.keyboard.press('Control+V');
        console.log('   Waiting 10s for pasted content to settle before continuing...');
        await sleep(10000);
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not paste body: ${(err as any).message}`);
    }

    // Fill SEO Fields via Manage > Settings
    if (seoTitle || seoDescription) {
      console.log('   Filling SEO fields...');
      try {
        const manageBtn = page.locator('button[aria-label="Manage menu"], button:has-text("Manage")').first();
        if (await manageBtn.isVisible().catch(() => false)) {
          await manageBtn.click({ delay: 180 }).catch(() => {});
          await randomDelay(1000, 1500);

          const settingsItem = page.locator('div[role="button"]:has-text("Settings")').first();
          if (await settingsItem.isVisible().catch(() => false)) {
            await settingsItem.click({ delay: 160 }).catch(() => {});
            await randomDelay(1500, 2000);

            // Fill SEO Title
            const seoTitleInput = page.locator('input[name="seoTitle"]').first();
            if (await seoTitleInput.isVisible().catch(() => false) && seoTitle) {
              await seoTitleInput.click({ delay: 120 });
              await page.keyboard.press('Control+A').catch(() => {});
              await page.keyboard.press('Delete').catch(() => {});
              await page.keyboard.insertText(seoTitle);
              await randomDelay(400, 600);
            }

            // Fill SEO Description
            const seoDescInput = page.locator('textarea[name="seoDescription"]').first();
            if (await seoDescInput.isVisible().catch(() => false) && seoDescription) {
              await seoDescInput.click({ delay: 120 });
              await page.keyboard.press('Control+A').catch(() => {});
              await page.keyboard.press('Delete').catch(() => {});
              await page.keyboard.insertText(seoDescription);
              await randomDelay(400, 600);
            }

            // Save SEO settings
            const saveBtn = page.locator('button.artdeco-button--primary:has-text("Save")').first();
            if (await saveBtn.isVisible().catch(() => false)) {
              await saveBtn.click({ delay: 150 }).catch(() => {});
              await randomDelay(1200, 1600);
            }
          }
        }
      } catch (err) {
        console.warn(`   ⚠️ Could not fill SEO fields: ${(err as any).message}`);
      }
    }

    // Minimize inline image if present (blocks Next button)
    console.log('   Checking for inline image to minimize...');
    try {
      const minimizeBtn = page.locator('button[data-test-resize-image-button="true"], button[aria-label="Minimize image"]').first();
      if (await minimizeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('   Detected inline image — minimizing...');
        await minimizeBtn.click({ delay: 150 }).catch(() => {});
        await randomDelay(800, 1200);
      }
    } catch { /* ignore */ }

    // Click NEXT
    console.log('   Clicking Next...');
    const nextBtn = page.locator('button:has-text("Next")').first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click({ delay: 150 }).catch(() => {});
      await randomDelay(1200, 1800);
    }

    // Wait for Share Box & Paste Description
    console.log('   Waiting for share box...');
    await page.waitForSelector('div[role="textbox"][data-placeholder*="Tell your network"]', { timeout: 15000 }).catch(() => {});

    const shareBox = page.locator('div[role="textbox"][data-placeholder*="Tell your network"]').first();
    const shareText = shareCaption || seoDescription;
    if (await shareBox.isVisible().catch(() => false) && shareText) {
      await shareBox.click({ delay: 120 }).catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await randomDelay(200, 400);

      await page.keyboard.insertText(shareText);
      await randomDelay(800, 1200);
    }

    // Click PUBLISH Button
    console.log('   Clicking Publish...');
    const publishBtn = page.locator('button.share-actions__primary-action.artdeco-button--primary, button:has-text("Publish")').first();
    if (await publishBtn.isVisible().catch(() => false)) {
      await publishBtn.click({ delay: 150 }).catch(() => {});
      await randomDelay(1500, 2200);
    } else {
      // Fallback: try pressing Enter
      try {
        await page.keyboard.press('Enter').catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }

    // Click "Get the link to this article" to capture the /pulse/ URL
    console.log('   Waiting for post-publish modal...');
    await page.waitForTimeout(5000);

    let finalUrl = '';
    try {
      const getLinkBtn = page.locator('button.post-publish-modal__get-link-button, button:has(span:has-text("Get the link to this article"))').first();
      if (await getLinkBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
        await getLinkBtn.click({ delay: 150 }).catch(() => {});
        console.log('   Clicked Get the link to this article');
        await page.waitForTimeout(2000);

        // Click the Copy button in the link modal — this is the only source of truth for the /pulse/ URL
        const copyBtn = page.locator('button:has-text("Copy"), button[aria-label*="Copy"], button.share-box-send-link__copy-button').last();
        if (await copyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await copyBtn.click({ delay: 150 }).catch(() => {});
          console.log('   Clicked Copy button in link modal');
          await page.waitForTimeout(1000);
        }

        // Read URL from clipboard (populated by the Copy button above)
        finalUrl = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
        console.log(`   Clipboard URL: ${finalUrl}`);
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not get article link: ${(err as any).message}`);
    }

    // Fallback — read from page meta (never use address bar)
    if (!finalUrl || !finalUrl.includes('/pulse/')) {
      finalUrl = await page.$eval('link[rel="canonical"]', el => el.getAttribute('href') ?? '').catch(() => '');
    }
    if (!finalUrl || !finalUrl.includes('/pulse/')) {
      finalUrl = await page.$eval('meta[property="og:url"]', el => el.getAttribute('content') ?? '').catch(() => '');
    }

    console.log(`   ✅ Article published. URL: ${finalUrl}`);

    return {
      success: true,
      postUrl: finalUrl || 'Unknown URL',
      postedAt: new Date(),
    };
  } catch (err: any) {
    throw new Error(`LinkedIn Pulse posting failed: ${err.message}`);
  }
}
