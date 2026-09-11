import { Page } from 'playwright';
import { preparePlainSocialPost } from '../../utils/socialText.js';
import { pasteTextPlain } from '../stagehand.js';

const CRITICAL_TIMEOUT_MS = 30_000;

async function waitForCriticalLocator(
  page: Page,
  selector: string,
  description: string,
  timeout = CRITICAL_TIMEOUT_MS,
): Promise<{ success: boolean; locator: any; message: string }> {
  try {
    await page.waitForSelector(selector, { timeout });
    return { success: true, locator: page.locator(selector).first(), message: '' };
  } catch {
    const message = `${description} not found within ${timeout / 1000}s (selector: ${selector}).`;
    console.error(`   ❌ ${message}`);
    return { success: false, locator: null, message };
  }
}

// Last-resort fallback used in place of Stagehand (removed — its initFromPage()
// binding was silently broken, operating on an internal about:blank page instead
// of the real one, so every "fallback" attempt through it did nothing). Finds a
// button by exact visible text and dispatches a real DOM click on it directly —
// this fires the element's actual click handlers even in cases where Playwright's
// actionability checks (or an overlapping element) would otherwise block `.click()`.
async function nativeClickByText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((targetText) => {
    const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
    for (const el of candidates) {
      if ((el.textContent || '').trim() === targetText) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, text);
}

export async function postToLinkedIn(
  page: Page,
  postText: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  const cleanPostText = preparePlainSocialPost(postText);
  if (cleanPostText !== postText.trim()) {
    console.log('   Removed markdown bold markers before posting to LinkedIn');
  }

  console.log('   Navigating to LinkedIn feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForSelector('div.feed-shared-update-v2', { timeout: 20_000 });
    console.log('   ✅ Feed loaded');
  } catch {
    console.warn('   ⚠️  Feed load timeout, continuing...');
  }

  // ── Click "Start a post" ──────────────────────────────────────────────────
  console.log('   Looking for post composer button...');
  const startPostSelectors = [
    'a[href="/preload/sharebox/"]',
    'div[aria-label="Start a post"]',
    'p:has-text("Start a post")',
    'button.share-box-feed-entry__trigger',
    'button[aria-label*="Start a post"]',
    'button:has-text("Start a post")',
    'div[role="button"]:has-text("Start a post")',
  ];

  let buttonFound = false;
  for (const selector of startPostSelectors) {
    const btn = await page.$(selector);
    if (btn) {
      console.log(`   ✅ Found post button: ${selector}`);
      await btn.click();
      await page.waitForTimeout(5000);
      buttonFound = true;
      break;
    }
  }

  if (!buttonFound) {
    console.warn('   ⚠️  All selectors missed — trying native text-based click...');
    buttonFound = await nativeClickByText(page, 'Start a post');
    if (buttonFound) {
      await page.waitForTimeout(5000);
      console.log('   ✅ Composer opened via native click');
    }
  }

  if (!buttonFound) {
    throw new Error('LinkedIn "Start a post" button not found — could not open composer.');
  }

  // ── Wait for textbox composer ─────────────────────────────────────────────
  let composerReady = await page.waitForSelector('div[role="textbox"]', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);

  if (!composerReady) {
    console.warn('   ⚠️  Composer textbox not found — retrying "Start a post" once...');
    for (const selector of startPostSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        await btn.click();
        break;
      }
    }
    await page.waitForTimeout(4000);
    composerReady = await page.waitForSelector('div[role="textbox"]', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
  }

  if (!composerReady) {
    throw new Error('LinkedIn post composer textbox never appeared.');
  }
  console.log('   ✅ Composer ready');

  // Click BOTH the outer textbox container and the inner contenteditable
  // placeholder element before typing — the first paste attempt previously
  // relied on whatever had focus after opening the composer (often nothing),
  // so text silently went nowhere. div[role="textbox"] is the composer's
  // outer container; the <p data-placeholder="Share your thoughts ..."
  // class="is-empty is-editor-empty"> is the actual inner contenteditable
  // node LinkedIn currently renders — click the old locator first, then this
  // one, so focus reliably lands in the real editable region either way.
  async function focusComposer(): Promise<void> {
    await page.locator('div[role="textbox"]').first().click().catch(() => {});
    await page.locator('[data-placeholder="Share your thoughts …"], [data-placeholder="Share your thoughts ..."], p.is-editor-empty').first().click().catch(() => {});
  }

  // ── Type post content ─────────────────────────────────────────────────────
  console.log('   Pasting post content...');
  await focusComposer();
  await pasteTextPlain(page, cleanPostText);
  await page.waitForTimeout(1500);

  // ── Verify the text actually landed ───────────────────────────────────────
  // If the composer wasn't focused in time, insertText silently goes nowhere:
  // the box stays empty, LinkedIn's Post button becomes aria-disabled (not the
  // HTML disabled attribute, so Playwright's click() isn't blocked by it), and
  // our click "succeeds" while doing nothing — composer never closes. Catch
  // that here instead of discovering it only after the Post click fails.
  let typedText = await page.locator('div[role="textbox"]').first().innerText().catch(() => '');
  if (!typedText.trim()) {
    console.warn('   ⚠️  Composer is empty after typing — text did not land, focusing and retrying...');
    await focusComposer();
    await pasteTextPlain(page, cleanPostText);
    await page.waitForTimeout(1500);
    typedText = await page.locator('div[role="textbox"]').first().innerText().catch(() => '');
  }
  if (!typedText.trim()) {
    throw new Error('LinkedIn composer stayed empty after two paste attempts — cannot publish blank post.');
  }

  // ── Find Post button — scoped to the composer dialog only ─────────────────
  // Previously these selectors searched the WHOLE page, not just the composer.
  // LinkedIn's feed is full of other elements that can match: "Repost" buttons
  // on unrelated feed posts contain "post" as a case-insensitive substring, and
  // aria-label="Send" matches the persistent messaging chat widget's own Send
  // button. Both could get clicked instead of the real publish button, which
  // "succeeds" (no error) while doing nothing — exactly why the composer stayed
  // open. Scoping to the open dialog (role="dialog") eliminates that class of
  // mismatch; "Send" labels are dropped entirely since LinkedIn's feed composer
  // uses "Post", not "Send" (that's messaging/InMail terminology).
  console.log('   Searching for Post button...');
  // Matches both the ARIA-role composer LinkedIn normally renders and the
  // native <dialog> element it sometimes uses instead (a real failure showed
  // "<dialog data-testid=\"dialog\">" in its intercepted-click trace — that tag
  // doesn't match `div[role="dialog"]` at all, so the old selector silently
  // fell through to a whole-page search on exactly the runs that needed scoping most).
  const dialog = page.locator('div[role="dialog"], dialog[data-testid="dialog"], dialog').last();
  const dialogFound = await dialog.count() > 0;
  if (!dialogFound) {
    console.warn('   ⚠️  No dialog found — falling back to whole-page search');
  }

  const postButtonSelectors = [
    // Full class combo from a captured real Post button (id="emberNN" deliberately
    // excluded — Ember reassigns that id on every render, so hardcoding it would
    // break on the very next page load; the class list is what's actually stable).
    'button.share-actions__primary-action.artdeco-button--primary',
    'button.share-actions__primary-action',
    'button:has(span:has-text("Post"))',
    'button:has-text("Post")',
    'div[role="button"]:has-text("Post")',
  ];

  // A click "succeeding" (no exception) does NOT mean the post published —
  // LinkedIn can leave the button aria-disabled (not the HTML disabled
  // attribute, so Playwright's actionability checks don't block it) while
  // content is still validating, making the click a real but functionally
  // inert click. So every attempt below is verified by checking the composer
  // actually closed before moving on; if it's still open, we try the NEXT
  // locator instead of assuming success and stopping.
  const composerClosed = async (): Promise<boolean> =>
    !(await page.locator('div[role="textbox"]').first().isVisible().catch(() => false));

  // LinkedIn keeps the composer dialog open for several seconds after a
  // successful Post click while it uploads/validates (button hidden, dialog
  // still visible). A fixed 3s check was reporting "composer still open" on
  // clicks that had actually worked, which then cascaded into every fallback
  // locator, a native DOM click and Ctrl+Enter — noisy at best, a duplicate
  // post at worst. Poll instead, up to POST_CLOSE_TIMEOUT_MS, and return as
  // soon as the composer is really gone.
  const POST_CLOSE_TIMEOUT_MS = 20_000;
  const waitForComposerClose = async (): Promise<boolean> => {
    const deadline = Date.now() + POST_CLOSE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await composerClosed()) return true;
      await page.waitForTimeout(500);
    }
    return false;
  };

  let published = false;

  // Try dialog-scoped first (avoids matching unrelated "Repost"/feed buttons),
  // then fall back to the whole page — `.last()` can pick the wrong dialog if
  // some other one (a notification, cookie prompt, etc.) rendered afterward,
  // in which case the dialog-scoped search matches nothing at all.
  const scopesToTry = dialogFound ? [dialog, page] : [page];

  for (const scope of scopesToTry) {
    if (published) break;
    for (const sel of postButtonSelectors) {
      const loc = scope.locator(sel).first();
      if (await loc.count() === 0) continue;
      try {
        console.log(`   Clicking Post: ${sel}`);
        await loc.click({ timeout: 8000 });
      } catch (err: any) {
        // A real recorded failure timed out here with "... subtree intercepts
        // pointer events" — some overlapping element (toast, tooltip, a second
        // dialog) sat on top of a button that was otherwise visible/enabled/stable,
        // so Playwright's actionability check kept retrying for the full 8s and
        // never actually clicked. `force: true` skips that check and dispatches
        // the click at the element's coordinates regardless of what's on top.
        console.warn(`   ⚠️  "${sel}" matched but click failed (${err.message.split('\n')[0]}) — retrying with force...`);
        try {
          await loc.click({ timeout: 5000, force: true });
        } catch (forceErr: any) {
          console.warn(`   ⚠️  Force click also failed (${forceErr.message.split('\n')[0]}) — trying next locator`);
          continue;
        }
      }
      if (await waitForComposerClose()) {
        published = true;
        console.log(`   ✅ Post published via "${sel}"`);
        break;
      }
      console.warn(`   ⚠️  Clicked "${sel}" but composer still open — trying next locator`);
    }
  }

  if (!published) {
    // Text scan fallback — same dialog-then-whole-page order as above
    for (const scope of scopesToTry) {
      if (published) break;
      const allBtns = await scope.locator('button').all();
      for (const btn of allBtns) {
        const label = (await btn.innerText().catch(() => '')).trim();
        if (label !== 'Post') continue;
        try {
          await btn.click({ timeout: 8000 });
        } catch {
          continue;
        }
        if (await waitForComposerClose()) {
          published = true;
          console.log('   ✅ Post published via manual button text scan');
          break;
        }
        console.warn('   ⚠️  Manual-scan click did not close composer — trying next button');
      }
    }
  }

  if (!published) {
    // Native DOM click bypasses Playwright's actionability checks entirely —
    // catches cases where the button is genuinely there but something (an
    // overlay, aria-disabled styling, etc.) prevents a normal Playwright click.
    console.warn('   ⚠️  All locators exhausted — trying native DOM click on "Post"...');
    const clicked = await nativeClickByText(page, 'Post');
    if (clicked) {
      published = await waitForComposerClose();
      if (published) console.log('   ✅ Post published via native DOM click');
    }
  }

  if (!published) {
    // Keyboard-shortcut fallback: LinkedIn's composer supports Ctrl+Enter to
    // submit without needing to hit any button at all.
    console.warn('   ⚠️  Native click did not work — trying Ctrl+Enter keyboard shortcut...');
    await page.locator('div[role="textbox"]').first().click().catch(() => {});
    await page.keyboard.press('Control+Enter');
    published = await waitForComposerClose();
    if (published) console.log('   ✅ Post published via Ctrl+Enter');
  }

  if (!published) {
    throw new Error('LinkedIn post composer never closed after clicking Post — publish did not go through.');
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(2000);

  let postUrl = '';
  try {
    postUrl = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]')
      );
      const el = candidates[0];
      return el ? (el as HTMLAnchorElement).href : '';
    });
    if (postUrl) console.log(`   ✅ Post URL: ${postUrl}`);
    else console.warn('   ⚠️  Could not find post URL in feed DOM');
  } catch (err: any) {
    console.warn(`   ⚠️  Could not retrieve post URL: ${err.message}`);
  }

  return {
    success: true,
    postUrl,
    postText: cleanPostText,
    postedAt: new Date(),
  };
}
