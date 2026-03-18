import { Page } from 'playwright';
import { humanDelay } from '../stagehand.js';
import 'dotenv/config';

export async function postToLinkedIn(
  page: Page,
  postText: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  console.log('   Navigating to LinkedIn feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 3000);

  // Click the "Start a post" trigger
  console.log('   Opening post composer...');
  const startPostSelector = 'button.share-box-feed-entry__trigger, [placeholder*="Start a post"]';
  await page.waitForSelector(startPostSelector, { timeout: 15000 });
  await page.click(startPostSelector);
  await humanDelay(1500, 2500);

  // The rich-text editor inside the post modal
  const editorSelector = '.ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]';
  await page.waitForSelector(editorSelector, { timeout: 10000 });
  await page.click(editorSelector);
  await humanDelay(800, 1200);

  console.log('   Typing post...');
  await page.keyboard.type(postText, { delay: 60 });
  await humanDelay(1500, 2500);

  // Click the Post button (blue, primary action)
  console.log('   Clicking Post...');
  const postButton = page.locator(
    'button.share-actions__primary-action, button[data-control-name="share.post"]',
  );
  await postButton.waitFor({ timeout: 10000 });
  await postButton.click();
  await humanDelay(5000, 7000);

  // Grab the newest post URL from the profile activity
  console.log('   Fetching post URL...');
  const { getActiveLinkedInAccount } = await import('./login.js');
  const liAccount = getActiveLinkedInAccount();
  const profileUrl = liAccount?.profileUrl || process.env.LINKEDIN_PROFILE_URL || 'https://www.linkedin.com/in/me/recent-activity/shares/';
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 3000);

  const postUrl = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"], a[href*="feed/update/"]'),
    );
    return links.length > 0 ? links[0].href : 'https://www.linkedin.com/feed/';
  });

  return {
    success: true,
    postUrl,
    postText,
    postedAt: new Date(),
  };
}
