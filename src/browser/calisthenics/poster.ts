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

async function attemptPost(page: Page, params: CalisthenicsPostParams): Promise<string> {
  // ── Step 1: Navigate to home and wait for Create button ───────────────────
  console.log('  1️⃣ Navigating to home...');
  await page.goto('https://calisthenics.mn.co/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('a[title="Create"]', { timeout: 30000 });

  console.log('  2️⃣ Clicking Create...');
  await page.click('a[title="Create"]');
  await sleep(800);

  // ── Step 2: Select space ───────────────────────────────────────────────────
  console.log('  3️⃣ Selecting space...');
  const spaceItem = await page.waitForSelector('span.text-color-title-link.space-name.result-item', { timeout: 10000 }).catch(() => null);
  if (spaceItem) {
    await spaceItem.click();
    await sleep(800);
  } else {
    console.warn('   ⚠️ Space item not found — proceeding');
  }

  // ── Step 3: Click Article ──────────────────────────────────────────────────
  console.log('  4️⃣ Selecting Article...');
  await page.waitForSelector('a[title="Article"]', { timeout: 15000 });
  await page.click('a[title="Article"]');
  // Wait for the article editor to fully load (title + body editors must appear)
  await page.waitForSelector('p[data-placeholder="Title"]', { timeout: 30000 });

  // ── Step 4: Fill title ─────────────────────────────────────────────────────
  console.log('  5️⃣ Filling title...');
  try {
    const titleEditor = page.locator('p[data-placeholder="Title"]').first();
    await titleEditor.click({ delay: 150 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await sleep(200);
    await page.keyboard.insertText(params.title);
  } catch (err) {
    console.warn(`   ⚠️ Could not fill title: ${(err as any).message}`);
  }

  // ── Step 5: Insert HTML body directly ──────────────────────────────────────
  console.log('  6️⃣ Inserting content...');
  try {
    const bodyEditor = page.locator('p[data-placeholder="Write, type \'/\' for commands…"]').first();
    if (await bodyEditor.isVisible({ timeout: 10000 }).catch(() => false)) {
      await bodyEditor.click({ delay: 150 }).catch(() => {});
      await sleep(300);
      await page.evaluate((html) => {
        document.execCommand('insertHTML', false, html);
      }, params.content);
      await sleep(1000);
    }
  } catch (err) {
    console.warn(`   ⚠️ Could not insert body: ${(err as any).message}`);
  }

  // ── Step 6: Publish ────────────────────────────────────────────────────────
  console.log('  7️⃣ Publishing...');
  try {
    const postBtn = page.locator('a#post-publish-submit-button:not(.disabled)').first();
    await postBtn.waitFor({ state: 'visible', timeout: 20000 });
    await postBtn.click({ delay: 150 }).catch(() => {});
    // Wait for a proper article URL (mn.co redirects to /posts/<id> after publish)
    await page.waitForFunction(
      () => /\/posts\/\d+/.test(window.location.href),
      { timeout: 20000 }
    ).catch(() => {});
  } catch (err) {
    console.warn(`   ⚠️ Could not click publish: ${(err as any).message}`);
  }

  let postUrl = page.url().replace('?meta-config=general', '');

  // If we landed on the space feed instead of the article, scrape the newest article link
  if (postUrl.includes('/spaces/') || postUrl.includes('/posts/new')) {
    console.warn('   ⚠️ Landed on space feed — trying to extract latest article URL...');
    try {
      const articleUrl = await page.evaluate(() => {
        const link = document.querySelector<HTMLAnchorElement>(
          'a[href*="/posts/"]:not([href*="/posts/new"])'
        );
        return link ? link.href : '';
      });
      if (articleUrl && /\/posts\/\d+/.test(articleUrl)) {
        postUrl = articleUrl;
        console.log(`   Found article URL from feed: ${postUrl}`);
      }
    } catch { /* ignore */ }
  }

  return postUrl;
}

export async function postToCalisthenics(
  nickname: string,
  params: CalisthenicsPostParams
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  const MAX_ATTEMPTS = 3;

  try {
    console.log(`📝 Posting to Calisthenics (${nickname})...`);
    params.content = injectUTM(params.content, UTM_PARAMS.Calisthenics);

    const page = await loginCalisthenics(nickname);

    let postUrl = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        console.warn(`  🔄 Retrying full post procedure (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        await sleep(2000);
      }

      postUrl = await attemptPost(page, params);

      const failed = postUrl.includes('/posts/new') || postUrl.includes('/spaces/');
      if (!failed) break;
      console.warn(`  ⚠️ Attempt ${attempt} landed on bad URL: ${postUrl}`);
    }

    const stillFailed = postUrl.includes('/posts/new') || postUrl.includes('/spaces/');
    if (stillFailed) {
      throw new Error(`Post failed — bad URL after ${MAX_ATTEMPTS} attempts: ${postUrl}`);
    }

    console.log(`  ✅ Post URL: ${postUrl}`);
    await closeCaliBrowser();
    return { success: true, postUrl };

  } catch (err: any) {
    console.error(`  ❌ Calisthenics posting failed: ${err.message}`);
    await closeCaliBrowser();
    return { success: false, error: err.message };
  }
}
