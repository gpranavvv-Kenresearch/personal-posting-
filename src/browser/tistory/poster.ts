import { Page, Frame } from 'playwright';
import fs from 'fs';
import path from 'path';

// Tistory post-writer — selectors confirmed live 2026-09-24 against a real
// account's newpost page (e.g. https://<blogName>.tistory.com/manage/newpost).
//
// Sequence: title textarea -> body#tinymce (TinyMCE, inside its own iframe
// document, confirmed by the given markup being a full <body> tag) -> click
// "완료" (Complete) to open the publish-settings layer -> pick a visibility
// radio -> click "공개 발행" (Publish) -> read the resulting URL from the
// address bar.
const TITLE_INPUT_SEL = '#post-title-inp';
const BODY_EDITOR_SEL = 'body#tinymce[contenteditable="true"]';
const COMPLETE_BUTTON_SEL = '#publish-layer-btn'; // "완료"
const VISIBILITY_RADIO_SEL = '#open20';
const PUBLISH_BUTTON_SEL = '#publish-btn'; // "공개 발행"

export interface TistoryPostResult {
  success: boolean;
  postUrl?: string;
  error?: string;
}

// TinyMCE's editable body is a full <body> tag in the markup supplied,
// which only happens for an iframe's own document — search every frame
// for it rather than assume the main page or a specific iframe name/id
// (Tistory's iframe id isn't guaranteed stable across accounts).
async function findTinyMceFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const found = await frame.locator(BODY_EDITOR_SEL).first().isVisible().catch(() => false);
    if (found) return frame;
  }
  return null;
}

export async function postToTistory(
  page: Page,
  params: { blogName?: string; title: string; content: string },
): Promise<TistoryPostResult> {
  try {
    // Don't goto() the newpost URL directly — going in "cold" like that
    // apparently doesn't carry a trusted session the same way a real click
    // does. Instead land on tistory.com and click the site's own "글쓰기"
    // (Write) link, which opens the editor in a new tab
    // (target="_blank") — confirmed live 2026-09-24 from the real markup:
    // <a class="link_tab" href=".../manage/newpost" target="_blank">글쓰기</a>
    console.log('   Navigating to https://www.tistory.com/...');
    await page.goto('https://www.tistory.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    console.log('   Clicking "글쓰기" (Write) link...');
    // No blogName needed — whichever blog the logged-in account owns, its
    // own "글쓰기" link on tistory.com always points at that blog's
    // newpost page, so just match the generic href pattern (falls back to
    // an exact blogName match first, if one was given, for accounts that
    // manage more than one blog).
    const writeLink = params.blogName
      ? page.locator(`a.link_tab[href*="${params.blogName}.tistory.com/manage/newpost"]`).first()
      : page.locator('a.link_tab[href*="/manage/newpost"]').first();
    await writeLink.waitFor({ state: 'visible', timeout: 15000 });

    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 15000 }),
      writeLink.click(),
    ]);
    await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    page = newPage;
    await page.waitForTimeout(2000);

    console.log('   Filling title...');
    const titleField = page.locator(TITLE_INPUT_SEL).first();
    try {
      await titleField.waitFor({ state: 'visible', timeout: 15000 });
    } catch (waitErr) {
      // Diagnose instead of guessing: dump the current URL + a screenshot
      // so we can tell whether the session bounced to a login/checkpoint
      // page, or a dialog (draft-recovery / editor-mode chooser) is
      // blocking the title field.
      const debugDir = path.resolve('logs');
      fs.mkdirSync(debugDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const shotPath = path.join(debugDir, `tistory-title-timeout-${stamp}.png`);
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      const currentUrl = page.url();
      console.error(`   ❌ Title field never appeared. Current URL: ${currentUrl}`);
      console.error(`   Screenshot saved to: ${shotPath}`);
      return {
        success: false,
        error: `Title field (#post-title-inp) not visible after navigation. Current URL: ${currentUrl}. Screenshot: ${shotPath}`,
      };
    }
    await titleField.click();
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.insertText(params.title);
    await page.waitForTimeout(500);

    console.log('   Locating TinyMCE body editor...');
    // The editor iframe loads asynchronously and can lag behind the title
    // field (which is native to the page, not inside an iframe) — poll for
    // it instead of checking once.
    let editorFrame: Frame | null = null;
    for (let attempt = 0; attempt < 10 && !editorFrame; attempt++) {
      editorFrame = await findTinyMceFrame(page);
      if (!editorFrame) await page.waitForTimeout(1000);
    }
    if (!editorFrame) {
      const debugDir = path.resolve('logs');
      fs.mkdirSync(debugDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const shotPath = path.join(debugDir, `tistory-editor-timeout-${stamp}.png`);
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      const frameUrls = page.frames().map(f => f.url());
      console.error(`   ❌ TinyMCE frame not found. Current URL: ${page.url()}`);
      console.error(`   Frames present: ${JSON.stringify(frameUrls)}`);
      console.error(`   Screenshot saved to: ${shotPath}`);
      return {
        success: false,
        error: `Could not find the TinyMCE body editor (body#tinymce) in any frame. Current URL: ${page.url()}. Frames: ${JSON.stringify(frameUrls)}. Screenshot: ${shotPath}`,
      };
    }

    // Render the HTML in a temp page and copy it — a synthetic paste event
    // with only text/plain DataTransfer data (the technique used for
    // Lexical/ProseMirror composers elsewhere) loses all formatting on a
    // real WYSIWYG editor like TinyMCE. A genuine OS-level copy after
    // selecting real rendered HTML preserves the text/html clipboard
    // format, which TinyMCE's own paste handler reads — same technique
    // already proven for LinkedIn Pulse's article editor.
    console.log('   Rendering HTML in a temp page and copying it...');
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(params.content, { waitUntil: 'networkidle', timeout: 20000 }).catch(() =>
        tempPage.setContent(params.content, { waitUntil: 'domcontentloaded', timeout: 10000 })
      );
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(300);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
    } finally {
      await tempPage.close();
    }

    console.log('   Pasting into the body editor...');
    const bodyEditor = editorFrame.locator(BODY_EDITOR_SEL).first();
    await bodyEditor.click();
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(2000);

    console.log('   Clicking "완료" (Complete) to open publish settings...');
    const completeBtn = page.locator(COMPLETE_BUTTON_SEL).first();
    await completeBtn.waitFor({ state: 'visible', timeout: 15000 });
    await completeBtn.click();
    await page.waitForTimeout(2500);

    console.log('   Selecting visibility option...');
    const visibilityRadio = page.locator(VISIBILITY_RADIO_SEL).first();
    if (await visibilityRadio.isVisible({ timeout: 5000 }).catch(() => false)) {
      await visibilityRadio.click();
      await page.waitForTimeout(500);
    } else {
      console.warn('   ⚠️ Visibility radio (#open20) not visible — continuing anyway');
    }

    console.log('   Clicking "공개 발행" (Publish)...');
    const publishBtn = page.locator(PUBLISH_BUTTON_SEL).first();
    await publishBtn.waitFor({ state: 'visible', timeout: 15000 });
    await publishBtn.click();
    await page.waitForTimeout(3000);

    // Publishing redirects to the /manage/posts/ list, not the post's own
    // permalink — confirmed live 2026-09-24 by reading that page's real
    // markup. The just-published post is always the first entry
    // (strong.tit_post > a.link_cont), so read its href instead of trusting
    // page.url() here.
    let postUrl = page.url();
    try {
      await page.waitForURL(/\/manage\/posts\/?/, { timeout: 8000 }).catch(() => {});
      const firstPostLink = page.locator('strong.tit_post a.link_cont').first();
      await firstPostLink.waitFor({ state: 'visible', timeout: 8000 });
      const href = await firstPostLink.getAttribute('href');
      if (href) postUrl = href;
    } catch {
      // fall back to page.url() already set above
    }
    console.log(`   ✅ Tistory post published: ${postUrl}`);
    return { success: true, postUrl };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
