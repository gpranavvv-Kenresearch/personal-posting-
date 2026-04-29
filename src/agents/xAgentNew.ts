/**
 * xAgentNew.ts — X Posting Agent (Direct Playwright)
 * Posts tweet to X and retrieves URL — no AI API required
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import { getAccountByHandle } from '../config/accounts.js';

export interface XAgentResult {
  success: boolean;
  tweetUrl?: string;
  tweetText: string;
  seoScore?: number;
  sanityIssues?: string[];
  error?: string;
}

/**
 * Run X posting directly via Playwright (no AI loop)
 */
export async function runXThreadAgent(params: {
  tweets: string[];
  accountHandle: string;
}): Promise<XAgentResult> {
  const loginResult = await executeBrowserTool('login_x', { accountHandle: params.accountHandle });
  if (!loginResult.success) {
    return { success: false, tweetText: params.tweets[0] ?? '', error: loginResult.error ?? 'Login failed' };
  }

  const account = getAccountByHandle(params.accountHandle);
  const realHandle = account?.handle || params.accountHandle;

  const postResult = await executeBrowserTool('post_thread', {
    tweets: params.tweets,
    handle: realHandle,
  });

  return postResult.success
    ? { success: true, tweetText: params.tweets[0], tweetUrl: postResult.tweetUrl }
    : { success: false, tweetText: params.tweets[0], error: postResult.error ?? 'Thread post failed' };
}

export async function runXAgent(params: {
  tweetText: string;
  accountHandle: string;
  seoScore?: number;
  sanityIssues?: string[];
}): Promise<XAgentResult> {
  const base = {
    tweetText: params.tweetText,
    seoScore: params.seoScore,
    sanityIssues: params.sanityIssues,
  };

  // Step 1: Login
  const loginResult = await executeBrowserTool('login_x', {
    accountHandle: params.accountHandle,
  });

  if (!loginResult.success) {
    return { ...base, success: false, error: loginResult.error ?? 'Login failed' };
  }

  // Step 2: Post tweet — use real X handle (not nickname) for URL scan
  const account = getAccountByHandle(params.accountHandle);
  const realHandle = account?.handle || params.accountHandle;

  const postResult = await executeBrowserTool('post_tweet', {
    tweetText: params.tweetText,
    handle: realHandle,
  });

  if (!postResult.success) {
    return { ...base, success: false, error: postResult.error ?? 'Post failed' };
  }

  return {
    ...base,
    success: true,
    tweetUrl: postResult.tweetUrl,
  };
}
