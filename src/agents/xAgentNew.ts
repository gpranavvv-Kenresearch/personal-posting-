/**
 * xAgentNew.ts — X Posting Agent (Direct Playwright)
 * Posts tweet to X and retrieves URL — no AI API required
 */

import { executeBrowserTool } from '../tools/browserTools.js';

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

  // Step 2: Post tweet
  const postResult = await executeBrowserTool('post_tweet', {
    tweetText: params.tweetText,
    handle: params.accountHandle,
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
