import { Page, Locator } from 'playwright';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Posts to Mastodon (mastodon.social). Flow confirmed by live inspection:
 * type the full post (content + URL + UTM + hashtags, already under 500
 * chars — see generateMastodonPost) into the compose textarea, click Post,
 * wait for the "Post published." toast bottom-left, click its "Open" button
 * to reveal the published post, then read the permalink off the address bar.
 */
export async function postToMastodon(
  page: Page,
  postText: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  // Confirmed live (2026-08-12): the root / redirects to /home, the
  // multi-column timeline view — it has NO inline compose box in this UI
  // version. The actual compose form only lives at /publish.
  console.log('   Navigating to Mastodon compose page...');
  try {
    await page.goto('https://mastodon.social/publish', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch { /* timeout ok */ }
  await sleep(2500);

  // Step 1: Click the compose textarea and type the post
  console.log('   Filling compose box...');
  const TEXTAREA_SELECTORS = [
    'textarea.autosuggest-textarea__textarea',
    'textarea[aria-label="What\'s on your mind?"]',
  ];
  let textareaEl: Locator | null = null;
  for (const sel of TEXTAREA_SELECTORS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
      await el.click();
      await sleep(300);
      await page.keyboard.type(postText, { delay: 8 });
      textareaEl = el;
      console.log(`   ✅ Post text typed (${sel})`);
      break;
    }
  }
  if (!textareaEl) {
    throw new Error('Mastodon: compose textarea not found — post was not typed.');
  }
  await sleep(1000);

  // Verify the text actually landed before trying to submit — typing into a
  // React-controlled textarea can silently no-op if focus was lost.
  const typedValue = await textareaEl.inputValue().catch(() => '');
  if (!typedValue.trim()) {
    throw new Error('Mastodon: compose box is empty after typing — text did not register.');
  }

  // Step 2: Submit. The Post button is disabled (pointer-events blocked)
  // until Mastodon's client-side validation passes, so wait for it to be
  // enabled rather than clicking blind — a click on a disabled button is a
  // silent no-op in Playwright, which is what caused it to look "clicked"
  // but never actually submit. Ctrl+Enter (Mastodon's own submit shortcut)
  // is the fallback if the button click still doesn't register.
  console.log('   Waiting for Post button to be enabled...');
  const POST_BTN_SELECTOR = 'button[type="submit"].button--compact:has-text("Post")';
  const postBtn = page.locator(POST_BTN_SELECTOR).first();
  await postBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  try {
    await page.waitForFunction(
      (sel) => {
        const btn = document.querySelector(sel) as HTMLButtonElement | null;
        return !!btn && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled;
      },
      POST_BTN_SELECTOR,
      { timeout: 8000 }
    );
  } catch {
    console.warn('   ⚠️ Post button never reported enabled — attempting click anyway.');
  }

  console.log('   Clicking Post...');
  let posted = false;
  if (await postBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    try {
      await postBtn.click({ timeout: 4000 });
      posted = true;
      console.log('   ✅ Post button clicked');
    } catch (err: any) {
      console.warn(`   ⚠️ Post button click failed: ${err.message}`);
    }
  }

  // Confirm the compose box actually emptied (real signal the post went
  // through) — if not, fall back to the Ctrl+Enter keyboard shortcut.
  await sleep(1200);
  const stillFull = (await textareaEl.inputValue().catch(() => '')).trim().length > 0;
  if (!posted || stillFull) {
    console.log('   Compose box still has text — falling back to Ctrl+Enter submit shortcut...');
    await textareaEl.click().catch(() => {});
    await page.keyboard.press('Control+Enter');
    await sleep(1200);
    const clearedNow = (await textareaEl.inputValue().catch(() => '')).trim().length === 0;
    if (clearedNow) {
      posted = true;
      console.log('   ✅ Submitted via Ctrl+Enter');
    }
  }

  if (!posted) {
    await page.screenshot({ path: '.sessions/mastodon-post-failed.png', fullPage: true }).catch(() => {});
    throw new Error('Mastodon: could not submit the post (button click and Ctrl+Enter both failed) — screenshot saved to .sessions/mastodon-post-failed.png');
  }

  // Step 3: Wait for the "Post published." toast, click "Open"
  await sleep(2000);
  console.log('   Looking for "Post published." toast...');
  let opened = false;
  const NOTIFICATION_SELECTORS = [
    { toast: '.notification-bar__content:has-text("Post published")', action: '.notification-bar__action' },
  ];
  for (const { toast, action } of NOTIFICATION_SELECTORS) {
    const toastEl = page.locator(toast).first();
    if (await toastEl.isVisible({ timeout: 5000 }).catch(() => false)) {
      const actionBtn = page.locator(action).first();
      if (await actionBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await actionBtn.click({ timeout: 4000 }).catch(() => {});
        opened = true;
        console.log('   ✅ "Open" clicked on the Post published toast');
      }
      break;
    }
  }
  if (!opened) {
    console.warn('   ⚠️ "Post published" toast/Open button not found — falling back to current page URL.');
  }

  await sleep(2500);
  const postUrl = page.url();
  console.log(`   ✅ Mastodon post URL: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
