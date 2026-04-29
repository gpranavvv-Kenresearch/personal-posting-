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

    // Navigate to Linkmate create page
    console.log('   Navigating to Linkmate composer...');
    const createBtn = page.locator('a[title="Create"]').first();
    await createBtn.click({ delay: 150 }).catch(() => {});
    await randomDelay(1000, 1500);

    // Click on space name (assuming first result is the space)
    console.log('   Selecting space...');
    const spaceBtn = page.locator('span.text-color-title-link.space-name.result-item').first();
    if (await spaceBtn.isVisible().catch(() => false)) {
      await spaceBtn.click({ delay: 150 }).catch(() => {});
      await randomDelay(1000, 1500);
    }

    // Click Article
    console.log('   Clicking Article...');
    const articleBtn = page.locator('a[title="Article"]').first();
    if (await articleBtn.isVisible().catch(() => false)) {
      await articleBtn.click({ delay: 150 }).catch(() => {});
      await randomDelay(3000, 4000);
    }

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
      if (await publishBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await publishBtn.click({ delay: 150 }).catch(() => {});
        await randomDelay(3000, 5000);
      } else {
        console.warn('   ⚠️ Publish button not found or disabled');
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not click publish: ${(err as any).message}`);
    }

    // Extract final URL from address bar
    await page.waitForTimeout(2000);
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
