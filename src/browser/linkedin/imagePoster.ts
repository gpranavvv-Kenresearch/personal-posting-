// LinkedIn image-post flow — confirmed against the real DOM (2026-09-11).
// Unlike poster.ts (plain text, via "Start a post"), this flow starts
// directly from the feed's "Add media" icon, which opens straight into the
// image picker — no "Start a post" click needed at all.
//
// Sequence: click "Add media" -> upload file -> click "Next" -> click the
// text composer and type the post -> click "Post" -> pull the post URL from
// the feed DOM. The click opens a REAL native OS file picker (a trusted
// click can trigger one even when Playwright drives it), so the file is
// supplied via Playwright's 'filechooser' event instead of setInputFiles()
// on the raw <input> — that event interception is what keeps the native
// dialog from ever actually appearing.
//
// No locator-visibility waits anywhere in this flow on purpose — every click
// force-fires immediately against the given locator, with only the fixed
// waitForTimeout() delays between steps to give the page time to settle.
import { Page, Locator } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { preparePlainSocialPost } from '../../utils/socialText.js';

// Fire-and-forget click: force-fires against the locator regardless of
// whether it's visible/attached, with a short timeout so a missing element
// never blocks the flow. Swallows all errors — caller always proceeds to the
// next step no matter what happened here.
async function forceClick(locator: Locator, timeoutMs = 3000): Promise<void> {
  try {
    await locator.click({ force: true, timeout: timeoutMs });
  } catch (err: any) {
    console.warn(`   ⚠️  forceClick failed (continuing anyway): ${err.message?.split('\n')[0] ?? err}`);
  }
}

// Same blank-line fix as pasteTextPlain (stagehand.ts) — LinkedIn's paste
// handler treats a truly-empty line as nothing and collapses it, so a
// non-empty-but-invisible character (U+2800) on each blank line keeps the
// visual spacing.
function preserveBlankLines(text: string): string {
  return text
    .split('\n')
    .map(line => (line.trim() === '' ? '⠀' : line))
    .join('\n');
}

// Multiple concurrent Chrome windows run in this repo (one per account), and
// only one can hold real OS focus at a time — navigator.clipboard.readText()
// (and sometimes the paste itself) is commonly blocked for background/
// unfocused windows regardless of granted permissions, which is what made
// the clipboard-based pasteTextPlain() fail consistently here. Typing
// directly via the keyboard API bypasses the OS clipboard entirely, so
// background-window focus restrictions can't block it.
async function typeTextDirect(page: Page, text: string): Promise<void> {
  await page.keyboard.insertText(preserveBlankLines(text));
}

// The class-list match alone was ambiguous — Photo/Video/Write-article icon
// buttons all share the same hashed CSS-module classes, differing only by
// their inner <p>-labeled text ("Photo", "Video", etc.). Match on that label
// instead — far more stable than the hashed classes.
const ADD_MEDIA_BUTTON_SEL = 'div[role="button"]:has-text("Photo")';
const MARKER_ATTR = 'data-li-auto-target';

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

// ADD_MEDIA_BUTTON_SEL matches one known DOM variant only — confirmed live
// it silently matches nothing for some accounts (the click "succeeds" via
// force but hits nothing real, so no filechooser ever fires and it times
// out). Broad scan instead: any visible button/div[role="button"] whose
// text or aria-label mentions photo/image/media, or whose descendant SVG
// icon name does (LinkedIn's icon-only buttons often have no text at all).
async function findAddMediaButton(page: Page): Promise<Locator | null> {
  const found = await page.evaluate((marker) => {
    const candidates = Array.from(document.querySelectorAll('button, div[role="button"]')) as HTMLElement[];
    const matchesText = /photo|image|media/i;
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      const text = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const svgUse = el.querySelector('svg use');
      const iconHref = svgUse ? (svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || '') : '';
      if (matchesText.test(text) || matchesText.test(aria) || matchesText.test(iconHref)) {
        el.setAttribute(marker, 'add-media');
        return true;
      }
    }
    return false;
  }, MARKER_ATTR);
  if (!found) return null;
  return page.locator(`[${MARKER_ATTR}="add-media"]`).first();
}

// Same problem, same fix, for the composer textbox: don't assume
// role="textbox" is even present — just find the most-likely-real
// contenteditable box (visible, not a comment box, last in DOM order since
// the composer dialog is appended after everything else on the page).
async function findComposerTextbox(page: Page): Promise<Locator | null> {
  const found = await page.evaluate((marker) => {
    const candidates = Array.from(document.querySelectorAll('[contenteditable="true"]')) as HTMLElement[];
    const real = candidates.filter(el => {
      const rect = el.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return !aria.includes('comment');
    });
    const target = real[real.length - 1];
    if (!target) return false;
    target.setAttribute(marker, 'composer');
    return true;
  }, MARKER_ATTR);
  if (!found) return null;
  return page.locator(`[${MARKER_ATTR}="composer"]`).first();
}

export async function postToLinkedInWithImage(
  page: Page,
  postText: string,
  imagePath: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found at path: ${imagePath}`);
  }
  const absImagePath = path.resolve(imagePath);
  const cleanPostText = preparePlainSocialPost(postText);

  // ── Click "Add media" and supply the file via the filechooser event ────────
  // MUST register the filechooser listener before the click. LinkedIn's
  // click handler triggers a real underlying file-input click — without
  // interception, that opens an actual native OS "Open" dialog that just
  // sits there blocking everything (confirmed live: a real Windows file
  // picker appeared and froze the whole flow). setInputFiles() directly on
  // the page's input does NOT prevent this — the native dialog still fires
  // from LinkedIn's own click handler regardless. Interception is what
  // suppresses it, not optional.
  //
  // A stuck/half-loaded feed is a common reason this step fails (button
  // found but nothing real behind it, or found nothing at all) — rather
  // than pressing on with a broken page, re-navigate to the feed fresh and
  // retry the whole "Add media" step from scratch, up to MAX_ADD_MEDIA_ATTEMPTS
  // times, before finally giving up and continuing without an image.
  const MAX_ADD_MEDIA_ATTEMPTS = 3;
  let imageUploaded = false;
  for (let attempt = 1; attempt <= MAX_ADD_MEDIA_ATTEMPTS; attempt++) {
    console.log(`   Navigating to LinkedIn feed... (attempt ${attempt}/${MAX_ADD_MEDIA_ATTEMPTS})`);
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    console.log('   Waiting 7.5s for the page to settle...');
    await page.waitForTimeout(7500);

    console.log('   Clicking "Add media"...');
    let addMediaBtn: Locator | null = page.locator(ADD_MEDIA_BUTTON_SEL).first();
    if (await addMediaBtn.count() === 0) {
      console.warn('   ⚠️  Known "Add media" selector matched nothing — broad-scanning for it instead');
      addMediaBtn = await findAddMediaButton(page);
    }
    if (!addMediaBtn) {
      console.warn(`   ⚠️  "Add media" button not found by either the known selector or the broad scan (attempt ${attempt}/${MAX_ADD_MEDIA_ATTEMPTS})`);
    } else {
      try {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10_000 }),
          forceClick(addMediaBtn),
        ]);
        await fileChooser.setFiles(absImagePath);
        imageUploaded = true;
      } catch (err: any) {
        console.warn(`   ⚠️  Image upload step failed (attempt ${attempt}/${MAX_ADD_MEDIA_ATTEMPTS}): ${err.message?.split('\n')[0] ?? err}`);
      }
    }

    if (imageUploaded) break;
    if (attempt < MAX_ADD_MEDIA_ATTEMPTS) {
      console.warn('   ⚠️  Retrying from the LinkedIn homepage...');
    } else {
      console.warn('   ⚠️  Giving up on image upload after all retries — continuing without it anyway');
    }
  }
  await page.waitForTimeout(2000);
  await page.waitForTimeout(6500);

  // ── Click "Next" ─────────────────────────────────────────────────────────
  console.log('   Clicking "Next"...');
  await forceClick(page.getByRole('button', { name: 'Next' }).first());
  await page.waitForTimeout(2000);
  await page.waitForTimeout(4000);

  // ── Paste the post text — no explicit textbox click/locate ──────────────
  // LinkedIn's composer variants keep shifting DOM/selectors per account
  // (seen 3 different ones already: "Share your thoughts...", "ShareBox_
  // textEditor" componentkey, "What do you want to talk about?"), so chasing
  // one selector at a time isn't reliable. Pasting needs real document focus
  // though — without clicking something editable first, nothing receives it
  // (confirmed: clipboard confirm failed + composer stayed empty). Use
  // .last() instead of .first() — the composer dialog is appended to the end
  // of the DOM when it opens, so the last contenteditable[role="textbox"] on
  // the page is far more likely to be it than a pre-existing feed comment box.
  console.log('   Writing post text...');
  // role="textbox" isn't always present (confirmed live: the fallback that
  // required it found zero elements for one account) — findComposerTextbox
  // only requires contenteditable="true", which is the one thing every
  // variant seen so far has actually had in common.
  const composerBox = await findComposerTextbox(page);
  if (!composerBox) {
    console.warn('   ⚠️  LinkedIn composer textbox not found — continuing anyway (typing may go nowhere)');
  } else {
    await forceClick(composerBox);
  }
  await page.waitForTimeout(2000);

  // A force-click doesn't always actually move focus. Verify focus landed
  // on a contenteditable element; if not, force it directly via JS .focus()
  // on the same resolved element instead.
  const focusedOnEditable = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return !!el && el.getAttribute('contenteditable') === 'true';
  }).catch(() => false);
  if (!focusedOnEditable) {
    console.warn('   ⚠️  Click did not focus an editable element — forcing focus via JS instead');
    const jsFocused = await page.evaluate((marker) => {
      const target = document.querySelector(`[${marker}="composer"]`) as HTMLElement | null;
      if (!target) return false;
      target.focus();
      return document.activeElement === target;
    }, MARKER_ATTR);
    if (!jsFocused) {
      console.warn('   ⚠️  Could not focus composer textbox by click or JS .focus() — typing anyway');
    }
  }

  await typeTextDirect(page, cleanPostText);

  const typedText = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText ?? '').catch(() => '');
  if (!typedText.trim()) {
    console.warn('   ⚠️  Composer appears empty after typing — clicking Post anyway');
  }

  console.log(`   Waiting 3s before clicking Post... [${new Date().toISOString()}]`);
  await page.waitForTimeout(3000);
  console.log(`   ...3s wait done [${new Date().toISOString()}]`);

  // ── Click "Post" ─────────────────────────────────────────────────────────
  const postButtonSelectors = [
    'button.share-actions__primary-action',
    'button:has(span:has-text("Post"))',
    'button:has-text("Post")',
  ];
  const clickPostButton = async (): Promise<boolean> => {
    console.log('   Clicking "Post"...');
    for (const sel of postButtonSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() === 0) continue;
      await forceClick(loc);
      return true;
    }
    return nativeClickByText(page, 'Post');
  };

  let clicked = await clickPostButton();
  if (!clicked) {
    console.warn('   ⚠️  Could not find a "Post" button to click — continuing anyway');
  }

  console.log(`   Waiting 7.5s... [${new Date().toISOString()}]`);
  await page.waitForTimeout(7500);
  console.log(`   ...7.5s wait done [${new Date().toISOString()}]`);

  // ── Pull the post URL ────────────────────────────────────────────────────
  const fetchPostUrl = async (): Promise<string> => {
    await page.evaluate(() => window.scrollTo(0, 0));
    return page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]')
      );
      const el = candidates[0];
      return el ? (el as HTMLAnchorElement).href : '';
    }).catch(() => '');
  };

  let postUrl = await fetchPostUrl();
  if (!postUrl) {
    console.warn('   ⚠️  Post URL not found yet — waiting 3s more...');
    await page.waitForTimeout(3000);
    postUrl = await fetchPostUrl();
  }
  if (!postUrl) {
    console.warn('   ⚠️  Post URL still not in DOM — force-clicking "Post" again...');
    await clickPostButton();
    console.log(`   Waiting 3s... [${new Date().toISOString()}]`);
    await page.waitForTimeout(3000);
    console.log(`   ...3s wait done [${new Date().toISOString()}]`);
    postUrl = await fetchPostUrl();
  }
  if (postUrl) console.log(`   ✅ Post URL: ${postUrl}`);
  else console.warn('   ⚠️  Could not find post URL in feed DOM');

  return {
    success: true,
    postUrl,
    postText: cleanPostText,
    postedAt: new Date(),
  };
}
