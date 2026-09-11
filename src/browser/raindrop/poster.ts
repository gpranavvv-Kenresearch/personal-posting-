/**
 * raindrop/poster.ts — Save a Ken Research URL to Raindrop.io as a bookmark.
 * Expects an already-logged-in page from loginToRaindrop()
 *
 * Confirmed against the real DOM (2026-08-12): Raindrop uses hashed
 * CSS-module class names (e.g. "button-dQdc") that change on every deploy,
 * so every selector here targets by role/text/placeholder instead — the only
 * stable anchors available.
 *
 * Real flow, confirmed step-by-step live: click the "Add Bookmark" button
 * (div[role="button"][title="Add Bookmark"] — the title attribute is a
 * stable anchor, unlike the hashed classes) → an inline quick-add panel
 * opens with ONLY a URL field (textarea[placeholder="https://"]) and a
 * submit button (input[type="submit"][role="button"]) — no title/note/tags
 * fields exist in this panel. Raindrop fetches the title/thumbnail itself
 * after saving. After clicking submit, the browser's own URL bar updates to
 * the saved item's URL directly — no need to reload or query the DOM for it.
 */
import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';
import { pasteText } from '../stagehand.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface RaindropPostResult {
  success: true;
  postUrl: string;
  postedAt: Date;
}

export async function postToRaindrop(
  page: Page,
  title: string,
  targetUrl: string,
  note?: string,
  tags?: string[],
): Promise<RaindropPostResult> {
  const urlWithUtm = injectUTM(targetUrl, UTM_PARAMS.Raindrop);

  console.log('   Navigating to Raindrop home...');
  await page.goto('https://app.raindrop.io/my/0', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  console.log('   Opening "Add Bookmark" quick-add panel...');
  const addBtn = page.locator('div[role="button"][title="Add Bookmark"]').first();
  if (!(await addBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    throw new Error('Raindrop: "Add Bookmark" button not found on the app home page.');
  }
  await addBtn.click();
  await sleep(1200);

  console.log('   Filling bookmark URL...');
  const urlBox = page.locator('textarea[placeholder="https://"]').first();
  if (!(await urlBox.isVisible({ timeout: 5000 }).catch(() => false))) {
    throw new Error('Raindrop: URL textarea (placeholder="https://") not found in the quick-add panel.');
  }
  await urlBox.click();
  await pasteText(page, urlWithUtm);
  await sleep(1500);

  // TODO: note/tags have no field in this quick-add panel. A follow-up step
  // could open the newly-saved item's edit page (…/item/<id>/edit) to set
  // them, but that page's DOM hasn't been inspected yet — not implemented.
  if (note || (tags && tags.length > 0)) {
    console.log('   ⚠️ Raindrop quick-add has no note/tags field — skipping (title/URL only).');
  }

  console.log('   Saving bookmark...');
  const saveBtn = page.locator('input[type="submit"][role="button"], input[type="submit"]').first();
  if (!(await saveBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    throw new Error('Raindrop: submit button not found — bookmark was not submitted.');
  }
  await saveBtn.click({ timeout: 4000 }).catch(() => {});
  await sleep(2500);

  // Confirmed live: the browser's own address bar updates to the saved
  // item's URL right after submit — no reload or DOM query needed.
  const postUrl = page.url();
  console.log(`   ✅ Raindrop bookmark saved: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
