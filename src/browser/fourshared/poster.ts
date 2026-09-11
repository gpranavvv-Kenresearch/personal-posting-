/**
 * fourshared/poster.ts — Upload a PDF to 4shared and get the shareable link.
 * Expects an already-logged-in page from loginToFourShared().
 *
 * Flow given directly by the user, confirmed live step by step (2026-08-21) —
 * still in progress, see TODOs below:
 *   0. Go directly to https://www.4shared.com/indexUpload.jsp — no need to
 *      land on the homepage and click through to an upload page first.
 *   1. Click "Upload files" (div.jsStartAnonUploadButton) to reveal the
 *      file input. Clicking reveals/activates the underlying
 *      <input type="file"> rather than opening a native OS dialog —
 *      setInputFiles() works on it directly either way.
 *   2. Wait for the upload-complete marker — an element carrying
 *      .jsCompleted (alongside .jsUploadAction.jsUploadState
 *      .jsCopyToClipboard.upload-share-button) only appears once the
 *      upload finishes; this is the real completion signal, not a blind
 *      sleep.
 *   3. The actual shareable URL sits as plain text inside a hidden sibling
 *      span (span.jsD1Link, style="display:none") — read it directly
 *      rather than clicking Share and parsing a popup/clipboard.
 *   4. Click the share/copy button anyway (per the user's instruction) and
 *      exit — not needed to capture the link, just completes the UI flow.
 *
 * TODO: no title/description/notes field has been identified anywhere in
 * this flow, so the UTM-tagged target URL (urlWithUtm below) currently has
 * nowhere to go — 4shared may just not carry it. Revisit if a field turns
 * up.
 */
import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const UPLOAD_PAGE_URL = 'https://www.4shared.com/indexUpload.jsp';

// Native DOM .click() on the first genuinely visible match — see velog/
// poster.ts for why: coordinate-based clicks can miss occluded/duplicate
// elements, and this sidesteps that entirely.
async function clickBySelector(page: Page, selector: string, timeout: number = 15000): Promise<void> {
  const locator = page.locator(selector);
  await locator.first().waitFor({ state: 'attached', timeout });
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.evaluate((el: HTMLElement) => el.click());
    return;
  }
  throw new Error(`Found ${count} match(es) for "${selector}" but none were visible on screen`);
}

export interface FourSharedPostResult {
  success: true;
  postUrl: string;
  postedAt: Date;
}

export async function postToFourShared(
  page: Page,
  filePath: string,
  targetUrl: string,
): Promise<FourSharedPostResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const urlWithUtm = injectUTM(targetUrl, UTM_PARAMS.FourShared);
  // Captured once up front — if a click below opens a new tab and the site's
  // own JS closes the original one afterward, `page` becomes invalid and
  // page.context() would throw on it. The context itself stays valid, so we
  // reach new/remaining tabs through this instead.
  const context = page.context();

  // If a click opened a new tab (or replaced/closed the current one), switch
  // to whichever tab is now the newest — otherwise every following locator
  // call fails with "Target page, context or browser has been closed"
  // against a tab that no longer exists.
  async function followNewTab(current: Page, pageCountBefore: number): Promise<Page> {
    await sleep(300);
    let pages: Page[];
    try {
      pages = context.pages();
    } catch (err: any) {
      throw new Error(`4shared browser context died entirely (not just a tab): ${err.message}`);
    }
    if (pages.length === 0) {
      throw new Error('4shared: every tab in the context closed — nothing left to continue on.');
    }
    if (pages.length > pageCountBefore) {
      const newest = pages[pages.length - 1];
      await newest.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      return newest;
    }
    return current.isClosed() ? pages[pages.length - 1] : current;
  }

  console.log('   Navigating to 4shared upload page...');
  await page.goto(UPLOAD_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // The "Upload files" button triggers a REAL native OS file-picker dialog
  // (not just a hidden <input> we can setInputFiles() on after the fact) —
  // clicking it blind would pop a visible Windows dialog and hang forever
  // with no one there to interact with it. Registering the filechooser
  // listener BEFORE the click lets Playwright intercept and satisfy that
  // dialog programmatically, so no OS window ever actually appears.
  console.log('   Clicking "Upload files"...');
  const pageCount = context.pages().length;
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    clickBySelector(page, 'div.jsStartAnonUploadButton'),
  ]);
  await fileChooser.setFiles(filePath);
  console.log(`   File selected: ${path.basename(filePath)}`);
  page = await followNewTab(page, pageCount);

  console.log('   Waiting at least 5s for the upload to register...');
  await sleep(5000);

  console.log('   Waiting for the upload to finish...');
  const SHARE_BTN_SEL = 'div.jsUploadAction.jsUploadState.jsCompleted.jsCopyToClipboard.upload-share-button, .jsCompleted.upload-share-button';
  await page.locator(SHARE_BTN_SEL).first().waitFor({ state: 'attached', timeout: 120000 });

  void urlWithUtm; // TODO: no field found yet to carry this — see file header

  console.log('   Clicking the share button to copy the link to clipboard...');
  await clickBySelector(page, SHARE_BTN_SEL, 5000);
  await sleep(1000);

  console.log('   Reading the copied link from the clipboard...');
  const clipboardText = (await page.evaluate(() => navigator.clipboard.readText()).catch(() => null))?.trim() ?? '';

  let postUrl: string;
  if (clipboardText.startsWith('http')) {
    postUrl = clipboardText;
  } else {
    console.warn('   ⚠️ Clipboard read failed/empty — falling back to the .jsD1Link text.');
    const linkText = (await page.locator('.jsD1Link').first().textContent().catch(() => null))?.trim() ?? '';
    postUrl = linkText.startsWith('http') ? linkText : page.url();
    if (!linkText.startsWith('http')) {
      console.warn('   ⚠️ Could not read .jsD1Link text either — falling back to current page URL.');
    }
  }

  console.log(`   ✅ 4shared link: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
