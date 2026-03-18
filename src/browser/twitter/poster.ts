import { Page } from 'playwright';
import { humanDelay } from '../stagehand.js';
import 'dotenv/config';

// ── Popup dismissal ────────────────────────────────────────────────────────
// Silently closes any modal/overlay that X shows on page load before posting.

async function dismissPopups(page: Page): Promise<void> {
  await humanDelay(1500, 2000);

  const popups = [
    { selector: '[data-testid="confirmationSheetConfirm"]',       label: 'consent confirm' },
    { selector: '[data-testid="confirmationSheetCancel"]',         label: 'notification decline' },
    { selector: '[data-testid="sheetDialog"] [aria-label="Close"]',label: 'sheet dialog close' },
    { selector: 'div[role="dialog"] [aria-label="Close"]',         label: 'dialog close' },
    { selector: '[data-testid="app-bar-close"]',                   label: 'app bar close' },
  ];

  for (const popup of popups) {
    try {
      const el = page.locator(popup.selector).first();
      const visible = await el.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        console.log(`   🚫 Dismissing popup: ${popup.label}`);
        await el.click({ force: true });
        await humanDelay(500, 800);
      }
    } catch {
      // Popup not present — continue
    }
  }
}

export async function postTweet(page: Page, tweetText: string, handle?: string) {
  const xHandle = handle || process.env.X_HANDLE!;

  console.log('   Navigating to home...');
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 3000);

  // Dismiss any popups before interacting with the composer
  await dismissPopups(page).catch(() => {});
  await humanDelay(500, 800);

  console.log('   Opening tweet composer...');
  await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
  await page.click('[data-testid="tweetTextarea_0"]');
  await humanDelay(1000, 1500);

  console.log('   Pasting tweet...');
  await page.evaluate((t) => navigator.clipboard.writeText(t), tweetText);
  await page.keyboard.press('Control+v');
  await humanDelay(800, 1200);

  console.log('   Clicking Post...');
  // Use keyboard shortcut to post — most reliable method
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await humanDelay(1000, 1500);

  // Fallback — click the black Post button directly
  const postButton = page.getByRole('button', { name: 'Post', exact: true });
  if (await postButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await postButton.click({ force: true });
  }
  await humanDelay(4000, 6000);

  console.log('   Fetching tweet URL...');
  await page.goto(`https://x.com/${xHandle}`, { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 3000);

  const tweetUrl = await page.evaluate((handle) => {
    const links = Array.from(document.querySelectorAll(`a[href*="/${handle}/status/"]`));
    return links.length > 0 ? (links[0] as HTMLAnchorElement).href : `https://x.com/${handle}`;
  }, xHandle);

  return {
    success: true,
    tweetUrl,
    tweetText,
    postedAt: new Date(),
  };
}
