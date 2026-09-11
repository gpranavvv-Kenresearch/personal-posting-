import { Page } from 'playwright';
import { getWordpressAccounts } from './login.js';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const CLICK_DELAY = 2000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function gotoWithRetry(page: Page, url: string, expectedDomain: string, retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { /* timeout — check URL anyway */ }
    const landed = page.url();
    if (landed !== 'about:blank' && landed !== '' && landed.includes(expectedDomain)) return;
    console.log(`   ⚠️ Navigation to ${url} landed on "${landed}" (attempt ${attempt}/${retries}) — retrying...`);
    await sleep(3000);
  }
  const final = page.url();
  if (final === 'about:blank' || final === '' || !final.includes(expectedDomain)) {
    throw new Error(`Failed to navigate to ${url} after ${retries} attempts. Landed on: ${final}`);
  }
}

function jsClick(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) (el as HTMLElement).click();
  }, selector);
}

/**
 * Post to WordPress.com (expects logged-in page)
 * Content Format: HTML
 */
export async function postToWordpress(
  page: Page,
  title: string,
  htmlContent: string,
  nickname?: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  // Minimize browser
  try {
    const cdpMain = await page.context().newCDPSession(page);
    const { windowId } = await cdpMain.send('Browser.getWindowForTarget');
    await cdpMain.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdpMain.detach().catch(() => {});
  } catch { /* ignore */ }

  // Resolve blog URL from accounts
  const accounts = getWordpressAccounts();
  const account = nickname
    ? accounts.find(a => a.nickname?.toLowerCase() === nickname.toLowerCase())
    : accounts.find(a => a.active);
  const blogUrl = account?.blogUrl || 'https://wordpress.com';

  // Inject WordPress UTM into all kenresearch.com links
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.WordPress);

  // Navigate directly to post-new.php if the account has a specific blog domain,
  // otherwise fall back to homepage + New Post click.
  const isSpecificBlog = blogUrl !== 'https://wordpress.com' && blogUrl.includes('wordpress.com');
  if (isSpecificBlog) {
    const editorUrl = `${blogUrl}/wp-admin/post-new.php?post_type=post&`;
    console.log(`   Navigating directly to editor: ${editorUrl}`);
    await gotoWithRetry(page, editorUrl, 'wordpress.com');
    // If redirected to login, wait for user / session to kick in
    if (page.url().includes('/log-in') || page.url().includes('/wp-login')) {
      console.log('   ⏳ Detected login redirect — waiting 20 seconds for session...');
      await sleep(20000);
      await gotoWithRetry(page, editorUrl, 'wordpress.com');
    }
    console.log(`   ✅ Editor URL: ${page.url()}`);
    console.log('   ⏳ Waiting 6 seconds for editor to fully load...');
    await sleep(6000);
  } else {
    // Navigate to blog homepage (admin bar lives here)
    console.log(`   Navigating to blog: ${blogUrl}`);
    await gotoWithRetry(page, blogUrl, 'wordpress.com');

    // Step 1: If landed on login page, click Continue
    if (page.url().includes('/log-in')) {
      console.log('   Detected login page — clicking Continue...');
      await sleep(CLICK_DELAY);
      await jsClick(page, 'a.continue-as-user__continue-button');
      await sleep(5000);
      console.log('   ✅ Clicked Continue');
    }

    // Step 2: Click "New Post" in admin bar — retry until URL slug shows post-new.php
    console.log('   Clicking New Post in admin bar...');
    const NEW_POST_SELECTORS = [
      'a[href*="/wp-admin/post-new.php"]',
      'a[href="/wp-admin/post-new.php?post_type=post"]',
      'a.ab-item[href*="post-new.php"]',
    ];
    const MAX_NEW_POST_TRIES = 5;
    let editorOpen = false;
    for (let attempt = 1; attempt <= MAX_NEW_POST_TRIES; attempt++) {
      await sleep(CLICK_DELAY);
      let clicked = false;
      for (const sel of NEW_POST_SELECTORS) {
        const exists = await page.$(sel).then(el => !!el).catch(() => false);
        if (exists) {
          await jsClick(page, sel);
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        console.log(`   ⚠️ New Post link not found (try ${attempt}/${MAX_NEW_POST_TRIES})`);
      }
      try {
        await page.waitForURL(/\/wp-admin\/post-new\.php/, { timeout: 8000 });
        editorOpen = true;
        console.log(`   ✅ Editor URL reached on try ${attempt}: ${page.url()}`);
        break;
      } catch {
        console.log(`   ⚠️ URL still ${page.url()} — retrying New Post click (${attempt}/${MAX_NEW_POST_TRIES})`);
      }
    }
    if (!editorOpen) {
      throw new Error(`Failed to open New Post editor after ${MAX_NEW_POST_TRIES} tries. Current URL: ${page.url()}`);
    }
    console.log('   ⏳ Waiting 6 seconds for editor to fully load...');
    await sleep(6000);
  }

  // Step 3: Click title field and type
  console.log('   Typing title...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'h1[aria-label="Add title"]');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(title).trim(), { delay: 50 });
  console.log('   ✅ Title typed');

  // Step 4: Render HTML in temp page → copy to clipboard
  console.log('   Rendering HTML in temp page...');
  try {
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(300);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
      console.log('   ✅ HTML rendered and copied to clipboard');
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not render/copy HTML: ${err.message}`);
  }

  // Step 5: Click editor body and paste
  console.log('   Clicking editor content area and pasting...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'span[data-rich-text-placeholder="Type / to choose a block"]');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');

  // Step 6: Click first Publish button (opens pre-publish panel)
  console.log('   Clicking first Publish button...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.editor-post-publish-panel__toggle.editor-post-publish-button__button.is-primary');
  console.log('   ✅ Pre-publish panel opened');

  // Step 7: Click Upload button
  console.log('   Clicking Upload button...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.components-button.is-primary.is-compact');
  console.log('   ✅ Clicked Upload — waiting 5 seconds...');
  await sleep(5000);

  // Step 8: Click final Publish button
  console.log('   Clicking final Publish button...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.editor-post-publish-button.editor-post-publish-button__button.is-primary');
  console.log('   ✅ Published');

  // Step 9: Click "Add these tags"
  console.log('   Clicking Add these tags...');
  await sleep(CLICK_DELAY);
  await jsClick(page, 'button.wpcom-block-editor-post-published-recommended-tags-modal__save-tags.is-primary');
  console.log('   ✅ Tags added — waiting 5 seconds...');
  await sleep(5000);

  // Step 10: Get post URL — try "View Post" link first, then Copy button + clipboard
  console.log('   Waiting 7 seconds for post-publish panel...');
  await sleep(7000);

  let postUrl = '';

  // Primary: grab href from "View Post" link in post-publish panel
  try {
    const viewPostLink = await page.$('a.post-publish-panel__postpublish-buttons-link, a[href*="wordpress.com"]:has-text("View Post"), a.components-button[href*="://"]:has-text("View Post")');
    if (viewPostLink) {
      postUrl = (await viewPostLink.getAttribute('href')) || '';
      console.log(`   ✅ Post URL from View Post link: ${postUrl}`);
    }
  } catch { /* try next method */ }

  // Secondary: Copy button + clipboard
  if (!postUrl || postUrl === 'about:blank') {
    console.log('   Clicking Copy button...');
    const copyClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button.components-button'));
      const target = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'copy') as HTMLElement | undefined;
      if (target) { target.click(); return true; }
      return false;
    });
    if (!copyClicked) {
      await jsClick(page, 'button.components-button.is-next-40px-default-size.is-secondary');
    }
    await sleep(1000);
    try {
      postUrl = await page.evaluate(() => navigator.clipboard.readText());
    } catch {
      try {
        const { execSync } = await import('child_process');
        postUrl = execSync('powershell -command Get-Clipboard', { timeout: 5000 }).toString().trim();
      } catch { /* will fall through to DOM search */ }
    }
  }

  // Tertiary: search all links in page for a wordpress.com post URL
  if (!postUrl || postUrl === 'about:blank') {
    try {
      postUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
        const match = links.find(a => /wordpress\.com\/.+\/\d{4}\//.test(a.href) || /wordpress\.com\/p=/.test(a.href));
        return match?.href || '';
      });
    } catch { /* ignore */ }
  }

  // Final fallback
  if (!postUrl || postUrl === 'about:blank') postUrl = page.url();
  console.log(`   ✅ Post URL: ${postUrl}`);

  return {
    success: true,
    postUrl,
    postText: htmlContent,
    postedAt: new Date(),
  };
}
