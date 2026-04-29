import { Page } from 'playwright';
import { humanDelay } from '../stagehand.js';
import 'dotenv/config';

// ── Character counter ──────────────────────────────────────────────────────
// Reads the X composer counter (e.g. "-2" means 2 chars over the limit).

async function getCharCounter(page: Page): Promise<number | null> {
  try {
    const el = page.locator(
      'div.css-146c3p1.r-n6v787.r-1l4fgox.r-285fr0.r-q4m81j.r-9l7dzd'
    ).first();
    const visible = await el.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) return null;
    const text = (await el.innerText()).trim();
    const num = parseInt(text, 10);
    return isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

// ── Content trimmer ────────────────────────────────────────────────────────
// Removes exactly `charsToRemove` characters from the editable portion of a
// tweet (working from the end), leaving URLs and hashtags untouched.

function trimTweetContent(text: string, charsToRemove: number): string {
  const protectedPattern = /(https?:\/\/\S+|#\w+)/g;

  // Split into alternating [editable, protected, editable, ...] segments
  const segments: Array<{ text: string; isProtected: boolean }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = protectedPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ text: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isProtected: false });
  }

  // Remove chars from editable segments, working from the end
  let toRemove = charsToRemove;
  for (let i = segments.length - 1; i >= 0 && toRemove > 0; i--) {
    if (segments[i].isProtected) continue;
    const seg = segments[i].text;
    if (seg.length <= toRemove) {
      toRemove -= seg.length;
      segments[i] = { text: '', isProtected: false };
    } else {
      segments[i] = { text: seg.slice(0, seg.length - toRemove).trimEnd(), isProtected: false };
      toRemove = 0;
    }
  }

  return segments.map(s => s.text).join('').trimEnd();
}

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

async function openTweetComposer(page: Page, xHandle: string): Promise<void> {
  const inlineComposer = page.locator('[data-testid="tweetTextarea_0"]').first();
  if (await inlineComposer.isVisible({ timeout: 8000 }).catch(() => false)) {
    await inlineComposer.click();
    return;
  }

  const composeTriggers = [
    page.locator('[data-testid="SideNav_NewTweet_Button"]').first(),
    page.locator('a[href="/compose/tweet"]').first(),
    page.getByRole('link', { name: /^post$/i }).first(),
    page.getByRole('button', { name: /^post$/i }).first(),
  ];

  for (const trigger of composeTriggers) {
    if (await trigger.isVisible({ timeout: 2000 }).catch(() => false)) {
      await trigger.click({ force: true });
      await humanDelay(1000, 1500);
      break;
    }
  }

  const composer = page.locator('[data-testid="tweetTextarea_0"], div[role="textbox"][contenteditable="true"]').first();
  if (await composer.isVisible({ timeout: 10000 }).catch(() => false)) {
    await composer.click();
    return;
  }

  throw new Error(`LOGIN_REQUIRED:${xHandle} — account not logged in or X composer not available. Run: npm run dev -- save-x-session ${xHandle}`);
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
  await openTweetComposer(page, xHandle);
  await humanDelay(1000, 1500);

  console.log('   Pasting tweet...');
  await page.keyboard.insertText(tweetText);
  await humanDelay(800, 1200);

  // Check character counter — if over limit, abort and signal for regeneration
  const counter = await getCharCounter(page);
  if (counter !== null && counter < 0) {
    const excess = Math.abs(counter);
    console.log(`   ⚠️ Tweet over limit by ${excess} chars — signalling for regeneration`);
    // Clear the composer before leaving
    await page.keyboard.press('Control+A');
    await humanDelay(200, 300);
    await page.keyboard.press('Backspace');
    throw new Error(`TWEET_OVER_LIMIT:${excess}`);
  }

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
  await humanDelay(3000, 3000);

  // Get tweet URL via Share → Copy link.
  // If share button not found the tweet is still POSTED — return success with empty URL.
  let tweetUrl = '';

  const getShareUrl = async (): Promise<string> => {
    const shareBtn = page.locator('button[aria-label="Share post"]').first();
    await shareBtn.waitFor({ timeout: 5000 });
    await shareBtn.click({ force: true });
    await humanDelay(2000, 3000);

    const copyLink = page.locator('span.css-1jxf684').filter({ hasText: 'Copy link' }).first();
    await copyLink.waitFor({ timeout: 3000 });
    await copyLink.click({ force: true });
    await humanDelay(800, 1000);

    return await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`   Clicking Share post → Copy link (attempt ${attempt}/5)...`);
      const clip = await getShareUrl();
      tweetUrl = clip.startsWith('http') ? clip : '';
      if (tweetUrl) break;
      console.log(`   ⚠️ Could not read tweet URL — retrying...`);
      await humanDelay(2000, 3000);
    } catch (err: any) {
      console.log(`   ⚠️ Attempt ${attempt} failed: ${err.message?.slice(0, 80)}`);
      await humanDelay(2000, 3000);
    }
  }

  console.log(tweetUrl ? `   Tweet URL: ${tweetUrl}` : '   ⚠️ Share button not found — tweet posted but URL not captured');
  return { success: true, tweetUrl, tweetText, postedAt: new Date() };
}

export async function postThread(page: Page, tweets: string[], handle?: string) {
  const xHandle = handle || process.env.X_HANDLE!;

  if (!tweets.length) throw new Error('postThread: tweets array is empty');

  // Diagnostic: log char count of each tweet
  tweets.forEach((t, i) => console.log(`   Tweet ${i + 1}: ${t.length} chars`));

  console.log(`   Navigating to home (thread: ${tweets.length} tweets)...`);
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 3000);

  await dismissPopups(page).catch(() => {});
  await humanDelay(500, 800);

  console.log('   Opening tweet composer...');
  await openTweetComposer(page, xHandle);
  await humanDelay(1000, 1500);

  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];

    // Focus the correct textarea for this slot
    const textareaSel = `[data-testid="tweetTextarea_${i}"]`;
    const textarea = page.locator(textareaSel).first();
    await textarea.waitFor({ state: 'visible', timeout: 10000 });
    await textarea.click();
    await humanDelay(500, 800);

    console.log(`   Typing tweet ${i + 1}/${tweets.length}...`);
    await page.keyboard.insertText(tweet);
    await humanDelay(800, 1200);

    // If not the last tweet — click Add post button to open next slot
    if (i < tweets.length - 1) {
      const addBtn = page.locator('[data-testid="addButton"]').last();
      await addBtn.waitFor({ state: 'visible', timeout: 8000 });
      await addBtn.click();
      await humanDelay(1000, 1500);
    }
  }

  // Blur the textarea so the Post button becomes fully interactive
  await page.keyboard.press('Escape');
  await humanDelay(500, 800);
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await humanDelay(800, 1200);

  // Diagnostic: log Post button state
  const btnState = await page.evaluate(() => {
    const btns = document.querySelectorAll('[data-testid="tweetButton"]');
    const last = btns[btns.length - 1] as HTMLElement | undefined;
    if (!last) return 'NO BUTTON FOUND';
    return `count=${btns.length} aria-disabled=${last.getAttribute('aria-disabled')} disabled=${last.hasAttribute('disabled')} text="${last.innerText}"`;
  });
  console.log(`   Post button state: ${btnState}`);

  console.log('   Clicking Post all (thread)...');

  const isPosted = async () => {
    const composer = page.locator('[data-testid="tweetTextarea_0"]');
    return !(await composer.isVisible({ timeout: 1500 }).catch(() => false));
  };

  // 1. Real mouse click via bounding box — most reliable for React buttons
  const btn = page.locator('[data-testid="tweetButton"]').last();
  const box = await btn.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await humanDelay(200, 400);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    console.log('   Tried real mouse click on tweetButton...');
    await humanDelay(2000, 3000);
  }

  if (await isPosted()) {
    console.log('   ✅ Posted via mouse click');
  } else {
    // 2. Playwright force click
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded();
      await btn.click({ force: true });
      console.log('   Tried Playwright force click...');
      await humanDelay(2000, 3000);
    }

    if (await isPosted()) {
      console.log('   ✅ Posted via force click');
    } else {
      // 3. Ctrl+Enter
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      console.log('   Tried Ctrl+Enter...');
      await humanDelay(2000, 3000);

      if (await isPosted()) {
        console.log('   ✅ Posted via Ctrl+Enter');
      } else {
        // 4. Shift+Enter last resort
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        console.log('   Tried Shift+Enter...');
        await humanDelay(2000, 3000);
        console.log(await isPosted() ? '   ✅ Posted via Shift+Enter' : '   ⚠️ Post may not have gone through');
      }
    }
  }
  await humanDelay(3000, 4000);

  // Get URL of the first tweet (thread root)
  let tweetUrl = '';
  const getShareUrl = async (): Promise<string> => {
    const shareBtn = page.locator('button[aria-label="Share post"]').first();
    await shareBtn.waitFor({ timeout: 5000 });
    await shareBtn.click({ force: true });
    await humanDelay(2000, 3000);
    const copyLink = page.locator('span.css-1jxf684').filter({ hasText: 'Copy link' }).first();
    await copyLink.waitFor({ timeout: 3000 });
    await copyLink.click({ force: true });
    await humanDelay(800, 1000);
    return await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  };

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`   Getting thread URL (attempt ${attempt}/5)...`);
      const clip = await getShareUrl();
      tweetUrl = clip.startsWith('http') ? clip : '';
      if (tweetUrl) break;
      await humanDelay(2000, 3000);
    } catch (err: any) {
      console.log(`   ⚠️ Attempt ${attempt} failed: ${err.message?.slice(0, 80)}`);
      await humanDelay(2000, 3000);
    }
  }

  console.log(tweetUrl ? `   Thread URL: ${tweetUrl}` : '   ⚠️ Thread posted but URL not captured');
  return { success: true, tweetUrl, tweetText: tweets[0], postedAt: new Date() };
}
