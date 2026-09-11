import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function gotoWithRetry(page: Page, url: string, expectedDomain: string, retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { /* timeout — check URL anyway */ }
    const landed = page.url();
    if (landed !== 'about:blank' && landed !== '' && landed.includes(expectedDomain)) return;
    console.log(`   ⚠️ Navigation landed on "${landed}" (attempt ${attempt}/${retries}) — retrying...`);
    await sleep(3000);
  }
  const final = page.url();
  if (final === 'about:blank' || final === '' || !final.includes(expectedDomain)) {
    throw new Error(`Failed to navigate to ${url} after ${retries} attempts. Landed on: ${final}`);
  }
}

export async function postToPatreon(
  page: Page,
  title: string,
  htmlContent: string,
  creatorUrl?: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Patreon);

  // Restore window to proper position
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  // Step 0: Navigate to home and switch to creator mode
  console.log('   Navigating to Patreon home...');
  await gotoWithRetry(page, 'https://www.patreon.com/home', 'patreon.com');
  await sleep(3000);

  // Step 0a: Click account menu toggle to open the switcher dialog
  console.log('   Opening account menu...');
  const accountMenuBtn = page.locator('button[data-tag="account-menu-toggle-switcher"]').first();
  await accountMenuBtn.waitFor({ state: 'visible', timeout: 10000 });
  await accountMenuBtn.click();
  await sleep(1500);
  console.log('   ✅ Account menu opened');

  // Step 0b: Click "Go to creator home page" inside the popup
  console.log('   Clicking creator link in popup...');
  // Try selectors one by one
  let switched = false;
  for (const sel of [
    'a[aria-label="Go to creator home page"]',
    'img.Avatar-module__hg9SJa__avatar',
    'a.AccountSwitcher-module__LoeYLq__link',
    'div.sc-cca241b3-1.bcpZcA',
  ]) {
    const el = page.locator(sel).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await el.click();
      switched = true;
      console.log(`   ✅ Clicked creator switcher (${sel})`);
      break;
    }
  }
  if (!switched) {
    // Try force-click on avatar image even if hidden
    await page.locator('img.Avatar-module__hg9SJa__avatar').first().click({ force: true }).catch(() => {});
    console.warn('   ⚠️ Used force-click fallback');
  }

  // Wait for navigation to creator /c/ page
  await page.waitForURL(url => url.toString().includes('/c/'), { timeout: 10000 }).catch(() => {});
  await sleep(2000);
  console.log(`   ✅ Creator mode — now at: ${page.url()}`);

  // Step 1: Click the "Create post" button  [data-tag="create-content-button"]
  console.log('   Clicking Create post button...');
  const createBtn = page.locator('[data-tag="create-content-button"]').first();
  await createBtn.waitFor({ state: 'visible', timeout: 15000 });
  await createBtn.click();
  await sleep(1500);
  console.log('   ✅ Create button clicked');

  // Step 2: Click "Post" from the popup dialog
  console.log('   Selecting Post from popup...');
  let postClicked = false;
  const postSelectors = [
    'li.sc-c7e2141-1.frEUhw a.sc-731eaab5-1.dQFHkG',
    'li.sc-c7e2141-1 a.sc-731eaab5-1',
    'a.sc-731eaab5-1.dQFHkG',
    '[role="menuitem"]:has-text("Post")',
    '[role="option"]:has-text("Post")',
    '[data-tag="post-type-post"]',
  ];
  for (const sel of postSelectors) {
    const el = page.locator(sel).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (visible) {
      await el.click({ force: true });
      postClicked = true;
      console.log(`   ✅ Post type selected (${sel})`);
      break;
    }
  }
  if (!postClicked) {
    // JS fallback: click exact-text "Post" link in the popup
    await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('li a, li button, [role="menuitem"]'));
      const match = els.find(el => el.textContent?.trim() === 'Post' && (el as HTMLElement).offsetParent !== null);
      if (match) (match as HTMLElement).click();
    });
    console.warn('   ⚠️ Used JS click fallback for Post option');
  }
  await sleep(2500);

  // Step 3: Fill title in the textarea[placeholder="Title"]
  console.log('   Typing title...');
  const titleField = page.locator('textarea[placeholder="Title"], textarea[aria-label="Title"]').first();
  await titleField.waitFor({ state: 'visible', timeout: 10000 });
  await titleField.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await titleField.type(String(title).trim(), { delay: 40 });
  console.log('   ✅ Title typed');
  await sleep(800);

  // Step 4: Render HTML in temp page → copy to clipboard
  console.log('   Rendering HTML and copying to clipboard...');
  try {
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(300);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
      console.log('   ✅ Content copied');
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not copy HTML: ${err.message}`);
  }

  // Step 5: Click the ProseMirror editor and paste
  console.log('   Clicking editor and pasting content...');
  // Primary: ProseMirror contenteditable div
  const editor = page.locator('div.ProseMirror.remirror-editor, div[contenteditable="true"][role="textbox"]').first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });
  await editor.click();
  await sleep(500);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');
  await sleep(2000);

  // Step 6: Click Publish button  [data-tag="make-a-post-action-publish"]
  console.log('   Clicking Publish...');
  // Wait for publish button to be in DOM, then JS-click the sizeMd (visible) variant
  await page.waitForSelector('[data-tag="make-a-post-action-publish"]', { state: 'attached', timeout: 10000 });
  const published = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll<HTMLElement>('[data-tag="make-a-post-action-publish"]'));
    // Prefer the sizeMd (large) button which is the visible one
    const md = btns.find(b => b.className.includes('sizeMd'));
    const target = md || btns[btns.length - 1] || btns[0];
    if (target) { target.click(); return true; }
    return false;
  });
  if (!published) throw new Error('Publish button not found in DOM');
  console.log('   ✅ Published');
  await sleep(5000);

  // Step 7: Click "Copy link" button to get post URL
  console.log('   Clicking Copy link...');
  let postUrl = page.url();
  try {
    // The copy-link button has class sc-75636fc1-0 AeJdo
    const copyBtn = page.locator('button.sc-75636fc1-0.AeJdo').first();
    const copyBtnAttached = await copyBtn.isVisible({ timeout: 5000 }).catch(() => false)
      || await copyBtn.count().then(c => c > 0).catch(() => false);
    if (copyBtnAttached) {
      await page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>('button.sc-75636fc1-0.AeJdo');
        if (btn) btn.click();
      });
      await sleep(800);
      // Read URL from clipboard
      try {
        postUrl = await page.evaluate(() => navigator.clipboard.readText());
        console.log(`   ✅ Post URL from clipboard: ${postUrl}`);
      } catch {
        try {
          const { execSync } = await import('child_process');
          postUrl = execSync('powershell -command Get-Clipboard', { timeout: 5000 }).toString().trim();
          console.log(`   ✅ Post URL from powershell clipboard: ${postUrl}`);
        } catch { /* fall back to page URL */ }
      }
    } else {
      console.warn('   ⚠️ Copy link button not found — using page URL');
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Copy link failed: ${err.message}`);
  }

  // If clipboard gave us a non-patreon URL or empty, fall back to page URL
  if (!postUrl || postUrl === 'about:blank' || !postUrl.includes('patreon.com')) {
    postUrl = page.url();
  }

  console.log(`   ✅ Patreon post URL: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
