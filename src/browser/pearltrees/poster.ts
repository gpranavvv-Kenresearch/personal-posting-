/**
 * pearltrees/poster.ts — Save a Ken Research URL to Pearltrees as a "pearl".
 * Expects an already-logged-in page from loginToPearltrees()
 *
 * Confirmed step-by-step live (2026-08-14):
 *   0. A premium-upsell ad overlay covers the page on load, every time —
 *      dismiss it FIRST via its close button
 *      (div#close-button-container.sprite-premium-close) before anything
 *      else, or it blocks every subsequent click.
 *   1. Click the "Add" node-action button
 *      (div.nodeaction-add.nodeaction-square-world-add[title="Add"]) — opens
 *      a big creator popup landed on a CATEGORY PICKER (note/collection/
 *      page/photo/file icons), not the URL box directly.
 *   2. Click the "Web page" category icon (div.icon.sprite-creator-page) —
 *      this is what actually reveals div.element.page.selected AND the URL
 *      search box; the "selected" class only appears AFTER this click, it
 *      is not there by default.
 *   3. Paste (not type) the (UTM-tagged) URL into the search box
 *      (input#search-input, placeholder "Type a URL or search by keyword") —
 *      it's a live search-as-you-type field, so keystroke typing can trigger
 *      its own suggestion dropdown mid-entry; a clipboard paste avoids that.
 *   4. Click the "Add" button inside the creator popup
 *      (div.add-button-container .creator-add-button.default).
 *   5. A new pearl element appears on the canvas
 *      (div.uipearl-element.ui-draggable) — click it if it renders in time,
 *      then read the real URL from the address bar. If it doesn't render
 *      (canvas position is dynamic/unpredictable), fall back to whatever
 *      page we're already on rather than fail the whole post.
 */
import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';
import { pasteText } from '../stagehand.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface PearltreesPostResult {
  success: true;
  postUrl: string;
  postedAt: Date;
}

export async function postToPearltrees(
  page: Page,
  title: string,
  targetUrl: string,
): Promise<PearltreesPostResult> {
  void title; // no separate title field in this flow — Pearltrees derives it from the page itself
  const urlWithUtm = injectUTM(targetUrl, UTM_PARAMS.Pearltrees);

  console.log('   Navigating to Pearltrees home...');
  await page.goto('https://www.pearltrees.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);

  console.log('   Dismissing the premium-ad overlay (appears on every load)...');
  const adCloseBtn = page.locator('div#close-button-container.sprite-premium-close').first();
  if (await adCloseBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await adCloseBtn.click({ timeout: 4000 }).catch(() => {});
    await sleep(800);
  }

  console.log('   Clicking "Add"...');
  const addBtn = page.locator('div.nodeaction-add.nodeaction-square-world-add[title="Add"]').first();
  if (!(await addBtn.isVisible({ timeout: 8000 }).catch(() => false))) {
    throw new Error('Pearltrees: "Add" node-action button not found on the home page.');
  }
  await addBtn.click();
  await sleep(1500);

  console.log('   Selecting the "Web page" category...');
  const pageIcon = page.locator('div.icon.sprite-creator-page').first();
  if (!(await pageIcon.isVisible({ timeout: 6000 }).catch(() => false))) {
    throw new Error('Pearltrees: "Web page" category icon (div.icon.sprite-creator-page) not found in the creator popup.');
  }
  await pageIcon.click();
  await sleep(1000);

  console.log('   Waiting for the creator popup\'s URL box...');
  const urlBox = page.locator('input#search-input').first();
  if (!(await urlBox.isVisible({ timeout: 8000 }).catch(() => false))) {
    throw new Error('Pearltrees: creator popup URL box (#search-input) never appeared.');
  }
  await urlBox.click();
  await pasteText(page, urlWithUtm);
  await sleep(1500);

  console.log('   Clicking "Add" in the creator popup...');
  const submitBtn = page.locator('div.add-button-container .creator-add-button.default').first();
  if (!(await submitBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    throw new Error('Pearltrees: creator popup "Add" button not found — pearl was not saved.');
  }
  await submitBtn.click({ timeout: 4000 }).catch(() => {});
  await sleep(3000);

  console.log('   Opening the newly added pearl to read its URL...');
  let postUrl = page.url();
  const newPearl = page.locator('div.uipearl-element.ui-draggable').first();
  if (await newPearl.isVisible({ timeout: 6000 }).catch(() => false)) {
    await newPearl.click({ timeout: 4000 }).catch(() => {});
    await sleep(1500);
    postUrl = page.url();
  } else {
    console.warn('   ⚠️ New pearl element never rendered — falling back to current page URL.');
  }

  console.log(`   ✅ Pearltrees pearl saved: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
