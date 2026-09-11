import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';
import { pasteText } from '../stagehand.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Posts a Tumblr "Link" post: target URL (with UTM) + short caption text.
 *   1. Click the "Link" post-type button on the dashboard.
 *   2. A Gutenberg-style "tumblr/link" block opens — type the URL into it.
 *   3. Click the empty body block below and type the caption.
 *   4. Click "Post now" (then the optional "Post" confirmation if it appears).
 *   5. A green "Posted to {blog}" toast appears bottom-center — click it,
 *      which opens the published post; the URL bar then holds the permalink.
 */
export async function postToTumblr(
  page: Page,
  postText: string,
  targetUrl: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  const urlWithUtm = injectUTM(targetUrl, UTM_PARAMS.Tumblr);
  const hashtagFreePostText = postText
    .replace(/#[\p{L}\p{N}_]+/gu, '')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/:\s*$/, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();

  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  console.log('   Navigating to Tumblr dashboard...');
  try {
    await page.goto('https://www.tumblr.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch { /* timeout ok */ }
  await sleep(3000);

  // Step 1: Click the "Link" post-type button
  console.log('   Clicking Link post button...');
  const LINK_BTN_SELECTORS = [
    'button[aria-label="Link"]',
    'button:has(use[href="#managed-icon__posts-link"])',
    'a[aria-label="Link"]',
  ];
  let linkBtnClicked = false;
  for (const sel of LINK_BTN_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      linkBtnClicked = true;
      console.log(`   ✅ Link button clicked (${sel})`);
      break;
    }
  }
  if (!linkBtnClicked) {
    throw new Error('Tumblr: "Link" post-type button not found — check selectors against the live page.');
  }
  await sleep(2500);

  // Step 2: Fill the Link block with the target URL (+ UTM)
  console.log('   Filling link URL...');
  const LINK_BLOCK_SEL = '[data-type="tumblr/link"]';
  const LINK_INPUT_SELECTORS = [
    `${LINK_BLOCK_SEL} input[type="url"]`,
    `${LINK_BLOCK_SEL} input[type="text"]`,
    `${LINK_BLOCK_SEL} input`,
  ];
  let urlFilled = false;
  try {
    await page.waitForSelector(LINK_BLOCK_SEL, { timeout: 10000 });
    for (const sel of LINK_INPUT_SELECTORS) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        await sleep(300);
        await pasteText(page, urlWithUtm);
        await sleep(500);
        await page.keyboard.press('Enter');
        urlFilled = true;
        console.log(`   ✅ URL pasted (${sel})`);
        break;
      }
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Link block not found: ${err.message}`);
  }
  if (!urlFilled) {
    console.warn('   ⚠️ Could not find the URL input inside the Link block — inspect selectors, continuing anyway.');
  }
  await sleep(2000);

  // Step 3: Click the empty body block and type the caption
  console.log('   Filling caption...');
  const BODY_BLOCK_SELECTORS = [
    'p[aria-label="Add default block"]',
    '.block-editor-default-block-appender__content',
  ];
  let bodyFilled = false;
  for (const sel of BODY_BLOCK_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      await sleep(400);
      await page.keyboard.type(hashtagFreePostText, { delay: 10 });
      bodyFilled = true;
      console.log(`   ✅ Caption typed (${sel})`);
      break;
    }
  }
  if (!bodyFilled) {
    console.warn('   ⚠️ Could not find the caption body block — inspect selectors, continuing anyway.');
  }
  await sleep(1500);

  // Step 4: Click "Post now" — this opens a confirmation step, after which a
  // second, separate button (aria-label="Post", plain text "Post") appears
  // and must also be clicked (confirmed live 2026-09-05).
  console.log('   Clicking Post now...');
  const POST_NOW_BTN_SELECTORS = [
    'button:has-text("Post now")',
    'span:has-text("Post now")',
  ];
  let postNowClicked = false;
  for (const sel of POST_NOW_BTN_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      postNowClicked = true;
      console.log(`   ✅ Post now clicked (${sel})`);
      break;
    }
  }
  if (!postNowClicked) {
    throw new Error('Tumblr: "Post now" button not found — post was not submitted.');
  }
  await sleep(1500);

  // Step 4b (optional): Sometimes "Post now" opens a second confirmation step
  // with a separate "Post" button; other times "Post now" submits directly.
  // Click the confirmation if it shows up, otherwise carry on — its absence
  // is not a failure.
  console.log('   Checking for optional "Post" confirmation button...');
  const postBtn = page.locator('button[aria-label="Post"]').first();
  if (await postBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await postBtn.click({ timeout: 4000 }).catch(() => {});
    console.log('   ✅ Post confirmation clicked');
  } else {
    console.log('   ℹ️ No "Post" confirmation button appeared — "Post now" submitted directly, continuing.');
  }
  await sleep(5000);

  // Step 5: Wait for the green "Posted to {blog}" toast, click it to open the
  // published post, then read the permalink off the address bar.
  console.log('   Looking for the "Posted to {blog}" confirmation toast...');
  const TOAST_SELECTORS = [
    'div:has-text("Posted to")',
    '.a0A37.LNdFd', // live-inspected class names — may drift across Tumblr deploys
  ];
  let toastClicked = false;
  for (const sel of TOAST_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
      await el.click({ timeout: 4000, force: true }).catch(() => {});
      toastClicked = true;
      console.log(`   ✅ Confirmation toast clicked (${sel})`);
      break;
    }
  }
  if (!toastClicked) {
    console.warn('   ⚠️ Confirmation toast not found — falling back to current page URL.');
  }
  await sleep(2000);

  const postUrl = page.url();
  console.log(`   ✅ Tumblr post URL: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
