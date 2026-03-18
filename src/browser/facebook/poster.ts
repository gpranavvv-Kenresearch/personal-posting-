import { Page } from 'playwright';
import { humanDelay } from '../stagehand.js';
import 'dotenv/config';

export async function postToFacebook(
  page: Page,
  postText: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  console.log('   Navigating to Facebook home...');
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 3000);

  // Click the "What's on your mind?" composer button — try multiple selectors
  console.log('   Opening post composer...');
  const composerSelectors = [
    '[aria-label*="What\'s on your mind"]',
    '[aria-placeholder*="What\'s on your mind"]',
    '[placeholder*="What\'s on your mind"]',
    'div[role="button"]:has-text("What\'s on your mind")',
    'span:has-text("What\'s on your mind")',
  ];

  let opened = false;
  for (const sel of composerSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      await page.click(sel);
      opened = true;
      console.log(`   Composer opened with: ${sel}`);
      break;
    } catch {
      // try next selector
    }
  }
  if (!opened) throw new Error('Could not find Facebook post composer. Page may have changed.');
  await humanDelay(1500, 2500);

  // The actual editable area in the post dialog
  const textAreaSelector = '[contenteditable="true"][role="textbox"]';
  await page.waitForSelector(textAreaSelector, { timeout: 15000 });
  await page.click(textAreaSelector);
  await humanDelay(800, 1200);

  console.log('   Typing post...');
  await page.keyboard.type(postText, { delay: 60 });
  await humanDelay(1500, 2500);

  // Click the Post button inside the dialog
  console.log('   Clicking Post...');
  const postButton = page.getByRole('button', { name: /^Post$/ });
  await postButton.waitFor({ timeout: 10000 });
  await postButton.click();
  await humanDelay(5000, 7000);

  // Get post URL via Share → Copy Link on the freshly posted item
  console.log('   Fetching post URL via Share button...');
  let postUrl = 'https://www.facebook.com/';

  try {
    // The newest post appears at the top of the feed — find its Share button
    const shareBtn = page.locator('[aria-label="Send this to friends or post it on your profile."]').first();
    await shareBtn.waitFor({ timeout: 10000 });
    await shareBtn.click();
    await humanDelay(1000, 1500);

    // Click "Copy link" in the popup
    const copyLinkBtn = page.getByRole('menuitem', { name: /copy link/i })
      .or(page.getByText(/copy link/i).first());
    await copyLinkBtn.waitFor({ timeout: 5000 });
    await copyLinkBtn.click();
    await humanDelay(800, 1200);

    // Read from clipboard
    postUrl = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    if (!postUrl || !postUrl.includes('facebook.com')) {
      postUrl = 'https://www.facebook.com/';
    }
    console.log(`   Post URL: ${postUrl}`);
  } catch {
    console.log('   Could not get post URL via Share button — using fallback');
  }

  return {
    success: true,
    postUrl,
    postText,
    postedAt: new Date(),
  };
}
