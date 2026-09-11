import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Rewritten 2026-09-02 — the old flow targeted www.notion.so's classic UI
// ("New page" button → "Page" type popup → wait for a showMoveTo=true&
// saveParent=true URL slug) and only ever succeeded 2 times out of 646
// historical attempts. Notion has since moved to app.notion.com's
// React-Native-Web UI (the "x87ps6o x1ypdohk..." atomic-CSS class soup) —
// confirmed live 2026-09-02 against the real page. Going straight to
// app.notion.com/new skips the old brittle new-page/page-type flow
// entirely (it lands directly on a blank editable page), and the
// Share/Publish flow below matches the new UI's real DOM, using aria-label/
// role selectors (the only stable attributes in this atomic-CSS UI) rather
// than the auto-generated class names, which are expected to change on
// every Notion frontend rebuild.
export async function postToNotion(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Notion);

  // Maximize window
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  // Step 1: Navigate directly to a fresh blank page — skips the old
  // "New page" button + "Page" type popup + URL-slug-confirmation retry
  // loop entirely.
  console.log('   Navigating to app.notion.com/new...');
  try {
    await page.goto('https://app.notion.com/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch { /* timeout ok */ }
  const initialWait = 5000;
  console.log(`   Waiting ${Math.round(initialWait / 1000)}s for Notion to settle...`);
  await sleep(initialWait);

  if (page.url().includes('/login') || page.url().includes('/sign-in')) {
    throw new Error('Notion not logged in — manual login required');
  }

  // Step 2: Wait for title field, then type.
  console.log('   Waiting for title field...');
  const TITLE_SEL = 'h1[placeholder="New page"][contenteditable="true"]';
  const TITLE_SEL_ALT = '[role="textbox"][aria-roledescription="page title"]';
  try {
    await page.waitForSelector(`${TITLE_SEL}, ${TITLE_SEL_ALT}`, { timeout: 15000 });
    const titleEl = page.locator(`${TITLE_SEL}, ${TITLE_SEL_ALT}`).first();
    await titleEl.click();
    await sleep(2000);
    await page.keyboard.insertText(String(title).trim());
    await sleep(5000);
    await page.keyboard.press('Enter');
    console.log('   ✅ Title typed');
  } catch {
    await page.evaluate((t: string) => {
      const tb = document.querySelector<HTMLElement>('[aria-roledescription="page title"], h1[contenteditable="true"]');
      if (tb) { tb.focus(); document.execCommand('selectAll', false, undefined); document.execCommand('insertText', false, t); }
    }, String(title).trim());
    await page.keyboard.press('Enter');
    console.warn('   ⚠️ Used JS execCommand for title');
  }
  await sleep(2000);

  // Step 3: Render HTML in temp page → copy to clipboard → paste into Notion body
  console.log('   Rendering HTML in temp page and copying...');
  try {
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(500);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
      console.log('   ✅ HTML rendered and copied');
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not render/copy HTML: ${err.message}`);
  }
  await sleep(2000);

  // Click body area and paste
  console.log('   Clicking body area...');
  const bodyEl = page.locator('div[data-content-editable-leaf="true"][contenteditable="true"]').last();
  await bodyEl.click({ timeout: 5000 }).catch(async () => {
    await page.mouse.click(640, 450);
    console.warn('   ⚠️ Used mouse click for body');
  });
  await sleep(2000);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');

  // Step 4: Open Share panel — aria-label="Share" is the only stable
  // attribute on this button in the new UI (the class list is auto-generated
  // atomic CSS and will drift on every Notion rebuild).
  // isVisible({timeout}) does NOT poll/wait in Playwright — it checks the
  // current DOM state once and returns immediately. Every step below the
  // Share click was using it as if it waited, so when the Share panel took
  // longer than an instant to render, every subsequent isVisible() check
  // fired before anything existed and the whole flow fell through to JS
  // fallbacks or "not found" (confirmed live 2026-09-02). waitVisible()
  // uses a real waitFor(), which genuinely polls up to `timeout`.
  async function waitVisible(selector: string, timeout: number) {
    const loc = page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch {
      return null;
    }
  }

  // After pasting: wait 10s for the paste to fully settle, then check for
  // the Share button. If it's not up yet, wait 5s more and check again, up
  // to 3 checks total (10s, 15s, 20s cumulative) — then give up for real
  // (throw) instead of silently returning the draft URL as if it worked.
  console.log('   Waiting 10s for content paste to settle...');
  await sleep(10000);

  console.log('   Opening Share panel...');
  let shareBtn = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    shareBtn = await waitVisible('[role="button"][aria-label="Share"]', 1000);
    if (shareBtn) break;
    if (attempt < 3) {
      console.warn(`   ⚠️ Share button not visible yet (check ${attempt}/3) — waiting 5s more...`);
      await sleep(5000);
    }
  }
  if (shareBtn) {
    await shareBtn.click();
    console.log('   ✅ Share panel opened');
  } else {
    throw new Error('Share button never became visible after pasting content (10s + 5s + 5s) — exiting.');
  }
  await sleep(2000);

  // Step 5: In the Share popup, click the "Only people invited" row (opens
  // the "who can access" dropdown), then click "Anyone on the web with
  // link" in the popup that appears — exact text confirmed live 2026-09-02
  // against the real Share panel (replaces the earlier guessed
  // div.notranslate / div[role="menuitem"] selectors, which weren't
  // reliably matching the right elements).
  // Steps 5-6 combined into a retry loop: sometimes the click on the access
  // row doesn't actually open the dropdown (mis-timed click, or the popup
  // closed itself) — the option never appears no matter how long you wait
  // for it, because it was never opened in the first place. Re-click the
  // access row itself and try again instead of just giving up on the option.
  let accessOptionSelected = false;
  for (let attempt = 1; attempt <= 3 && !accessOptionSelected; attempt++) {
    console.log(`   Opening general access dropdown (attempt ${attempt}/3)...`);
    const accessRow = await waitVisible('div:text-is("Only people invited")', 15000);
    if (!accessRow) {
      console.warn('   ⚠️ "Only people invited" row not found — continuing anyway');
      break;
    }
    await accessRow.click({ force: true });
    console.log('   ✅ Access dropdown row clicked');
    await sleep(1500);

    console.log('   Selecting access option...');
    const accessOption = await waitVisible('div[role="presentation"]:text-is("Anyone on the web with link")', 12000);
    if (accessOption) {
      await accessOption.click({ force: true });
      console.log('   ✅ Access option selected');
      accessOptionSelected = true;
    } else {
      console.warn(`   ⚠️ Access option menuitem not found (attempt ${attempt}/3)${attempt < 3 ? ' — retrying...' : ' — continuing anyway'}`);
    }
  }
  await sleep(1500);

  // Step 7: Click the "Publish" tab within the Share panel.
  console.log('   Clicking Publish tab...');
  const publishTab = await waitVisible('[role="tab"]:has-text("Publish")', 15000);
  if (publishTab) {
    await publishTab.click({ force: true });
    console.log('   ✅ Publish tab clicked');
  } else {
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
      const t = tabs.find(t => t.textContent?.trim().includes('Publish'));
      t?.click();
    });
    console.warn('   ⚠️ Used JS fallback for Publish tab');
  }
  await sleep(2000);

  // Step 8: Click the blue "Publish" button.
  console.log('   Clicking Publish button...');
  const publishBtn = await waitVisible('[role="button"]:has-text("Publish")', 15000);
  let published = false;
  if (publishBtn) {
    await publishBtn.click({ force: true });
    published = true;
    console.log('   ✅ Published to web');
  } else {
    published = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]'));
      const btn = all.find(el => el.textContent?.trim() === 'Publish');
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.warn(`   ⚠️ Used JS fallback for Publish button (${published ? 'found' : 'not found'})`);
  }
  await sleep(2000);

  // Step 9: Click "Search engine indexing" row, tick its toggle switch, then
  // read the URL straight from the address bar and exit — do NOT click the
  // "Copy site link" button (per explicit instruction 2026-09-02).
  console.log('   Clicking Search engine indexing row...');
  const seiRow = await waitVisible('div[role="presentation"]:text-is("Search engine indexing")', 15000);
  if (seiRow) {
    await seiRow.click({ force: true });
    console.log('   ✅ Search engine indexing row clicked');
  } else {
    console.warn('   ⚠️ Search engine indexing row not found — continuing anyway');
  }
  await sleep(1500);

  console.log('   Ticking Search engine indexing toggle...');
  const seiToggle = await waitVisible('input[type="checkbox"][role="switch"]', 12000);
  if (seiToggle) {
    await seiToggle.click({ force: true });
    console.log('   ✅ Toggle ticked');
  } else {
    console.warn('   ⚠️ Toggle switch not found — continuing anyway');
  }
  await sleep(1500);

  const publicUrl = page.url();
  console.log(`   ✅ Public URL from address bar: ${publicUrl}`);

  await page.keyboard.press('Escape').catch(() => {});
  console.log(`   ✅ Notion page URL: ${publicUrl}`);
  return { success: true, postUrl: publicUrl, postedAt: new Date() };
}
