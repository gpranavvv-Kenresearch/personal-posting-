/**
 * xPostingAgent.ts — X (Twitter) Posting Agent
 * Handles posting content to X/Twitter platform
 * Wraps the existing twitter/poster.ts logic
 */

import { getAccountByHandle } from '../config/accounts.js';
import { loginToX, closeBrowser } from '../browser/twitter/login.js';
import { postTweet } from '../browser/twitter/poster.js';
import { xAccountHasCapacity, incrementCount as incrementXCount } from '../config/accountTracker.js';
import { saveLastPosted } from '../sheets/sheets.js';
import { humanDelay } from '../browser/stagehand.js';
import { startPopupGuard, clearPopups } from '../browser/popupGuard.js';

export interface XPostingResult {
  postUrl: string;
  status: 'success' | 'failed';
  error?: string;
}

const MAX_POST_RETRIES = 3;

/**
 * Post content to X/Twitter
 * @param content Tweet content (max 280 chars)
 * @param accountName Account nickname to post from
 * @returns Posting result with URL
 */
export async function postTweetToX(content: string, accountName: string): Promise<XPostingResult> {
  try {
    console.log(`   🐦 Posting to X as @${accountName}: "${content.substring(0, 50)}..."`);

    // Check capacity
    if (!xAccountHasCapacity(accountName)) {
      return {
        postUrl: '',
        status: 'failed',
        error: `Daily X limit reached for ${accountName}`,
      };
    }

    // Get account credentials
    const xAccount = getAccountByHandle(accountName);
    if (!xAccount) {
      return {
        postUrl: '',
        status: 'failed',
        error: `Account not found: ${accountName}`,
      };
    }

    // Login to X
    let page: any;
    let stopGuard: (() => void) | null = null;
    let lastError = '';

    try {
      page = await loginToX(xAccount);
      stopGuard = startPopupGuard(page);
    } catch (err: any) {
      await closeBrowser();
      return {
        postUrl: '',
        status: 'failed',
        error: `Login failed: ${err.message}`,
      };
    }

    // Retry logic for posting
    for (let attempt = 1; attempt <= MAX_POST_RETRIES; attempt++) {
      try {
        // Clear popups and wait
        await clearPopups(page).catch(() => {});
        await humanDelay(2000, 4000);

        // Post tweet
        const result = await postTweet(page, content, xAccount.handle);

        // Increment counter
        incrementXCount('x', accountName);
        stopGuard?.();
        await closeBrowser().catch(() => {});

        console.log(`   ✅ Posted to X: ${result.tweetUrl}`);

        return {
          postUrl: result.tweetUrl,
          status: 'success',
        };
      } catch (err: any) {
        lastError = err.message;
        console.log(`   🔁 X post attempt ${attempt}/${MAX_POST_RETRIES} failed: ${lastError}`);

        if (attempt < MAX_POST_RETRIES) {
          // Clear and retry
          await clearPopups(page).catch(() => {});
          await humanDelay(3000, 5000);
          await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
          await humanDelay(2000, 3000);
          await clearPopups(page).catch(() => {});
        }
      }
    }

    // All retries failed
    stopGuard?.();
    await closeBrowser().catch(() => {});

    return {
      postUrl: '',
      status: 'failed',
      error: `Failed after ${MAX_POST_RETRIES} attempts: ${lastError}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ X posting failed: ${errorMsg}`);

    return {
      postUrl: '',
      status: 'failed',
      error: errorMsg,
    };
  }
}

/**
 * Post to X and update sheet with result
 * @param content Tweet content
 * @param accountName Account nickname
 * @param rowIndex Sheet row index (for updating lastPostedX)
 * @param today ISO date string (YYYY-MM-DD)
 * @returns Result with postUrl
 */
export async function postTweetAndSaveResult(
  content: string,
  accountName: string,
  rowIndex: number,
  today: string
): Promise<XPostingResult> {
  const result = await postTweetToX(content, accountName);

  if (result.status === 'success') {
    // Update lastPostedX in sheet
    try {
      await saveLastPosted(rowIndex, 'x', today);
      console.log(`   📝 Updated lastPostedX for row ${rowIndex}`);
    } catch (err) {
      console.warn(`   ⚠️  Could not update lastPostedX: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Batch post to X for multiple pieces of content
 * @param posts Array of { content, accountName } to post
 * @returns Array of results
 */
export async function batchPostToX(
  posts: Array<{ content: string; accountName: string }>
): Promise<XPostingResult[]> {
  const results: XPostingResult[] = [];

  for (const post of posts) {
    const result = await postTweetToX(post.content, post.accountName);
    results.push(result);

    // Small delay between posts to avoid rate limiting
    await new Promise(r => setTimeout(r, 2000));
  }

  return results;
}
