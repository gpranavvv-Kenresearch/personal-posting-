import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function postToAmeba(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  // Minimize browser
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Ameba);

  // Step 1: Navigate directly to composer
  console.log('   Navigating to Ameba composer...');
  await page.goto('https://blog.ameba.jp/ucs/entry/srventryinsertinput.do', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  // Step 2: Fill title
  console.log('   Filling title...');
  await page.waitForSelector('input[name="entry_title"]', { timeout: 15000 });
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('input[name="entry_title"]');
    if (el) el.scrollIntoView({ block: 'center' });
  });
  await sleep(500);
  await page.click('input[name="entry_title"]', { force: true, timeout: 10000 });
  await sleep(2000);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(title.slice(0, 48), { delay: 60 });
  await sleep(500);

  // Step 3: Inject content directly into CKEditor body (lives inside an iframe)
  console.log('   Injecting content into editor...');
  try {
    // Locate the CKEditor iframe
    let editorFrame =
      page.frames().find(f => f.name().includes('cke_') || f.url().includes('cke_')) || null;
    if (!editorFrame) {
      const frameHandle = await page.waitForSelector(
        'iframe.cke_wysiwyg_frame, iframe[title*="editor"], iframe[id*="cke_"]',
        { timeout: 15000 }
      ).catch(() => null);
      if (frameHandle) editorFrame = await frameHandle.contentFrame();
    }

    if (!editorFrame) throw new Error('CKEditor iframe not found');

    await editorFrame.waitForSelector('body.cke_editable[contenteditable="true"]', { timeout: 10000 });
    await editorFrame.click('body.cke_editable[contenteditable="true"]');
    await sleep(800);

    // Set HTML directly on the contenteditable body and fire input event so CKEditor syncs
    await editorFrame.evaluate((html) => {
      const body = document.querySelector<HTMLBodyElement>('body.cke_editable[contenteditable="true"]');
      if (!body) return;
      body.innerHTML = html;
      body.dispatchEvent(new Event('input',  { bubbles: true }));
      body.dispatchEvent(new Event('change', { bubbles: true }));
      body.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }, htmlContent);

    await sleep(2000);

    // Verify
    const filled = await editorFrame.evaluate(() => {
      const body = document.querySelector('body.cke_editable[contenteditable="true"]');
      return !!body && (body.innerHTML || '').replace(/<p><br><\/p>/g, '').trim().length > 0;
    });
    if (!filled) {
      console.warn('   ⚠️ innerHTML inject reported empty — falling back to clipboard paste...');
      const tempPage = await page.context().newPage();
      try {
        await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await tempPage.waitForTimeout(1500);
        await tempPage.keyboard.press('Control+A');
        await tempPage.waitForTimeout(200);
        await tempPage.keyboard.press('Control+C');
        await tempPage.waitForTimeout(500);
      } finally {
        await tempPage.close();
      }
      await editorFrame.click('body.cke_editable[contenteditable="true"]');
      await sleep(800);
      await editorFrame.evaluate(() => {
        const sel = window.getSelection();
        const body = document.querySelector('body.cke_editable[contenteditable="true"]');
        if (sel && body) {
          const range = document.createRange();
          range.selectNodeContents(body);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
      await page.keyboard.press('Control+V');
      await sleep(2000);
    }

    console.log('   ✅ Content injected into editor');
  } catch (err: any) {
    console.warn(`   ⚠️ Could not inject content: ${err.message}`);
  }

  // Step 4: Fill SEO title if available
  console.log('   Filling SEO title...');
  await page.evaluate(() => window.scrollBy(0, 600));
  await sleep(1000);
  try {
    const seoTitle = page.locator('#meta_title').first();
    if (await seoTitle.isVisible({ timeout: 5000 }).catch(() => false)) {
      await seoTitle.click({ delay: 100 });
      await sleep(2000);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(title.slice(0, 48), { delay: 60 });
      await sleep(500);
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not fill SEO title: ${err.message}`);
  }

  // Helper: click Publish on the editor page
  const clickPublish = async () => {
    const ok = await page.evaluate(() => {
      // Prefer the exact publish button: js-submitButton with publishflg="0"
      const exact =
        document.querySelector<HTMLElement>('button.js-submitButton[publishflg="0"]') ||
        document.querySelector<HTMLElement>('button.p-submit__button.js-submitButton') ||
        document.querySelector<HTMLElement>('button.js-submitButton');
      if (exact) { exact.scrollIntoView({ block: 'center' }); exact.click(); return true; }
      const fallback =
        document.querySelector<HTMLElement>('input[name="submit"][type="submit"]') ||
        document.querySelector<HTMLElement>('button[type="submit"]') ||
        (Array.from(document.querySelectorAll('button, input[type="submit"]')) as HTMLElement[])
          .find(el => /公開|投稿|post|publish|submit/i.test(el.textContent || (el as HTMLInputElement).value || ''));
      if (fallback) { fallback.scrollIntoView({ block: 'center' }); fallback.click(); return true; }
      return false;
    }).catch(() => false);
    if (!ok) {
      await page.locator(
        'button.js-submitButton[publishflg="0"], button.js-submitButton, button[type="submit"], input[type="submit"]'
      ).first().click({ force: true, delay: 150 }).catch(() => {});
    }
  };

  // Step 5: Publish click — opens the success tab with copy-link button
  console.log('   Clicking Publish...');
  const popupPromise = page.context().waitForEvent('page', { timeout: 20000 }).catch(() => null);
  await clickPublish();
  const successPopup = await popupPromise;
  if (successPopup) {
    await successPopup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    console.log('   Success popup opened — looking for copy-link button');
  } else {
    console.warn('   ⚠️ No popup opened after publish click');
  }
  await sleep(3000);

  // Step 7: Find the "copy link" button on the success popup (fallback to any live page)
  let postUrl = '';
  const candidates: Page[] = [
    ...(successPopup ? [successPopup] : []),
    ...page.context().pages(),
  ];
  for (const p of candidates) {
    try {
      if (p.isClosed()) continue;
      const btn = p.locator('button.entryComplete__shareLink--copy').first();
      if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
        const onclick = await btn.getAttribute('onclick');
        const m = onclick?.match(/['"](https?:\/\/[^'"]+)['"]/);
        if (m) { postUrl = m[1]; break; }
      }
    } catch { /* try next */ }
  }

  // Fallbacks — try canonical / URL on any live page
  if (!postUrl) {
    for (const p of page.context().pages()) {
      if (p.isClosed()) continue;
      const canonical = await p.$eval('link[rel="canonical"]', el => el.getAttribute('href') ?? '').catch(() => '');
      if (canonical && canonical.includes('ameba')) { postUrl = canonical; break; }
      const u = p.url();
      if (u && u.includes('ameblo.jp/') && /entry-\d+/.test(u)) { postUrl = u; break; }
    }
  }
  if (!postUrl) postUrl = page.isClosed() ? '' : page.url();

  console.log(`   ✅ Posted to Ameba: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
