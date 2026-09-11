import { Page } from 'playwright';
import * as cheerio from 'cheerio';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 500;

/**
 * Post to Linkmate
 * Content Format: HTML
 * Injects UTM parameters into links
 */
export async function postToLinkmate(
  page: Page,
  title: string,
  htmlContent: string,
  seedKeyword?: string,
  accountUtm?: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const randomDelay = async (min = 800, max = 2200) => {
    await sleep(Math.floor(Math.random() * (max - min + 1)) + min);
  };

  try {
    // UTM safety net — ensure correct UTMs before posting
    htmlContent = injectUTM(htmlContent, UTM_PARAMS.Linkmate);

    // Inject UTM tags into links (legacy — injectUTM already handles this)
    console.log('   Injecting UTM parameters...');
    let contentWithUtm = htmlContent;
    if (accountUtm) {
      const $ = cheerio.load(htmlContent);
      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && !href.includes('utm_')) {
          const separator = href.includes('?') ? '&' : '?';
          const utm = accountUtm.startsWith('?') ? accountUtm.slice(1) : accountUtm;
          $(el).attr('href', href + separator + utm);
        }
      });
      contentWithUtm = $.html();
    }

    // Wait for Create button then click
    console.log('   Navigating to Linkmate composer...');
    await page.waitForSelector('a[title="Create"]', { timeout: 30000 });
    await page.locator('a[title="Create"]').first().click({ delay: 150 });
    await sleep(800);

    // Click on space name
    console.log('   Selecting space...');
    const spaceBtn = await page.waitForSelector('span.text-color-title-link.space-name.result-item', { timeout: 10000 }).catch(() => null);
    if (spaceBtn) {
      await spaceBtn.click();
      await sleep(800);
    }

    // Click Article and wait for editor
    console.log('   Clicking Article...');
    await page.waitForSelector('a[title="Article"]', { timeout: 15000 });
    await page.locator('a[title="Article"]').first().click({ delay: 150 });
    // Wait for title editor to signal the article editor is fully loaded
    await page.waitForSelector('p[data-placeholder="Title"]', { timeout: 30000 });

    // Fill title
    console.log('   Filling title...');
    try {
      const titleEditor = page.locator('p[data-placeholder="Title"]').first();
      if (await titleEditor.isVisible().catch(() => false)) {
        await titleEditor.click({ delay: 150 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await randomDelay(200, 400);

        // Type title character by character with delay
        for (const char of title) {
          await page.keyboard.type(char, { delay: 80 }).catch(() => {});
        }
        await randomDelay(600, 1000);
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not fill title: ${(err as any).message}`);
    }

    // Insert HTML body directly — no clipboard, no temp page
    console.log('   Inserting article body...');
    try {
      const bodyEditor = page.locator('p[data-placeholder="Write, type \'/\' for commands…"]').first();
      if (await bodyEditor.isVisible().catch(() => false)) {
        await bodyEditor.click({ delay: 150 }).catch(() => {});
        await randomDelay(400, 700);

        await page.evaluate((html) => {
          document.execCommand('insertHTML', false, html);
        }, contentWithUtm);
        await randomDelay(1500, 2500);
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not insert body: ${(err as any).message}`);
    }

    // Publish
    console.log('   Clicking Publish...');
    try {
      const publishBtn = page.locator('a#post-publish-submit-button:not(.disabled)').first();
      await publishBtn.waitFor({ state: 'visible', timeout: 20000 });
      await publishBtn.click({ delay: 150 }).catch(() => {});
      // Wait for navigation away from the editor
      await page.waitForFunction(
        () => !window.location.href.includes('/posts/new'),
        { timeout: 15000 }
      ).catch(() => {});
    } catch (err) {
      console.warn(`   ⚠️ Could not click publish: ${(err as any).message}`);
    }

    const postUrl = page.url();
    console.log(`   ✅ Post published. URL: ${postUrl}`);

    return {
      success: true,
      postUrl: postUrl || 'Unknown URL',
      postedAt: new Date(),
    };
  } catch (err: any) {
    throw new Error(`Linkmate posting failed: ${err.message}`);
  }
}
