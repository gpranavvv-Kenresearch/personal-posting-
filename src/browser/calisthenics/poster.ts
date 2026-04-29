/**
 * Calisthenics poster — automated article publishing on calisthenics.mn.co
 */

import { Page } from 'playwright';
import { loginCalisthenics, closeCaliBrowser } from './login.js';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

export interface CalisthenicsPostParams {
  title: string;
  content: string;
  seedKeyword?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function postToCalisthenics(
  nickname: string,
  params: CalisthenicsPostParams
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  let page: Page | null = null;

  try {
    console.log(`📝 Posting to Calisthenics (${nickname})...`);

    // UTM safety net — ensure correct UTMs before posting
    params.content = injectUTM(params.content, UTM_PARAMS.Calisthenics);

    page = await loginCalisthenics(nickname);

    // ── Step 1: Navigate to home and click Create ──────────────────────────────
    console.log('  1️⃣ Navigating to home...');
    await page.goto('https://calisthenics.mn.co/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    console.log('  2️⃣ Clicking Create...');
    await page.waitForSelector('a[title="Create"]', { timeout: 10000 });
    await page.click('a[title="Create"]');
    await sleep(1500);

    // ── Step 2: Select space ───────────────────────────────────────────────────
    console.log('  3️⃣ Selecting space...');
    const spaceItem = await page.$('span.text-color-title-link.space-name.result-item');
    if (spaceItem) {
      await spaceItem.click();
      await sleep(1500);
    } else {
      console.warn('   ⚠️ Space item not found — proceeding');
    }

    // ── Step 3: Click Article ──────────────────────────────────────────────────
    console.log('  4️⃣ Selecting Article...');
    await page.waitForSelector('a[title="Article"]', { timeout: 10000 });
    await page.click('a[title="Article"]');
    await sleep(4000);

    // ── Step 4: Fill title ─────────────────────────────────────────────────────
    console.log('  5️⃣ Filling title...');
    try {
      const titleEditor = page.locator('p[data-placeholder="Title"]').first();
      if (await titleEditor.isVisible().catch(() => false)) {
        await titleEditor.click({ delay: 150 }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await page.keyboard.press('Delete').catch(() => {});
        await sleep(300);
        await page.keyboard.insertText(params.title);
        await sleep(800);
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not fill title: ${(err as any).message}`);
    }

    // ── Step 5: Insert HTML body directly ──────────────────────────────────────
    console.log('  6️⃣ Inserting content...');
    try {
      const bodyEditor = page.locator('p[data-placeholder="Write, type \'/\' for commands…"]').first();
      if (await bodyEditor.isVisible().catch(() => false)) {
        await bodyEditor.click({ delay: 150 }).catch(() => {});
        await sleep(400);
        await page.evaluate((html) => {
          document.execCommand('insertHTML', false, html);
        }, params.content);
        await sleep(2000);
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not insert body: ${(err as any).message}`);
    }

    // ── Step 6: Publish ────────────────────────────────────────────────────────
    console.log('  7️⃣ Publishing...');
    try {
      const postBtn = page.locator('a#post-publish-submit-button:not(.disabled)').first();
      if (await postBtn.isVisible({ timeout: 20000 }).catch(() => false)) {
        await postBtn.click({ delay: 150 }).catch(() => {});
        await sleep(5000);
      } else {
        console.warn('   ⚠️ Publish button not found or disabled');
      }
    } catch (err) {
      console.warn(`   ⚠️ Could not click publish: ${(err as any).message}`);
    }

    // ── Step 7: Extract URL ────────────────────────────────────────────────────
    await sleep(2000);
    let postUrl = page.url().replace('?meta-config=general', '');
    console.log(`  ✅ Post URL: ${postUrl}`);

    await closeCaliBrowser();
    return { success: true, postUrl };

  } catch (err: any) {
    console.error(`  ❌ Calisthenics posting failed: ${err.message}`);
    await closeCaliBrowser();
    return { success: false, error: err.message };
  }
}
