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

  console.log('   Pasting post...');
  await page.keyboard.insertText(postText);
  await humanDelay(1500, 2500);

  // Click the Post button inside the dialog — try multiple selectors
  console.log('   Clicking Post...');
  const postBtnSelectors = [
    page.getByRole('button', { name: /^post$/i }),
    page.getByRole('button', { name: /^share now$/i }),
    page.getByRole('button', { name: /^share$/i }),
  ];

  let posted = false;
  for (const btn of postBtnSelectors) {
    try {
      await btn.waitFor({ timeout: 5000 });
      await btn.click();
      posted = true;
      break;
    } catch { /* try next */ }
  }
  if (!posted) throw new Error('Could not find Post/Share button in Facebook composer dialog.');

  // Wait 8 seconds for post to publish
  console.log('   Waiting 8s for post to publish...');
  await humanDelay(8000, 8000);

  let postUrl = '';

  // Strategy 1: find permalink from feed — timestamp <a> links to the post
  console.log('   Extracting post URL from feed...');
  try {
    postUrl = await page.evaluate((): string => {
      // Facebook post timestamps are <a> tags whose href is the post permalink
      const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      for (const a of links) {
        const href = a.href || '';
        if (
          (href.includes('/posts/') || href.includes('story_fbid') || href.includes('/permalink/')) &&
          href.includes('facebook.com')
        ) {
          return href.split('?')[0]; // strip query params
        }
      }
      return '';
    });
    if (postUrl) console.log(`   ✅ Permalink found in DOM: ${postUrl}`);
  } catch { /* fall through */ }

  // Strategy 2: Share button → Copy link (clipboard)
  if (!postUrl) {
    const getShareUrl = async (): Promise<string> => {
      const shareSelectors = [
        'div[aria-label="Send this to friends or post it on your profile."][role="button"]',
        'div[aria-label*="Share"][role="button"]',
        'span[aria-label*="Share"]',
      ];
      for (const sel of shareSelectors) {
        try {
          await page.locator(sel).first().click({ timeout: 3000 });
          break;
        } catch { /* try next */ }
      }
      await humanDelay(1000, 1500);
      await page.locator('span:has-text("Copy link")').first().click({ timeout: 5000 });
      await humanDelay(800, 1000);
      return await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`   Trying Share → Copy link (attempt ${attempt}/3)...`);
        const copied = await getShareUrl();
        if (copied && (copied.includes('/posts/') || copied.includes('story_fbid') || copied.includes('facebook.com'))) {
          postUrl = copied;
          console.log(`   ✅ URL from clipboard: ${postUrl}`);
          break;
        }
        await humanDelay(2000, 3000);
      } catch (err: any) {
        console.log(`   ⚠️ Attempt ${attempt} failed: ${err.message?.slice(0, 80)}`);
        await humanDelay(2000, 3000);
      }
    }
  }

  console.log(`   Post URL: ${postUrl || '(not captured)'}`);

  // Post was published even if URL capture failed — return success with whatever URL we have
  return {
    success: true,
    postUrl: postUrl || 'https://www.facebook.com/',
    postText,
    postedAt: new Date(),
  };
}
