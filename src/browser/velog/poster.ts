import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Fixed manual delay between clicks — 1.5-2s, randomized so consecutive runs
// don't look robotically identical.
const clickDelay = () => sleep(1500 + Math.floor(Math.random() * 500));

// A coordinate-based mouse.click() can still miss — an invisible overlay,
// dropdown backdrop, or sticky duplicate header can sit on top of the exact
// pixel even when the target itself reports as visible. Instead, invoke the
// DOM's native .click() directly on the element: it goes straight through
// the browser's click handling (and React's delegated listeners) without
// any coordinate/occlusion/viewport check at all.
//
// A selector can also match more than one element (e.g. a duplicate sticky
// header rendered during scroll/resize transitions) — .first() isn't
// necessarily the one actually on screen, so pick the first VISIBLE match.
// isVisible() is a single point-in-time snapshot: at a small viewport height
// (confirmed live — 609px instead of the intended 900px) Velog briefly
// renders a duplicate header mid-transition, so a one-shot check can catch
// both copies as not-yet-visible. Poll for up to ~4s instead of failing on
// the first snapshot.
async function clickBySelector(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector);
  await locator.first().waitFor({ state: 'attached', timeout: 15000 });

  const deadline = Date.now() + 4000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const count = await locator.count();
    lastCount = count;
    for (let i = 0; i < count; i++) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.y < 0) continue; // off-screen (e.g. sticky header clone translated above the viewport)
      await candidate.evaluate((el: HTMLElement) => el.click());
      return;
    }
    await sleep(300);
  }

  throw new Error(`Found ${lastCount} match(es) for "${selector}" but none were visible on screen after 4s of polling`);
}

// Going straight from a minimized window to 'maximized' via CDP is unreliable
// — Chrome silently ignores it, leaving the window (and viewport) tiny, which
// makes every element look "outside the viewport" to Playwright even though
// the locator itself resolves fine. Passing through 'normal' first fixes it.
async function ensureWindowVisible(page: Page): Promise<void> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await sleep(300);
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  // Force a consistent large viewport unconditionally — confirmed live that
  // the CDP maximize above can still leave the window at a reduced height
  // (e.g. 1280x609), which is short enough to trigger Velog's sticky-header
  // duplication and break the write-button click. A small-size-only
  // fallback wasn't enough since 609 isn't "small" by that check's old
  // <400 threshold but is still short enough to break the header.
  try {
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});
    const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    if (size.w < 1280 || size.h < 900) {
      console.log(`   ⚠️ Viewport still ${size.w}x${size.h} after forcing — continuing anyway`);
    }
  } catch { /* ignore */ }
}

// Locators confirmed live against velog.io (2026-08-20). Flow:
//   1. Click "새 글 작성" (Write new post) in the header.
//   2. Fill the real title field — a <textarea placeholder="제목을 입력하세요">
//      ("Enter title"). The earlier "태그를 입력하세요" (tags) input was a
//      mislabel; this is the correct field.
//   3. Click the Quill "ql-code-block" toolbar button to switch the editor
//      into a raw code block (so the HTML content isn't mangled by rich-text
//      auto-formatting).
//   4. Click into the CodeMirror line, Ctrl+A to select any placeholder
//      text, then insert the HTML content as-is.
//   5. Click "출간하기" to open the publish modal.
//   6. Wait ~3s for the modal, then click the modal's own "출간하기"
//      confirm button (data-testid="publish").
//   7. Read the published post URL from the address bar.
export async function postToVelog(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Velog);

  await ensureWindowVisible(page);
  await sleep(2000);

  // Step 0: A "홈으로" (Go Home) button appears ~3-4s after the browser
  // opens on velog.io — click it before anything else, or the rest of the
  // flow below is operating on the wrong page state.
  console.log('   Waiting for "홈으로" (go home) button...');
  await sleep(3500);
  try {
    await clickBySelector(page, 'button:has-text("홈으로")');
    console.log('   Clicked "홈으로"');
    await clickDelay();
  } catch {
    console.log('   ⚠️ "홈으로" button did not appear — continuing anyway');
  }

  // Step 1: Click "새 글 작성" in the header to open a new post.
  console.log('   Clicking "새 글 작성" (write new post)...');
  await clickBySelector(page, 'button:has-text("새 글 작성")');
  await clickDelay();

  // Step 2: Fill the post title field.
  // A click() doesn't reliably move keyboard focus onto a <textarea> here —
  // what we actually need is focus, so set it directly via JS instead of
  // clicking, then type at the page level into whatever is now focused.
  console.log('   Filling title field...');
  const titleField = page.locator('textarea[placeholder="제목을 입력하세요"]').first();
  await titleField.waitFor({ state: 'attached', timeout: 15000 });
  await titleField.evaluate((el: HTMLTextAreaElement) => el.focus());
  await clickDelay();
  await page.keyboard.type(title, { delay: 40 });
  await clickDelay();

  // Step 3: Switch the editor into a raw code block before pasting HTML.
  console.log('   Switching editor to code-block mode...');
  await clickBySelector(page, 'button.ql-code-block');
  await clickDelay();

  // Step 4: Click into the code editor, select-all, and insert the HTML content.
  console.log('   Pasting content...');
  await clickBySelector(page, '.CodeMirror-line, .CodeMirror-placeholder');
  await clickDelay();
  await page.keyboard.press('Control+A');
  await clickDelay();
  await page.keyboard.insertText(htmlContent);
  await clickDelay();

  // Step 5: Open the publish modal.
  console.log('   Opening publish modal...');
  await clickBySelector(page, 'button:has-text("출간하기")');
  await sleep(6000 + Math.floor(Math.random() * 2000));

  // Step 5b: Fill the modal's tag input and short-description textarea.
  // NOTE: the tag input's selector (below) is a styled-components generated
  // class ("sc-fXeWAj fZtKxW") — those hashes regenerate on Velog's own
  // rebuilds/deploys and are NOT stable long-term, unlike the other
  // data-testid/placeholder-based selectors in this file. Re-verify this
  // selector first if this step starts failing after a Velog UI change.
  console.log('   Filling tag input...');
  const acronym = title
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const tagInput = page.locator('input.sc-fXeWAj.fZtKxW').first();
  await tagInput.waitFor({ state: 'visible', timeout: 10000 });
  await tagInput.click();
  await clickDelay();
  await page.keyboard.type(acronym, { delay: 40 });
  await clickDelay();

  console.log('   Filling short-description field...');
  const summaryField = page.locator('textarea[placeholder="당신의 포스트를 짧게 소개해보세요."]').first();
  await summaryField.waitFor({ state: 'visible', timeout: 10000 });
  await summaryField.click();
  await clickDelay();
  await page.keyboard.press('Control+A');
  await clickDelay();
  await page.keyboard.type(title, { delay: 40 });
  await clickDelay();

  // Step 6: Confirm publish inside the modal. A single click sometimes
  // doesn't register at all (modal still mid-animation, or the click lands
  // before the button is truly interactive) — checking the URL right after
  // is too fast to tell a real submit (button disappears, modal closes,
  // navigation still in flight) from a no-op click (button still sitting
  // there). Check whether the publish button itself is still present/visible
  // instead: gone = the click registered and it's now navigating (let Step 7
  // wait that out); still there after a real wait = the click never actually
  // registered, so re-click. Re-click up to 3 times total; give up after.
  console.log('   Confirming publish...');
  const publishBtn = page.locator('button[data-testid="publish"]').first();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await clickBySelector(page, 'button[data-testid="publish"]');
    await sleep(4000);
    const stillPresent = await publishBtn.isVisible().catch(() => false);
    if (!stillPresent) {
      console.log(`   ✅ Publish click registered (attempt ${attempt}/3) — button gone, navigating...`);
      break;
    }
    console.log(`   ⚠️  Publish button still visible after click (attempt ${attempt}/3)${attempt < 3 ? ' — retrying...' : ''}`);
    if (attempt === 3) {
      throw new Error(`Publish button click did not register after 3 attempts — button still visible at ${page.url()}`);
    }
  }

  // Step 7: Wait for the page to actually land on the published post's
  // permalink (https://velog.io/@<handle>/<slug>) instead of trusting
  // whatever URL happens to be current right after the click — an
  // intermediate redirect (e.g. briefly through /login) can still be
  // mid-flight at that instant, which is why a fixed sleep once captured
  // the wrong URL.
  console.log('   Waiting for published post URL...');
  const isPermalink = (u: string) => /^https:\/\/velog\.io\/@[^/]+\/.+/.test(u);
  let postUrl = page.url();
  for (let i = 0; i < 20 && !isPermalink(postUrl); i++) {
    await sleep(500);
    postUrl = page.url();
  }
  if (!isPermalink(postUrl)) {
    throw new Error(`Publish did not land on a post permalink — got: ${postUrl}`);
  }

  console.log(`   ✅ Published: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
