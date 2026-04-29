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
  seoDescription?: string
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const randomDelay = async (min = 800, max = 2200) => {
    await sleep(Math.floor(Math.random() * (max - min + 1)) + min);
  };

  // Minimize browser at start — stays minimized throughout
  try {
    const cdpMain = await page.context().newCDPSession(page);
    const { windowId } = await cdpMain.send('Browser.getWindowForTarget');
    await cdpMain.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdpMain.detach().catch(() => {});
  } catch { /* ignore */ }

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
          await tempPage.waitForTimeout(2000);
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
        await randomDelay(1500, 2500);
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
    if (await shareBox.isVisible().catch(() => false) && seoDescription) {
      await shareBox.click({ delay: 120 }).catch(() => {});
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Delete').catch(() => {});
      await randomDelay(200, 400);

      await page.keyboard.insertText(seoDescription);
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

    // Dismiss Post-Publish Modal
    console.log('   Dismissing post-publish modal...');
    try {
      await page.waitForTimeout(5000);

      const dismissSelectors = [
        'button[data-test-modal-close-btn]',
        'button.artdeco-modal__dismiss[aria-label="Dismiss"]',
        'button.artdeco-modal__dismiss',
        'button[aria-label="Dismiss"]',
        'svg.artdeco-button__icon',
      ];

      let dismissed = false;
      for (const selector of dismissSelectors) {
        const dismissBtn = page.locator(selector).first();
        if (await dismissBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await dismissBtn.click({ delay: 150, force: true }).catch(() => {});
          await randomDelay(1000, 1500);
          dismissed = true;
          break;
        }
      }

      if (!dismissed) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(1000);
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not dismiss modal: ${(err as any).message}`);
    }

    // Click "View post" Button
    console.log('   Waiting for View post button...');
    await page.waitForTimeout(2000);

    const viewPostBtn = page.locator('a:has-text("View post"), a.ember-view[href*="/feed/update/"]').first();
    if (await viewPostBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await viewPostBtn.click({ delay: 200 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded');
      await randomDelay(1200, 1800);
    } else {
      console.log('   ⚠️ View post button not found, trying alternatives...');
      const altView = page.locator('a:has-text("View article"), a:has-text("Open article")').first();
      if (await altView.isVisible({ timeout: 3000 }).catch(() => false)) {
        await altView.click({ delay: 200 }).catch(() => {});
        await page.waitForLoadState('domcontentloaded');
        await randomDelay(1200, 1800);
      }
    }

    // Extract Final URL
    await page.waitForTimeout(3000);

    let finalUrl = '';
    try {
      finalUrl = await page.$eval('link[rel="canonical"]', el => el.getAttribute('href') ?? '').catch(() => '');
    } catch (_) {
      finalUrl = '';
    }

    if (!finalUrl) {
      try {
        finalUrl = await page.$eval('meta[property="og:url"]', el => el.getAttribute('content') ?? '').catch(() => '');
      } catch (_) {
        finalUrl = '';
      }
    }

    if (!finalUrl) {
      finalUrl = page.url();
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
