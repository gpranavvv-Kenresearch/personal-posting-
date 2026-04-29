import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Post to Guffiz (expects logged-in page)
 *
 * Flow:
 *  1. Go to /blog → click "Write article"
 *  2. Type title → Save Changes
 *  3. Paste HTML content into editor
 *  4. Click "Post article" → pick category (index 8) → OK
 *  5. Click "Update blog settings" → fill description → check checkbox → Save Changes
 *  6. Click "Post article" again (final publish)
 *  7. Wait 3s → grab URL from address bar
 */
export async function postToGuffiz(
  page: Page,
  title: string,
  htmlContent: string,
  description?: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {

  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Guffiz);

  // ── Step 1: Navigate to blog and click Write article ──────────────────────
  console.log('   Navigating to guffiz.com/blog...');
  await page.goto('https://guffiz.com/blog', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  console.log('   Clicking Write article...');
  await page.click('button:has(span.Button-label:text("Write article"))').catch(() =>
    page.click('i.fa-pencil-alt')
  );
  await sleep(2000);

  // ── Dismiss popup if present (max 3s wait) ────────────────────────────────
  const dismissBtn = page.locator('#dismiss-button-element').first();
  const dismissVisible = await dismissBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (dismissVisible) {
    console.log('   Dismissing popup...');
    await dismissBtn.click().catch(() => {});
    await sleep(2000);
  }

  // ── Step 2: Fill title ────────────────────────────────────────────────────
  // Trim title to max 2 commas, no trailing comma
  const parts = title.split(',');
  const trimmedTitle = parts.slice(0, 3).join(',').replace(/,\s*$/, '').trim();
  console.log(`   Filling title: "${trimmedTitle}"`);
  // Click the h3 to reveal the editable input field
  await page.click('h3.FlarumBlog-Article-Title');
  await sleep(2000);

  // Flarum replaces the h3 with an input/textarea — find and fill it
  const titleInput = page.locator([
    'input.FlarumBlog-Article-Title',
    'h3.FlarumBlog-Article-Title input',
    'h3.FlarumBlog-Article-Title textarea',
    '.FlarumBlog-Article-Title input',
    '.FlarumBlog-Article-Title textarea',
    'input[placeholder*="title" i]',
    'input[placeholder*="Title" i]',
  ].join(', ')).first();

  const inputVisible = await titleInput.isVisible({ timeout: 3000 }).catch(() => false);

  if (inputVisible) {
    await titleInput.fill('');
    await sleep(2000);
    await titleInput.fill(trimmedTitle);
    await sleep(2000);
  } else {
    // Fallback: h3 is contenteditable — select all and type
    await page.keyboard.press('Control+A');
    await sleep(2000);
    await page.keyboard.press('Backspace');
    await sleep(2000);
    await page.keyboard.type(trimmedTitle, { delay: 40 });
    await sleep(2000);
  }

  console.log('   Clicking Save Changes (title)...');
  await page.click('button:has(span.Button-label:text("Save Changes"))').catch(() =>
    page.click('span.Button-label:text("Save Changes")')
  );
  await sleep(2000);

  // ── Step 3: Paste HTML content ────────────────────────────────────────────
  console.log('   Clicking content editor...');
  await page.click('p.placeholder[data-before="Enter your message here"]').catch(() =>
    page.click('p.placeholder')
  );
  await sleep(2000);

  console.log('   Inserting HTML content...');
  // Insert HTML directly — no clipboard
  await page.evaluate((html) => {
    document.execCommand('insertHTML', false, html);
  }, htmlContent);
  await sleep(2000);

  // ── Step 4: Click Post article ────────────────────────────────────────────
  console.log('   Clicking Post article...');
  await page.click('button.Button--primary:has(span.Button-label:text("Post article"))').catch(() =>
    page.click('button[itemclassname="App-primaryControl"]')
  );
  await sleep(2000);

  // ── Step 5: Pick category (index 8) ──────────────────────────────────────
  console.log('   Selecting category...');
  await page.click('li[data-index="8"]').catch(() => {});
  await sleep(2000);

  // ── Step 6: Click OK ──────────────────────────────────────────────────────
  console.log('   Clicking OK...');
  await page.click('button[type="submit"]:has(span.Button-label:text("OK"))').catch(() =>
    page.click('button.Button--primary:has(span.Button-label:text("OK"))')
  );
  await sleep(2000);

  // ── Step 7: Click Update blog settings OR pencil icon ─────────────────────
  console.log('   Opening blog settings...');
  await page.click('button:has(span.Button-label:text("Update blog settings"))').catch(() =>
    page.click('i.fa-pencil-alt')
  );
  await sleep(2000);

  // ── Step 8: Fill description (always from sheet Description column) ──────
  console.log('   Filling description...');
  const summary = (description || '').slice(0, 500);
  await page.fill('textarea.FormControl[placeholder="Please enter a summary"]', summary).catch(() => {});
  await sleep(2000);

  // ── Step 9: Check the checkbox (toggle) ──────────────────────────────────
  console.log('   Clicking checkbox/toggle...');
  const toggled = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.Checkbox input[type="checkbox"]');
    if (input && !input.checked) { input.click(); return true; }
    const label = document.querySelector<HTMLElement>('label.Checkbox');
    if (label) { label.click(); return true; }
    const display = document.querySelector<HTMLElement>('div.Checkbox-display');
    if (display) { display.click(); return true; }
    return false;
  }).catch(() => false);
  if (!toggled) {
    await page.click('div.Checkbox-display').catch(() => {});
  }
  await sleep(2000);

  // ── Step 10: Save Changes ─────────────────────────────────────────────────
  console.log('   Saving blog settings...');
  await page.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('button.Button.Button--primary.SupportModal-save[type="submit"]');
    if (btn) btn.click();
  });
  await sleep(2000);

  // ── Step 11: Final Post article ───────────────────────────────────────────
  const clickPostBtn = async () => {
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>('button.Button.Button--primary.hasIcon[itemclassname="App-primaryControl"]');
      if (btn) btn.click();
    });
  };

  console.log('   Final publish click...');
  await clickPostBtn();
  await sleep(5000);

  // ── Step 12: Get URL — retry if "compose" in URL ──────────────────────────
  let publishedUrl = page.url();
  console.log(`   URL check 1: ${publishedUrl}`);

  if (publishedUrl.includes('compose')) {
    console.log('   URL contains "compose" — waiting 5s and retrying...');
    await sleep(5000);
    publishedUrl = page.url();
    console.log(`   URL check 2: ${publishedUrl}`);

    if (publishedUrl.includes('compose')) {
      console.log('   Still "compose" — clicking Post button again...');
      await clickPostBtn();
      await sleep(5000);
      publishedUrl = page.url();
      console.log(`   URL check 3: ${publishedUrl}`);
    }
  }

  console.log(`   ✅ Guffiz post published. URL: ${publishedUrl}`);

  return {
    success: true,
    postUrl: publishedUrl,
    postedAt: new Date(),
  };
}
