import { Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { preparePlainSocialPost } from '../../utils/socialText.js';

const CRITICAL_TIMEOUT_MS = 30_000;

// ── PDF upload strategies (ported from publish_linkedin.js) ─────────────────

async function tryStrategy_PROVEN(page: Page, pdfFile: string): Promise<boolean> {
  console.log('   [PDF-PROVEN] Expanding "More" menu via JS click...');
  const absPath = path.resolve(pdfFile);

  try {
    const composerOpen = await page.locator('div[role="textbox"]').first().isVisible({ timeout: 2000 }).catch(() => false);
    if (!composerOpen) {
      console.warn('   [PDF-PROVEN] Composer not visible — cannot attach PDF.');
      return false;
    }

    const moreLocator = page.locator('button[aria-label="More"]').first();
    if (!(await moreLocator.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.warn('   [PDF-PROVEN] No "More" button in composer.');
      return false;
    }
    await moreLocator.dispatchEvent('click');
    await page.waitForTimeout(2500);

    let docClicked = false;
    try {
      const docLocator = page.getByRole('button', { name: 'Add a document' });
      if (await docLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
        await docLocator.dispatchEvent('click');
        docClicked = true;
        console.log('   [PDF-PROVEN] "Add a document" clicked.');
      }
    } catch {}

    if (!docClicked) {
      docClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = buttons.find(b => (b.textContent || '').trim().toLowerCase().includes('add a document'));
        if (btn) { (btn as HTMLElement).click(); return true; }
        return false;
      });
    }
    if (!docClicked) throw new Error('"Add a document" not found in expanded menu.');

    await page.waitForTimeout(2000);
    try {
      await page.getByLabel('Choose file').setInputFiles(absPath, { timeout: 8000 });
    } catch {
      const inputs = await page.$$('input[type="file"]');
      if (!inputs.length) throw new Error('No file input after clicking "Add a document".');
      await inputs[inputs.length - 1].setInputFiles(absPath);
    }
    console.log('   [PDF-PROVEN] PDF uploaded. Waiting 15s for LinkedIn to process...');
    await page.waitForTimeout(15000);

    const baseName = path.basename(pdfFile, '.pdf')
      .replace(/^carousel_\d{4}-\d{2}-\d{2}_/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c: string) => c.toUpperCase());

    try {
      await page.getByPlaceholder('Add a descriptive title to your document').fill(baseName, { timeout: 5000 });
      console.log(`   [PDF-PROVEN] Title filled: ${baseName}`);
    } catch {}

    try {
      await page.getByRole('button', { name: 'Done' }).click({ timeout: 8000 });
    } catch {
      const doneClicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').trim() === 'Done');
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!doneClicked) console.warn('   [PDF-PROVEN] No Done button found.');
    }

    await page.waitForTimeout(4000);
    console.log('   [PDF-PROVEN] ✅ Document attached.');
    return true;
  } catch (err: any) {
    console.warn(`   [PDF-PROVEN] failed: ${err.message}`);
    return false;
  }
}

async function tryStrategy_D(page: Page, pdfFile: string): Promise<boolean> {
  return new Promise(async (resolve) => {
    const absPath = path.resolve(pdfFile);
    let resolved = false;

    const onFileChooser = async (fileChooser: any) => {
      console.log('   [PDF-D] File picker opened — supplying PDF...');
      try {
        await fileChooser.setFiles(absPath);
        await page.waitForTimeout(15000);
        resolved = true;
        resolve(true);
      } catch (err: any) {
        console.warn(`   [PDF-D] setFiles failed: ${err.message}`);
        resolved = true;
        resolve(false);
      }
    };
    page.once('filechooser', onFileChooser);

    const docSpriteSelectors = [
      'button:has(svg use[href="#document-medium"])',
      'button:has(svg use[href="#document-large"])',
      'button:has(svg use[href="#attachment-medium"])',
      'button:has(svg use[href="#file-medium"])',
      'button:has(svg use[href="#paperclip-medium"])',
    ];

    let triggered = false;
    for (const sel of docSpriteSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
          await btn.click({ timeout: 3000 });
          triggered = true;
          break;
        }
      } catch {}
    }

    if (!triggered) {
      const ariaSelectors = ['button[aria-label*="Add a document" i]', 'button[aria-label*="document" i]'];
      for (const sel of ariaSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible().catch(() => false)) {
            await btn.click({ timeout: 3000 });
            triggered = true;
            break;
          }
        } catch {}
      }
    }

    setTimeout(() => {
      if (!resolved) {
        page.off('filechooser', onFileChooser);
        console.warn('   [PDF-D] No file picker fired within 15s.');
        resolve(false);
      }
    }, 15000);
  });
}

async function verifyPdfAttached(page: Page): Promise<boolean> {
  const selectors = [
    'button[aria-label="Edit media preview"]',
    'svg use[href="#edit-small"]',
    'div[data-test-document-share-preview]',
    'div.document-share-preview',
    '.share-creation-state__document-share',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        console.log(`   [PDF-VERIFY] ✅ Attached (${sel})`);
        return true;
      }
    } catch {}
  }
  return false;
}

async function tryAttachPdf(page: Page, pdfFile: string): Promise<boolean> {
  console.log('   [PDF] Attaching carousel PDF...');

  if (await tryStrategy_PROVEN(page, pdfFile)) return true;

  console.log('   [PDF] Trying strategy D (filechooser)...');
  if (await tryStrategy_D(page, pdfFile) && await verifyPdfAttached(page)) return true;

  console.warn('   [PDF] ⚠️  All strategies failed. Post will go text-only.');
  return false;
}

// ── Main carousel post function ──────────────────────────────────────────────

export async function postToLinkedInCarousel(
  page: Page,
  postText: string,
  pdfPath: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not found at path: ${pdfPath}`);
  }

  const cleanPostText = preparePlainSocialPost(postText);

  console.log('   Navigating to LinkedIn feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForSelector('div.feed-shared-update-v2', { timeout: 20000 });
    console.log('   ✅ Feed loaded');
  } catch {
    console.warn('   ⚠️  Feed load timeout, continuing...');
  }

  // ── Click "Start a post" ────────────────────────────────────────────────
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
      console.log(`   ✅ Found start-post button: ${selector}`);
      await btn.click();
      await page.waitForTimeout(5000);
      buttonFound = true;
      break;
    }
  }
  if (!buttonFound) throw new Error("Could not find 'Start a post' button — LinkedIn UI may have changed");

  // ── Wait for composer ───────────────────────────────────────────────────
  try {
    await page.waitForSelector('div[role="textbox"]', { timeout: 20000 });
    console.log('   ✅ Composer ready');
  } catch {
    throw new Error("LinkedIn composer not found after clicking Start a post");
  }

  // ── Attach PDF FIRST (per Namit: carousel before post text) ────────────
  const pdfAttached = await tryAttachPdf(page, pdfPath);

  // ── Type post content ───────────────────────────────────────────────────
  console.log('   Pasting post content...');
  await page.waitForSelector('div[role="textbox"]', { timeout: 10000 });
  const composer = page.locator('div[role="textbox"]').first();
  await composer.click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(cleanPostText);
  await page.waitForTimeout(1500);

  // ── Nudge React so Post button enables ─────────────────────────────────
  await page.evaluate(() => {
    const tb = document.querySelector('div[role="textbox"]');
    if (!tb) return;
    tb.dispatchEvent(new Event('input', { bubbles: true }));
    tb.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
  });
  await page.waitForTimeout(800);

  // ── Click Post button ───────────────────────────────────────────────────
  console.log('   Searching for Post button...');
  const postSel = 'button.share-actions__primary-action';

  // Wait up to 8s for it to be enabled
  let buttonState: any = null;
  for (let i = 0; i < 8; i++) {
    buttonState = await page.evaluate((sel: string) => {
      const btns = Array.from(document.querySelectorAll(sel));
      const candidates = btns.map((b: any) => ({
        disabled: b.disabled,
        ariaDisabled: b.getAttribute('aria-disabled'),
        visible: !!(b.offsetWidth || b.offsetHeight),
        rect: b.getBoundingClientRect(),
      }));
      const enabled = candidates.find(c => c.visible && !c.disabled && c.ariaDisabled !== 'true');
      return { candidates, enabled };
    }, postSel);
    if (buttonState.enabled) break;
    await page.waitForTimeout(1000);
  }

  let postClicked = false;

  if (!postClicked && buttonState?.enabled?.rect) {
    try {
      const { x, y, width, height } = buttonState.enabled.rect;
      await page.mouse.move(x + width / 2, y + height / 2);
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.waitForTimeout(80);
      await page.mouse.up();
      postClicked = true;
      console.log('   ✅ Post clicked via mouse coordinates.');
    } catch (err: any) {
      console.warn(`   [POST-1] ${err.message.split('\n')[0]}`);
    }
  }

  if (!postClicked) {
    try {
      await page.locator(postSel).first().click({ timeout: 3000, delay: 100, force: true });
      postClicked = true;
      console.log('   ✅ Post clicked via force click.');
    } catch (err: any) {
      console.warn(`   [POST-2] ${err.message.split('\n')[0]}`);
    }
  }

  if (!postClicked) {
    postClicked = await page.evaluate((sel: string) => {
      const dialog = document.querySelector('div[role="dialog"]') || document;
      const btn = (dialog as Element).querySelector(`${sel}:not([disabled])`) as HTMLElement
        || Array.from((dialog as Element).querySelectorAll('button')).find(b => (b as HTMLElement).innerText?.trim() === 'Post' && !(b as HTMLButtonElement).disabled) as HTMLElement;
      if (btn) { btn.click(); return true; }
      return false;
    }, postSel);
    if (postClicked) console.log('   ✅ Post clicked via JS.');
  }

  if (!postClicked) throw new Error("'Post' button not clickable — LinkedIn UI may have changed");

  await page.waitForTimeout(5000);

  // ── Get post URL from feed DOM (existing logic) ─────────────────────────
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

  console.log(`   Carousel PDF attached: ${pdfAttached ? '✅' : '❌ (text-only)'}`);

  return {
    success: true,
    postUrl,
    postText: cleanPostText,
    postedAt: new Date(),
  };
}
