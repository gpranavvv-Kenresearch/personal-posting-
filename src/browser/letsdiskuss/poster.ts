import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Post to Letsdiskuss (expects logged-in page).
 * Flow: click Write button → fill TinyMCE → title → category → keywords → meta description → Publish
 */
export async function postToLetsdiskuss(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Letsdiskuss);

  // ── Step 1: Click "Write Blog" button ─────────────────────────────────────
  console.log('   Letsdiskuss: navigating to homepage...');
  await page.goto('https://www.letsdiskuss.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  console.log('   Letsdiskuss: clicking Write button...');
  const writeBtn = page.locator('button.bg-main-primary.w-full').first();
  await writeBtn.waitFor({ state: 'visible', timeout: 15000 });
  await writeBtn.click();
  await sleep(3000);

  // ── Step 2: Fill Title ────────────────────────────────────────────────────
  console.log('   Letsdiskuss: filling title...');
  await page.waitForSelector('input#title', { timeout: 15000 });
  await page.click('input#title');
  await sleep(300);
  await page.fill('input#title', title);
  await sleep(500);

  // ── Step 3: Set content in TinyMCE ───────────────────────────────────────
  console.log('   Letsdiskuss: setting TinyMCE content...');
  const contentSet = await page.evaluate((html: string) => {
    const win = window as any;
    if (win.tinymce && win.tinymce.activeEditor) {
      win.tinymce.activeEditor.setContent(html);
      return true;
    }
    return false;
  }, htmlContent).catch(() => false);

  if (!contentSet) {
    // Fallback: click inside iframe body and paste plain text
    console.log('   Letsdiskuss: TinyMCE API unavailable, falling back to iframe click...');
    const frame = page.frameLocator('iframe[id*="tiny"], iframe[id*="mce"], iframe[title*="Rich Text"]').first();
    const editorBody = frame.locator('body#tinymce');
    await editorBody.waitFor({ state: 'visible', timeout: 10000 });
    await editorBody.click();
    await sleep(300);
    await page.keyboard.insertText(stripHtml(htmlContent));
  }
  await sleep(1000);

  // ── Step 4: Category ──────────────────────────────────────────────────────
  console.log('   Letsdiskuss: selecting category...');
  const categorySel = 'div.ant-select[name="category"]';
  await page.waitForSelector(categorySel, { timeout: 10000 });
  await page.click(categorySel);
  await sleep(500);
  await page.keyboard.type('Others', { delay: 60 });
  await sleep(600);
  await page.keyboard.press('Enter');
  await sleep(500);

  // ── Step 5: Keywords (min 3) ──────────────────────────────────────────────
  console.log('   Letsdiskuss: adding keywords...');
  const kwInput = page.locator('input#keywords');
  await kwInput.waitFor({ state: 'visible', timeout: 10000 });

  for (const kw of ['Ken Research', 'Market Intelligence', 'Market']) {
    await kwInput.click();
    await sleep(200);
    await page.keyboard.type(kw, { delay: 60 });
    await sleep(400);
    await page.keyboard.press('Enter');
    await sleep(400);
  }

  // ── Step 6: Meta Description ──────────────────────────────────────────────
  console.log('   Letsdiskuss: filling meta description...');
  const metaSel = 'textarea#meta_description';
  await page.waitForSelector(metaSel, { timeout: 10000 });
  await page.click(metaSel);
  await sleep(300);
  // Use first 200 chars of plain text as description
  const description = stripHtml(htmlContent).slice(0, 200);
  await page.keyboard.type(description, { delay: 30 });
  await sleep(500);

  // ── Step 7: Publish ───────────────────────────────────────────────────────
  console.log('   Letsdiskuss: waiting for Publish button to enable...');
  const publishBtn = page.locator('button:has-text("Publish Post")').first();
  await publishBtn.waitFor({ state: 'visible', timeout: 10000 });

  // Wait up to 15s for disabled attr to drop
  await page.waitForFunction(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Publish Post'));
    return btn && !btn.hasAttribute('disabled') && !btn.classList.contains('cursor-not-allowed');
  }, { timeout: 15000 }).catch(() => {
    console.log('   Letsdiskuss: Publish button still disabled — attempting click anyway');
  });

  await publishBtn.click();
  await sleep(4000);

  // ── Step 8: Capture URL — grab address bar after 4s ──────────────────────
  const publishedUrl = page.url();

  console.log(`   ✅ Letsdiskuss published. URL: ${publishedUrl}`);
  return { success: true, postUrl: publishedUrl, postedAt: new Date() };
}
