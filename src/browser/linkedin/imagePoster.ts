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

// Playwright's locator.click({force:true}) still WAITS for the element to
// be attached/stable before dispatching the click — if it's genuinely not
// there yet (composer still animating in, hoverable-trigger wrapper not
// settled), it just times out having clicked nothing, same as a normal
// click. hardClick skips all of that: poll raw querySelector in the page
// and call .click() the instant it exists in the DOM, no waiting for
// Playwright's own visibility/stability/actionability checks at all.
// Confirmed live 2026-09-23 via debug dump: on some accounts the entire
// post composer (name header, placeholder, toolbar icons) never appears
// anywhere in page.content()'s HTML at all, yet the screenshot clearly
// shows it rendered — the signature of a shadow-DOM-based Web Component
// (LinkedIn evidently rolling out a newer composer UI to some accounts).
// Plain `document.querySelector` cannot see inside a shadow root; this
// walks into every open shadow root under `root` so it can. The walk
// function is duplicated inline inside every page.evaluate() callback below
// (rather than shared) because each one runs in an isolated browser context
// with no access to outer closures.
async function hardClick(page: Page, selector: string, maxWaitMs = 10_000, pollMs = 300): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((sel) => {
      // No named function/const-arrow declarations here on purpose — this
      // whole callback is serialized and re-run inside the browser by
      // Playwright, and esbuild's --keep-names wraps any named function
      // binding with a call to a `__name()` helper that only exists in the
      // Node build, not in the browser, throwing ReferenceError there
      // (confirmed live 2026-09-23). Plain loops/arrays only.
      const out: Element[] = [];
      const stack: (Document | Element | ShadowRoot)[] = [document];
      while (stack.length) {
        const r = stack.pop()!;
        r.querySelectorAll(sel).forEach((el) => out.push(el));
        r.querySelectorAll('*').forEach((el) => {
          if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
        });
      }
      const el = out[0] as HTMLElement | undefined;
      if (!el) return false;
      el.click();
      return true;
    }, selector).catch(() => false);
    if (clicked) return true;
    await page.waitForTimeout(pollMs);
  }
  console.warn(`   ⚠️  hardClick: "${selector}" never appeared in the DOM within ${maxWaitMs}ms`);
  return false;
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
// instead — far more stable than the hashed classes. This is the image-only
// path; LinkedIn treats "Photo" (JPEG/PNG/GIF/WEBP) and "Document"
// (PDF/DOC/DOCX/PPT/PPTX/ODT/ODS/PPSX) as two SEPARATE upload widgets —
// clicking "Photo" and handing it a PDF fails with "File(s) not supported"
// (confirmed live 2026-09-22) — see postToLinkedInWithDocument() below for
// the document path.
const ADD_MEDIA_BUTTON_SEL = 'div[role="button"]:has-text("Photo")';
function addMediaButtonSelector(isDocument: boolean): string {
  return isDocument
    ? 'div[role="button"]:has-text("Document")'
    : 'div[role="button"]:has-text("Photo")';
}
const MARKER_ATTR = 'data-li-auto-target';

async function nativeClickByText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((targetText) => {
    // No named function/const-arrow bindings — see hardClick's comment above.
    // 'span' added alongside the original 'button, div[role="button"]' —
    // confirmed live 2026-09-23: the older Ember.js composer variant's
    // "Choose file" is a plain <span class="artdeco-button ...">, not a
    // button/div[role="button"] at all.
    const candidates: Element[] = [];
    const stack: (Document | Element | ShadowRoot)[] = [document];
    while (stack.length) {
      const r = stack.pop()!;
      r.querySelectorAll('button, div[role="button"], span').forEach((el) => candidates.push(el));
      r.querySelectorAll('*').forEach((el) => {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      });
    }
    // Confirmed live 2026-09-23: a hidden decoy with the exact same text
    // (e.g. an unopened video's <button class="vjs-done-button">Done
    // </button> caption-settings control elsewhere on the page) was the
    // ONLY match found across every click attempt — meaning the real,
    // visible element was never the one actually clicked. Skip anything
    // with a zero-size bounding rect (hidden/not rendered) before matching.
    for (const el of candidates) {
      if ((el.textContent || '').trim() === targetText) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, text);
}

// Same raw-DOM-click fix as nativeClickByText, scoped to <a> tags — the
// title-step "Done" is an <a>, not a button, and Playwright's
// locator.click({force:true}) demonstrably left it untouched live
// (confirmed via debug dump: the anchor was still in the DOM, unchanged,
// after the "successful" force click) because force:true clicks at the
// element's current bounding-box coordinates without scrolling it into
// view first. A real element.click() call skips coordinates entirely.
async function nativeClickLinkByText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((targetText) => {
    const links: HTMLAnchorElement[] = [];
    const stack: (Document | Element | ShadowRoot)[] = [document];
    while (stack.length) {
      const r = stack.pop()!;
      r.querySelectorAll('a').forEach((el) => links.push(el as HTMLAnchorElement));
      r.querySelectorAll('*').forEach((el) => {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      });
    }
    for (const el of links) {
      if ((el.textContent || '').trim() === targetText) {
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        el.click();
        return true;
      }
    }
    return false;
  }, text);
}

// Click the "Send" action on the newest post's reaction bar (scoped to that
// post card so it can't hit an unrelated "Send" elsewhere on the page —
// e.g. a messaging button). Three ways to find it, tried in order: the send
// icon's id (locale-proof), the aria-label="Send" attribute directly
// (confirmed live 2026-09-23: the real <a> has an EMPTY <span> — "Send"
// only exists in aria-label, not as visible text, so a text-only fallback
// alone misses it), and lastly the visible "Send" text label for any
// variant that does render it. Returns a reason string when nothing was
// clicked, so callers can log/dump exactly which stage failed instead of a
// bare boolean.
async function clickSendOnNewestPost(page: Page): Promise<{ clicked: boolean; reason: string }> {
  return page.evaluate(() => {
    const cardCandidates: Element[] = [];
    const cardStack: (Document | Element | ShadowRoot)[] = [document];
    while (cardStack.length) {
      const r = cardStack.pop()!;
      r.querySelectorAll('[data-urn^="urn:li:activity:"]').forEach((el) => cardCandidates.push(el));
      r.querySelectorAll('*').forEach((el) => {
        if ((el as HTMLElement).shadowRoot) cardStack.push((el as HTMLElement).shadowRoot!);
      });
    }
    const card = cardCandidates[0];
    if (!card) return { clicked: false, reason: 'no [data-urn^="urn:li:activity:"] card found on page' };

    const withinCard: Element[] = [];
    const withinStack: (Element | ShadowRoot)[] = [card];
    while (withinStack.length) {
      const r = withinStack.pop()!;
      r.querySelectorAll('#send-privately-small, [aria-label="Send"], span').forEach((el) => withinCard.push(el));
      r.querySelectorAll('*').forEach((el) => {
        if ((el as HTMLElement).shadowRoot) withinStack.push((el as HTMLElement).shadowRoot!);
      });
    }
    const iconEl = withinCard.find((el) => el.id === 'send-privately-small');
    let target = iconEl?.closest('a, button') as HTMLElement | null;
    if (!target) {
      target = withinCard.find((el) => el.getAttribute('aria-label') === 'Send') as HTMLElement | undefined ?? null;
    }
    if (!target) {
      for (const span of withinCard) {
        if (span.tagName === 'SPAN' && (span.textContent || '').trim() === 'Send') {
          target = span.closest('a, button') as HTMLElement | null;
          break;
        }
      }
    }
    if (!target) return { clicked: false, reason: 'card found, but no send-icon / aria-label="Send" / text="Send" element within it' };
    target.click();
    return { clicked: true, reason: '' };
  });
}

// Click an element anywhere on the page by its exact visible text — used
// for "Copy link to post" in the Send popup, which LinkedIn renders into a
// portal appended to <body>, outside the post card's own DOM subtree.
async function clickByExactText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((targetText) => {
    const spans: Element[] = [];
    const stack: (Document | Element | ShadowRoot)[] = [document];
    while (stack.length) {
      const r = stack.pop()!;
      r.querySelectorAll('span').forEach((el) => spans.push(el));
      r.querySelectorAll('*').forEach((el) => {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      });
    }
    for (const span of spans) {
      if ((span.textContent || '').trim() === targetText) {
        const rect = span.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        const clickable = (span.closest('button, a, div[role="button"], li[role="menuitem"], div[role="menuitem"]') as HTMLElement) || (span as HTMLElement);
        clickable.click();
        return true;
      }
    }
    return false;
  }, text);
}

// Most reliable way to get the real post URL: use LinkedIn's own "Send" ->
// "Copy link to post" action (confirmed live 2026-09-23 via DOM dump) and
// read the URL it puts on the clipboard, instead of guessing which
// data-urn-bearing card in the DOM is actually the new post. Selectors
// here are exactly what was captured from the real DOM, but LinkedIn is
// known to A/B-test this UI (confirmed multiple times already in this same
// flow for "More"/"Document"/"Done"), so this can legitimately fail — the
// data-urn DOM scan remains as a fallback wherever this is called.
async function fetchPostUrlViaCopyLink(page: Page): Promise<string> {
  const sendResult = await clickSendOnNewestPost(page).catch((err) => ({ clicked: false, reason: `threw: ${err?.message ?? err}` }));
  console.log(`   ...Copy-link step: "Send" click ${sendResult.clicked ? 'succeeded' : `FAILED (${sendResult.reason})`}`);
  if (!sendResult.clicked) return '';
  await page.waitForTimeout(1000);
  const copyClicked = await clickByExactText(page, 'Copy link to post').catch(() => false);
  console.log(`   ...Copy-link step: "Copy link to post" click ${copyClicked ? 'succeeded' : 'FAILED'}`);
  if (!copyClicked) return '';
  await page.waitForTimeout(500);
  await page.bringToFront().catch(() => {});
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.linkedin.com' }).catch(() => {});
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText()).catch((err) => `__ERROR__:${err?.message ?? err}`);
  console.log(`   ...Copy-link step: clipboard read result: ${JSON.stringify(clipboardText).slice(0, 200)}`);
  return clipboardText && clipboardText.includes('linkedin.com') ? clipboardText.trim() : '';
}

// ADD_MEDIA_BUTTON_SEL matches one known DOM variant only — confirmed live
// it silently matches nothing for some accounts (the click "succeeds" via
// force but hits nothing real, so no filechooser ever fires and it times
// out). Broad scan instead: any visible button/div[role="button"] whose
// text or aria-label mentions photo/image/media, or whose descendant SVG
// icon name does (LinkedIn's icon-only buttons often have no text at all).
async function findAddMediaButton(page: Page): Promise<Locator | null> {
  const found = await page.evaluate((marker) => {
    const candidates: HTMLElement[] = [];
    const stack: (Document | Element | ShadowRoot)[] = [document];
    while (stack.length) {
      const r = stack.pop()!;
      r.querySelectorAll('button, div[role="button"]').forEach((el) => candidates.push(el as HTMLElement));
      r.querySelectorAll('*').forEach((el) => {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      });
    }
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
    const candidates: HTMLElement[] = [];
    const stack: (Document | Element | ShadowRoot)[] = [document];
    while (stack.length) {
      const r = stack.pop()!;
      r.querySelectorAll('[contenteditable="true"]').forEach((el) => candidates.push(el as HTMLElement));
      r.querySelectorAll('*').forEach((el) => {
        if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
      });
    }
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

// ── Document (PDF/PPT/DOC) post flow ────────────────────────────────────────
// LinkedIn treats "Photo" and "Document" as two separate upload widgets —
// the Photo one rejects a PDF outright ("File(s) not supported"), confirmed
// live 2026-09-22. This flow (selectors supplied directly by the user,
// read from the real DOM) is specifically the Document path: "More" (+)
// button -> "Add a document" -> "Choose file" (filechooser-intercepted,
// same pattern as the image flow) -> wait for the title-step "Done" button
// to appear (LinkedIn is converting the PDF into its page-by-page document
// viewer in the background) -> fill the document title -> click "Done" ->
// the normal post-text composer appears -> type the caption -> Post.
// Confirmed live 2026-09-22 via HTML dump: this account's composer labels
// the expand-icon "Expand content types", not "More" (LinkedIn evidently
// A/B-tests the label — the DOM the "More" selector was originally copied
// from was a different variant).
// Confirmed live 2026-09-23 via HTML dump on a different account: an
// older, Ember.js-based composer variant (not the React one above) labels
// it plain "More" instead, as <button aria-label="More"
// class="share-promoted-detour-button">. Kept alongside the original
// selector (comma-separated) rather than replacing it, since both variants
// are real and in use across different accounts.
const MORE_BUTTON_SEL = 'button[aria-label="Expand content types"], button[aria-label="More"]';
// Confirmed live 2026-09-22 via HTML dump: real label is just "Document",
// AND it's rendered as an <a href="https://www.linkedin.com/sharing/compose">,
// not a <button> like the other attachment icons.
// Confirmed live 2026-09-23 via HTML dump on the same older Ember.js
// composer variant as MORE_BUTTON_SEL above: labeled "Add a document" and
// IS a real <button class="share-promoted-detour-button">. Kept alongside
// the original selector rather than replacing it.
const ADD_DOCUMENT_BUTTON_SEL = 'a[aria-label="Document"], button[aria-label="Add a document"]';
// Confirmed live 2026-09-23 via HTML dump: the real title-step "Done" is
// also an <a href="https://www.linkedin.com/sharing/compose">Done</a>, no
// aria-label — `button[aria-label="Done"]` matched zero elements, which is
// why isVisible() silently returned false forever instead of erroring.
// There's also a decoy <button class="vjs-done-button">Done</button> from
// an unrelated hidden video-captions widget elsewhere on the page, so this
// must be scoped to the link role, not just the text "Done".
// Confirmed live 2026-09-23 via HTML dump: this input has no stable class
// (pure hashed atomic-CSS, e.g. "_9bbd213d b23f59f2 ...") and a React-random
// id ("«r2m»") — both worthless as selectors. Its placeholder text is the
// only stable attribute.
const DOCUMENT_TITLE_INPUT_SEL = 'input[placeholder="Add a descriptive title to your document"]';

export async function postToLinkedInWithDocument(
  page: Page,
  postText: string,
  docPath: string,
  docTitle: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  if (!fs.existsSync(docPath)) {
    throw new Error(`Document not found at path: ${docPath}`);
  }
  const absDocPath = path.resolve(docPath);
  const cleanPostText = preparePlainSocialPost(postText);

  // Confirmed live 2026-09-23: navigating directly to
  // linkedin.com/sharing/compose (skipping "Start a post") loads a
  // completely blank white page — that URL only works as a popup/modal
  // triggered from within the feed, not as a standalone page via full
  // navigation. Reverted to feed + "Start a post" click.
  console.log('   Navigating to LinkedIn feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  console.log('   Waiting 7.5s for the page to settle...');
  await page.waitForTimeout(7500);

  const debugDir = path.resolve('logs', 'li-document-debug');
  fs.mkdirSync(debugDir, { recursive: true });
  const debugStamp = new Date().toISOString().replace(/[:.]/g, '-');
  await page.screenshot({ path: path.join(debugDir, `${debugStamp}-before-start-post.png`), fullPage: false }).catch(() => {});
  const bodyHtml = await page.content().catch(() => '');
  fs.writeFileSync(path.join(debugDir, `${debugStamp}-before-start-post.html`), bodyHtml, 'utf8');
  console.log(`   📸 Debug snapshot saved: ${debugDir}\\${debugStamp}-before-start-post.*`);

  console.log('   Clicking "Start a post" to open the composer...');
  const startPostClicked = await hardClick(page, 'div[aria-label="Start a post"]');
  await page.waitForTimeout(3000);

  await page.screenshot({ path: path.join(debugDir, `${debugStamp}-after-start-post.png`), fullPage: false }).catch(() => {});
  const afterStartPostHtml = await page.content().catch(() => '');
  fs.writeFileSync(path.join(debugDir, `${debugStamp}-after-start-post.html`), afterStartPostHtml, 'utf8');
  console.log(`   📸 Debug snapshot saved: ${debugDir}\\${debugStamp}-after-start-post.* (Start a post click ${startPostClicked ? 'succeeded' : 'FAILED'})`);

  console.log('   Clicking "More" to expand attachment options...');
  const moreClicked = await hardClick(page, MORE_BUTTON_SEL);
  await page.waitForTimeout(1500);

  const afterMoreHtml = await page.content().catch(() => '');
  fs.writeFileSync(path.join(debugDir, `${debugStamp}-after-more.html`), afterMoreHtml, 'utf8');
  console.log(`   📸 Debug HTML saved: ${debugDir}\\${debugStamp}-after-more.html (More click ${moreClicked ? 'succeeded' : 'FAILED'})`);

  console.log('   Clicking "Document"...');
  const docClicked = await hardClick(page, ADD_DOCUMENT_BUTTON_SEL);
  await page.waitForTimeout(1500);

  const afterDocHtml = await page.content().catch(() => '');
  fs.writeFileSync(path.join(debugDir, `${debugStamp}-after-document.html`), afterDocHtml, 'utf8');
  console.log(`   📸 Debug HTML saved: ${debugDir}\\${debugStamp}-after-document.html (Document click ${docClicked ? 'succeeded' : 'FAILED'})`);

  // Confirmed live 2026-09-22 via HTML dump: this button has no stable
  // class or aria-label (pure hashed atomic-CSS), only its "Choose file"
  // text — match on that instead of the CSS-class guess (CHOOSE_FILE_SEL)
  // that never matched anything real.
  console.log('   Clicking "Choose file" and supplying the PDF via the filechooser event...');
  const clickChooseFile = async (): Promise<boolean> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await nativeClickByText(page, 'Choose file')) return true;
      await page.waitForTimeout(300);
    }
    return false;
  };
  let fileChooser;
  try {
    [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15_000 }),
      clickChooseFile(),
    ]);
  } catch (err) {
    // Dump evidence instead of a bare timeout — either "Choose file" text
    // never matched anything real for this account's upload-widget variant,
    // or the "Document" click before it silently failed to open the widget
    // at all (so there was nothing to click). Same pattern as every other
    // failure point in this flow.
    await page.screenshot({ path: path.join(debugDir, `${debugStamp}-choose-file-timeout.png`), fullPage: false }).catch(() => {});
    const chooseFileTimeoutHtml = await page.content().catch(() => '');
    fs.writeFileSync(path.join(debugDir, `${debugStamp}-choose-file-timeout.html`), chooseFileTimeoutHtml, 'utf8');
    console.warn(`   ⚠️  "Choose file" filechooser never fired — dumped ${debugDir}\\${debugStamp}-choose-file-timeout.*`);
    throw err;
  }
  await fileChooser.setFiles(absDocPath);

  // LinkedIn converts the PDF into its document viewer in the background —
  // the TITLE INPUT (not the "Done" button) is what only appears once that
  // finishes. Filling the title is what then makes "Done" clickable — so
  // poll for the title field, not Done, as the processing-complete signal.
  // A multi-page/multi-MB PDF (this pipeline's 6-slide carousels are
  // ~10-13MB) genuinely takes longer than 20s to process — confirmed live
  // 2026-09-22 (still not visible at 20s). Poll much further, up to a
  // 2-minute ceiling, before giving up.
  console.log('   Waiting for document processing to finish (polling for the title input field, up to 2 min)...');
  const pollCheckpointsSec = [8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 90, 105, 120];
  const titleInput = page.locator(DOCUMENT_TITLE_INPUT_SEL).first();
  let titleVisible = false;
  let elapsedSec = 0;
  for (const checkpointSec of pollCheckpointsSec) {
    await page.waitForTimeout((checkpointSec - elapsedSec) * 1000);
    elapsedSec = checkpointSec;
    titleVisible = await titleInput.isVisible().catch(() => false);
    console.log(`   ...checked at ${checkpointSec}s: ${titleVisible ? 'visible' : 'not yet'}`);
    if (titleVisible) break;
  }
  if (!titleVisible) {
    // Dump evidence instead of guessing why — could be a wrong selector
    // (same class of bug as "More"/"Add a document" earlier) or genuinely
    // still processing past 2 minutes.
    await page.screenshot({ path: path.join(debugDir, `${debugStamp}-title-timeout.png`), fullPage: false }).catch(() => {});
    const timeoutHtml = await page.content().catch(() => '');
    fs.writeFileSync(path.join(debugDir, `${debugStamp}-title-timeout.html`), timeoutHtml, 'utf8');
    console.warn(`   ⚠️  Title input never became visible after 2 min — dumped ${debugDir}\\${debugStamp}-title-timeout.*`);
    throw new Error('LinkedIn document processing did not finish (or the title-input selector is wrong) within 2 minutes — see debug dump');
  }

  // LinkedIn's title field has a hard 58-character limit (confirmed live —
  // the helper text under it reads "N of 58 characters") — always trim to
  // it regardless of how long docTitle actually is, rather than relying on
  // whatever generated it to already fit.
  const trimmedDocTitle = docTitle.slice(0, 58);
  console.log(`   Filling document title (trimmed to 58 chars: "${trimmedDocTitle}")...`);
  await forceClick(titleInput);
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await page.keyboard.insertText(trimmedDocTitle);
  await page.waitForTimeout(1000);

  // Flat 30s wait before touching "Done" at all — give LinkedIn's title
  // step plenty of time to finish rendering/enabling before we hard-click,
  // instead of racing a visibility poll.
  console.log('   Waiting 30s before clicking "Done"...');
  await page.waitForTimeout(30_000);

  // Confirmed live 2026-09-23 via debug dump: forceClick's locator.click
  // ({force:true}) left the "Done" anchor completely untouched in the DOM
  // (same componentkey, same aria-disabled="false", still there) even
  // though it reported success — force:true clicks at the element's
  // current bounding-box coordinates without scrolling it into view, which
  // apparently missed here. Don't advance on a click that merely didn't
  // throw — retry a REAL element.click() until the title input (the thing
  // "Done" is supposed to dismiss) actually disappears, confirming it took.
  console.log('   Clicking "Done" and confirming the title step actually closes...');
  const doneRetryCheckpointsSec = [2, 3, 4, 5, 6];
  let doneConfirmed = false;
  for (let attempt = 1; attempt <= 4 && !doneConfirmed; attempt++) {
    console.log(`   ...Done click attempt ${attempt}`);
    // Confirmed live 2026-09-23 on the Ember.js composer variant: "Done"
    // there is a real <button aria-label="Done" class="share-box-footer__
    // primary-btn ...">Done</button>, not the <a>-based one the click
    // above targets. Try both — nativeClickByText already matches
    // button/div/span by exact text, so it covers this variant alongside
    // the <a> click without removing it.
    await nativeClickLinkByText(page, 'Done');
    await nativeClickByText(page, 'Done');
    let elapsedSec = 0;
    for (const checkpointSec of doneRetryCheckpointsSec) {
      await page.waitForTimeout((checkpointSec - elapsedSec) * 1000);
      elapsedSec = checkpointSec;
      const titleStillThere = await titleInput.isVisible().catch(() => false);
      if (!titleStillThere) { doneConfirmed = true; break; }
    }
    console.log(`   ...attempt ${attempt}: title step ${doneConfirmed ? 'closed (confirmed)' : 'still open'}`);
  }
  if (!doneConfirmed) {
    await page.screenshot({ path: path.join(debugDir, `${debugStamp}-done-not-confirmed.png`), fullPage: false }).catch(() => {});
    const doneNotConfirmedHtml = await page.content().catch(() => '');
    fs.writeFileSync(path.join(debugDir, `${debugStamp}-done-not-confirmed.html`), doneNotConfirmedHtml, 'utf8');
    console.warn(`   ⚠️  "Done" click never actually closed the title step after 4 attempts — dumped ${debugDir}\\${debugStamp}-done-not-confirmed.*`);
    throw new Error('LinkedIn "Done" click did not take effect (title step never closed) — see debug dump');
  }

  // The normal post-text composer replaces the document-title step, but
  // that swap isn't instant — a flat 3s wait wasn't enough live (composer
  // textbox came back null, typing went nowhere). Poll for it the same way
  // as the title input / Done button above instead of guessing a delay.
  console.log('   Waiting for the post-text composer to appear...');
  const composerCheckpointsSec = [3, 5, 8, 10, 15, 20];
  let composerBox: Locator | null = null;
  let composerElapsedSec = 0;
  for (const checkpointSec of composerCheckpointsSec) {
    await page.waitForTimeout((checkpointSec - composerElapsedSec) * 1000);
    composerElapsedSec = checkpointSec;
    composerBox = await findComposerTextbox(page);
    console.log(`   ...checked composer at ${checkpointSec}s: ${composerBox ? 'visible' : 'not yet'} (URL: ${page.url()})`);
    if (composerBox) break;
  }

  console.log('   Writing post text...');
  if (!composerBox) {
    console.warn('   ⚠️  LinkedIn composer textbox not found — dumping debug evidence before continuing');
    await page.screenshot({ path: path.join(debugDir, `${debugStamp}-composer-timeout.png`), fullPage: false }).catch(() => {});
    const composerTimeoutHtml = await page.content().catch(() => '');
    fs.writeFileSync(path.join(debugDir, `${debugStamp}-composer-timeout.html`), composerTimeoutHtml, 'utf8');
    console.warn(`   ⚠️  Dumped ${debugDir}\\${debugStamp}-composer-timeout.*`);
  } else {
    await forceClick(composerBox);
  }
  await page.waitForTimeout(2000);

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

  console.log('   Waiting 3s before clicking Post...');
  await page.waitForTimeout(3000);

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
      try {
        await loc.click({ force: true, timeout: 3000 });
        return true;
      } catch (err: any) {
        // "Element is not visible" seen live 2026-09-22 even with
        // force:true -- Playwright's force click still requires the element
        // to be attached and stable, which this button sometimes isn't
        // (still animating in). Fall back to a raw JS .click() next, which
        // has no such requirement.
        console.warn(`   ⚠️  Playwright click on "${sel}" failed (${err.message?.split('\n')[0] ?? err}) -- trying raw JS click...`);
        const jsClicked = await page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLElement | null;
          if (!el) return false;
          el.click();
          return true;
        }, sel).catch(() => false);
        if (jsClicked) return true;
      }
    }
    // "Document" and "Done" earlier in this same flow both turned out to be
    // <a> tags, not <button> — nativeClickByText only checks
    // button/div[role="button"], so try the <a>-aware variant too before
    // giving up, on the chance "Post" follows the same pattern.
    if (await nativeClickByText(page, 'Post')) return true;
    return nativeClickLinkByText(page, 'Post');
  };

  let clicked = await clickPostButton();
  if (!clicked) {
    console.warn('   ⚠️  Could not find a "Post" button to click — dumping debug evidence');
    await page.screenshot({ path: path.join(debugDir, `${debugStamp}-post-button-not-found.png`), fullPage: false }).catch(() => {});
    const postButtonHtml = await page.content().catch(() => '');
    fs.writeFileSync(path.join(debugDir, `${debugStamp}-post-button-not-found.html`), postButtonHtml, 'utf8');
    console.warn(`   ⚠️  Dumped ${debugDir}\\${debugStamp}-post-button-not-found.*`);
  }

  // Give LinkedIn time to actually finish creating the post before touching
  // anything else — was 7.5s, bumped up since the Send/Copy-link flow below
  // needs the new post card to be fully rendered, not just started.
  console.log('   Waiting 8s for the post to finish posting...');
  await page.waitForTimeout(8000);

  // Confirmed live 2026-09-23: `a[href*="/feed/update/"]` matches ANY such
  // link anywhere on the page — including sidebar "Promoted"/suggested
  // content unrelated to what was just posted — so candidates[0] silently
  // returned someone else's post URL for multiple runs in a row while
  // still reporting "success". Every real feed post card carries
  // data-urn="urn:li:activity:..." on its root; the freshly-created post
  // is the first one in the main feed, so build the permalink from that
  // urn instead of trusting whichever anchor happens to appear first.
  const fetchPostUrlFromDom = async (): Promise<string> => {
    await page.evaluate(() => window.scrollTo(0, 0));
    return page.evaluate(() => {
      const cards: Element[] = [];
      const stack: (Document | Element | ShadowRoot)[] = [document];
      while (stack.length) {
        const r = stack.pop()!;
        r.querySelectorAll('[data-urn^="urn:li:activity:"]').forEach((el) => cards.push(el));
        r.querySelectorAll('*').forEach((el) => {
          if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
        });
      }
      const card = cards[0];
      const urn = card?.getAttribute('data-urn');
      return urn ? `https://www.linkedin.com/feed/update/${urn}/` : '';
    }).catch(() => '');
  };

  // Confirmed live 2026-09-23: after clicking "Post", the page is often
  // still sitting on linkedin.com/sharing/compose (the "Done"/"Document"
  // links earlier in this flow navigate there for real) — a URL with NO
  // feed content on it at all, so neither the Send button nor a data-urn
  // scan can ever find anything there, no matter how long we wait or how
  // many selectors we try. A plain feed reload doesn't reliably surface
  // the new post either (feed ranking can bury it). The one page proven
  // live to reliably show the just-created post at the very top is the
  // account's own activity feed — that's literally how the "Poland Cold
  // Chain Logistics" post was independently verified earlier — so navigate
  // there once before attempting either detection method.
  console.log('   Navigating to the account\'s own activity feed to find the new post...');
  await page.goto('https://www.linkedin.com/in/me/recent-activity/all/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  // Primary: LinkedIn's own "Send" -> "Copy link to post" action gives the
  // exact real permalink straight from the clipboard, no guessing which
  // DOM card is the new one. Falls back to the data-urn scan (below) if
  // this UI path doesn't match live (selectors can drift, as already seen
  // multiple times in this same flow).
  console.log('   Trying "Send" -> "Copy link to post" to get the exact post URL...');
  let postUrl = await fetchPostUrlViaCopyLink(page);
  if (postUrl) console.log(`   ✅ Got post URL via Copy link: ${postUrl}`);

  // Re-clicking "Post" here if the URL merely hadn't rendered yet risks
  // firing a SECOND real post for the same content (confirmed live
  // 2026-09-23: the first click had already gone through — user verified
  // the post existed — while this code still re-clicked "Post" because
  // fetchPostUrl hadn't found the card in time). Only ever poll for the
  // URL after the single initial click; never click "Post" again here.
  if (!postUrl) {
    console.log('   Falling back to scanning the DOM for the post card...');
    const postUrlCheckpointsSec = [3, 6, 10, 15, 22];
    let urlElapsedSec = 0;
    for (const checkpointSec of postUrlCheckpointsSec) {
      await page.waitForTimeout((checkpointSec - urlElapsedSec) * 1000);
      urlElapsedSec = checkpointSec;
      postUrl = await fetchPostUrlFromDom();
      console.log(`   ...checking post URL at ${checkpointSec}s: ${postUrl ? 'found' : 'not yet'}`);
      if (postUrl) break;
    }
  }
  if (postUrl) {
    console.log(`   ✅ Post URL: ${postUrl}`);
  } else {
    // Never claim success without a post URL as evidence -- this flow had
    // several steps (Done click, composer focus, Post click) fail silently
    // behind forceClick's own try/catch, which used to still return
    // success:true regardless (a real post may never have gone through).
    // Dump evidence before throwing, same as every other failure point in
    // this flow, instead of guessing why detection failed on the next try.
    await page.screenshot({ path: path.join(debugDir, `${debugStamp}-posturl-not-confirmed.png`), fullPage: false }).catch(() => {});
    const postUrlNotConfirmedHtml = await page.content().catch(() => '');
    fs.writeFileSync(path.join(debugDir, `${debugStamp}-posturl-not-confirmed.html`), postUrlNotConfirmedHtml, 'utf8');
    console.warn(`   ⚠️  Dumped ${debugDir}\\${debugStamp}-posturl-not-confirmed.*`);
    throw new Error('LinkedIn document post: could not confirm a post URL after clicking Post -- treating as failed rather than reporting a false success. Check the account feed manually before retrying, in case the post actually went through.');
  }

  return {
    success: true,
    postUrl,
    postText: cleanPostText,
    postedAt: new Date(),
  };
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
  // Same fix as postToLinkedInWithDocument above: `a[href*="/feed/update/"]`
  // matches unrelated sidebar/promoted links too, so build the permalink
  // from the real feed post card's data-urn instead.
  const fetchPostUrlFromDom = async (): Promise<string> => {
    await page.evaluate(() => window.scrollTo(0, 0));
    return page.evaluate(() => {
      const cards: Element[] = [];
      const stack: (Document | Element | ShadowRoot)[] = [document];
      while (stack.length) {
        const r = stack.pop()!;
        r.querySelectorAll('[data-urn^="urn:li:activity:"]').forEach((el) => cards.push(el));
        r.querySelectorAll('*').forEach((el) => {
          if ((el as HTMLElement).shadowRoot) stack.push((el as HTMLElement).shadowRoot!);
        });
      }
      const card = cards[0];
      const urn = card?.getAttribute('data-urn');
      return urn ? `https://www.linkedin.com/feed/update/${urn}/` : '';
    }).catch(() => '');
  };

  // Same fix as postToLinkedInWithDocument above: neither the Send button
  // nor a data-urn scan can find anything on a page with no feed content,
  // so navigate to the account's own activity feed (proven live to
  // reliably show the just-created post at the top) before trying either.
  console.log('   Navigating to the account\'s own activity feed to find the new post...');
  await page.goto('https://www.linkedin.com/in/me/recent-activity/all/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  // Primary: same "Send" -> "Copy link to post" -> clipboard approach as
  // postToLinkedInWithDocument, falling back to the data-urn DOM scan.
  console.log('   Trying "Send" -> "Copy link to post" to get the exact post URL...');
  let postUrl = await fetchPostUrlViaCopyLink(page);
  if (postUrl) console.log(`   ✅ Got post URL via Copy link: ${postUrl}`);

  // Same fix as postToLinkedInWithDocument: never re-click "Post" here to
  // chase a slow-to-render URL — that risks firing a second real post for
  // content that already went through. Only ever poll for the URL.
  if (!postUrl) {
    console.log('   Falling back to scanning the DOM for the post card...');
    const postUrlCheckpointsSec = [3, 6, 10, 15, 22];
    let urlElapsedSec = 0;
    for (const checkpointSec of postUrlCheckpointsSec) {
      await page.waitForTimeout((checkpointSec - urlElapsedSec) * 1000);
      urlElapsedSec = checkpointSec;
      postUrl = await fetchPostUrlFromDom();
      console.log(`   ...checking post URL at ${checkpointSec}s: ${postUrl ? 'found' : 'not yet'}`);
      if (postUrl) break;
    }
  }
  if (postUrl) {
    console.log(`   ✅ Post URL: ${postUrl}`);
  } else {
    const imgDebugDir = path.resolve('logs', 'li-document-debug');
    fs.mkdirSync(imgDebugDir, { recursive: true });
    const imgDebugStamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(imgDebugDir, `${imgDebugStamp}-posturl-not-confirmed.png`), fullPage: false }).catch(() => {});
    const imgPostUrlHtml = await page.content().catch(() => '');
    fs.writeFileSync(path.join(imgDebugDir, `${imgDebugStamp}-posturl-not-confirmed.html`), imgPostUrlHtml, 'utf8');
    console.warn(`   ⚠️  Dumped ${imgDebugDir}\\${imgDebugStamp}-posturl-not-confirmed.*`);
    throw new Error('LinkedIn image post: could not confirm a post URL after clicking Post -- treating as failed rather than reporting a false success. Check the account feed manually before retrying, in case the post actually went through.');
  }

  return {
    success: true,
    postUrl,
    postText: cleanPostText,
    postedAt: new Date(),
  };
}
