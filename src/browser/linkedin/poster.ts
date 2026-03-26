import { Page } from 'playwright';
import { execSync } from 'child_process';

const CRITICAL_TIMEOUT_MS = 30_000;

async function waitForCriticalLocator(
  page: Page,
  selector: string,
  description: string,
  timeout = CRITICAL_TIMEOUT_MS,
): Promise<{ success: boolean; locator: any; message: string }> {
  try {
    await page.waitForSelector(selector, { timeout });
    return { success: true, locator: page.locator(selector).first(), message: '' };
  } catch {
    const message = `${description} not found within ${timeout / 1000}s (selector: ${selector}).`;
    console.error(`   ❌ ${message}`);
    return { success: false, locator: null, message };
  }
}

export async function postToLinkedIn(
  page: Page,
  postText: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  console.log('   Navigating to LinkedIn feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });

  // Wait for feed
  try {
    await page.waitForSelector('div.feed-shared-update-v2', { timeout: 20_000 });
    console.log('   ✅ Feed loaded');
  } catch {
    console.warn('   ⚠️  Feed load timeout, continuing...');
  }

  // ── Click "Start a post" ──────────────────────────────────────────────────
  console.log('   Looking for post composer button...');
  const postButtonSelectors = [
    'button.share-box-feed-entry__trigger',
    'button[aria-label*="Start a post"]',
    'button:has-text("Start a post")',
    'div[role="button"]:has-text("Start a post")',
  ];

  let buttonFound = false;
  for (const selector of postButtonSelectors) {
    const btn = await page.$(selector);
    if (btn) {
      console.log(`   ✅ Found post button: ${selector}`);
      await btn.click();
      await page.waitForTimeout(5000);   // allow composer to fully open
      buttonFound = true;
      break;
    }
  }

  if (!buttonFound) {
    throw new Error("Could not find 'Start a post' button — LinkedIn UI may have changed");
  }

  // ── Wait for textbox composer ─────────────────────────────────────────────
  try {
    await page.waitForSelector('div[role="textbox"]', { timeout: 20_000 });
    console.log('   ✅ Composer ready');
  } catch {
    throw new Error("LinkedIn composer (div[role='textbox']) not found");
  }

  // ── Paste content via clipboard ───────────────────────────────────────────
  console.log('   Pasting post content...');
  const composer = page.locator('div[role="textbox"]').first();
  await composer.click();

  // Write content to clipboard then paste — preserves newlines and special chars
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, postText);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(1500);

  // ── Find exact "Post" button ──────────────────────────────────────────────
  console.log('   Searching for Post button...');
  const buttons = await page.$$('button');
  let postButton: any = null;
  for (const btn of buttons) {
    const label = (await btn.innerText().catch(() => '')).trim();
    if (label === 'Post') {
      postButton = btn;
      break;
    }
  }

  if (!postButton) {
    throw new Error("'Post' button not found — LinkedIn UI may have changed");
  }

  console.log('   Clicking Post...');
  await postButton.click({ delay: 100 });

  // Dismiss any modal that appears
  await page.waitForTimeout(2000);
  const dismissSelectors = [
    'button[aria-label="Dismiss"]',
    'button[data-test-modal-close-btn]',
    'button.artdeco-modal__dismiss',
  ];
  for (const sel of dismissSelectors) {
    try {
      const dismissBtn = await page.$(sel);
      if (dismissBtn) {
        console.log(`   Dismissing modal: ${sel}`);
        await dismissBtn.click({ delay: 100 });
        await page.waitForTimeout(1000);
        break;
      }
    } catch { /* ignore */ }
  }

  // ── Wait for "Send" button ────────────────────────────────────────────────
  // LinkedIn renders this as an <a> tag, not a <button>
  console.log('   Waiting for Send button...');
  const sendSelectors = [
    'a:has(svg[id="send-privately-small"])',   // most specific — targets the SVG id
    'a:has-text("Send")',                       // fallback anchor
    'button[aria-label="Send in a private message"]',
    'button:has-text("Send")',
  ];
  let sendWait = { success: false, locator: null as any, message: '' };
  for (const sel of sendSelectors) {
    sendWait = await waitForCriticalLocator(page, sel, 'Send button', 10_000);
    if (sendWait.success) break;
  }
  if (!sendWait.success) {
    throw new Error(`Send button not found: ${sendWait.message}`);
  }

  console.log('   Clicking Send...');
  await sendWait.locator.click({ delay: 150 });

  // ── Wait for "Copy link to post" ──────────────────────────────────────────
  console.log('   Waiting for "Copy link to post"...');
  const copySelectors = [
    'button:has-text("Copy link to post")',
    'a:has-text("Copy link to post")',
    'span:has-text("Copy link to post")',
    'div[role="button"]:has-text("Copy link to post")',
  ];
  let copyWait = { success: false, locator: null as any, message: '' };
  for (const sel of copySelectors) {
    copyWait = await waitForCriticalLocator(page, sel, 'Copy link to post button', 10_000);
    if (copyWait.success) break;
  }
  if (!copyWait.success) {
    throw new Error(`Copy link button not found: ${copyWait.message}`);
  }

  console.log('   Clicking "Copy link to post"...');
  await copyWait.locator.click({ delay: 150 });

  // ── Read clipboard (Windows) ──────────────────────────────────────────────
  let postUrl = '';
  try {
    postUrl = execSync('powershell -command Get-Clipboard').toString().trim();
    console.log(`   ✅ Post URL: ${postUrl}`);
  } catch (err: any) {
    console.warn(`   ⚠️  Clipboard read failed: ${err.message}`);
    postUrl = 'https://www.linkedin.com/feed/';
  }

  return {
    success: true,
    postUrl,
    postText,
    postedAt: new Date(),
  };
}
