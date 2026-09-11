/**
 * instapaper/poster.ts — Save a Ken Research URL to Instapaper as a bookmark.
 * Expects an already-logged-in page from loginToInstapaper()
 *
 * Confirmed live (2026-08-12) via the Ctrl+K quick-add flow (simpler and
 * more reliable than the old /edit?url=... form, which redirected to the
 * generic /home page with no way to recover the specific bookmark's URL):
 *   1. On /home, press Ctrl+K — opens a modal with
 *      input[name="url"][aria-label="URL"].
 *   2. Type the URL, click button[type="submit"].button-primary ("Add").
 *   3. The new bookmark appears as the first .bookmark-thumbnail in the
 *      list — click it to open the reader view.
 *   4. That navigates to https://www.instapaper.com/read/<id> — THIS is the
 *      real per-bookmark permalink (the old flow never reached it).
 * No title/note field exists in this quick-add modal — Instapaper fetches
 * the title itself from the page.
 */
import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';
import { pasteText } from '../stagehand.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface InstapaperPostResult {
  success: true;
  postUrl: string;
  postedAt: Date;
}

export async function postToInstapaper(
  page: Page,
  title: string,
  targetUrl: string,
  note?: string,
): Promise<InstapaperPostResult> {
  const urlWithUtm = injectUTM(targetUrl, UTM_PARAMS.Instapaper);

  if (note) {
    console.log('   ⚠️ Instapaper quick-add has no note field — skipping (URL only).');
  }

  console.log('   Navigating to Instapaper home...');
  await page.goto('https://www.instapaper.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  console.log('   Opening quick-add (Ctrl+K)...');
  await page.keyboard.press('Control+k');
  await sleep(1000);

  const urlInput = page.locator('input[name="url"]').first();
  if (!(await urlInput.isVisible({ timeout: 5000 }).catch(() => false))) {
    throw new Error('Instapaper: quick-add URL input did not appear after Ctrl+K.');
  }
  await urlInput.click();
  await pasteText(page, urlWithUtm);
  console.log('   ✅ URL pasted');
  await sleep(500);

  console.log('   Clicking Add...');
  const addBtn = page.locator('button[type="submit"].button-primary').first();
  if (!(await addBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    throw new Error('Instapaper: "Add" button not found in the quick-add modal.');
  }
  await addBtn.click({ timeout: 4000 });
  await sleep(2500);

  console.log('   Opening the new bookmark to get its permalink...');
  const thumbnail = page.locator('.bookmark-thumbnail').first();
  let postUrl = page.url();
  if (await thumbnail.isVisible({ timeout: 5000 }).catch(() => false)) {
    await thumbnail.click({ timeout: 4000 }).catch(() => {});
    try {
      await page.waitForURL(/\/read\//, { timeout: 15000 });
      postUrl = page.url();
    } catch {
      console.warn('   ⚠️ Never navigated to /read/<id> — falling back to current URL.');
      postUrl = page.url();
    }
  } else {
    console.warn('   ⚠️ No bookmark thumbnail found to click — falling back to current URL.');
  }

  console.log(`   ✅ Instapaper bookmark saved: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
