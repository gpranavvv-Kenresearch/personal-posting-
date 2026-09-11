/**
 * liBatchAgentNew.ts — LinkedIn Batch Posting Agent
 * Posts from 15 LI accounts SEQUENTIALLY (not parallel)
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import { getAccounts } from '../config/accounts.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface LiBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
  }>;
}

/**
 * Run LI batch posting (sequential, 15 accounts)
 */
export async function runLiBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<LiBatchResult> {
  const liAccounts = getAccounts()
    .filter(a => a.active)
    .slice(0, 15); // Take first 15 active accounts

  const result: LiBatchResult = {
    posted: 0,
    failed: 0,
    results: [],
  };

  // Process each account sequentially with its corresponding row
  for (let i = 0; i < Math.min(liAccounts.length, params.rows.length); i++) {
    const account = liAccounts[i];
    const row = params.rows[i];

    const pdfPath = (row.imagesUrl || '').trim();
    const postResult = pdfPath
      ? await postToLiAccountCarousel(account.nickname || account.handle, row.linkedinPost || '', pdfPath)
      : await postToLiAccount(account.nickname || account.handle, row.linkedinPost || '');

    result.results.push({
      nickname: account.nickname || account.handle,
      success: postResult.success,
      postUrl: postResult.postUrl,
      error: postResult.error,
    });

    if (postResult.success) {
      result.posted++;
    } else {
      result.failed++;
    }

    // Small delay between account posts
    if (i < liAccounts.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return result;
}

/**
 * Post to single LI account with carousel PDF
 */
async function postToLiAccountCarousel(nickname: string, postText: string, pdfPath: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    console.log(`   [Carousel] PDF path: ${pdfPath}`);
    const loginResult = await executeBrowserTool('login_linkedin', { nickname });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Login failed' };
    }
    const postResult = await executeBrowserTool('post_linkedin_carousel', { nickname, postText, pdfPath });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Post to single LI account — direct tool calls, no LLM
 */
async function postToLiAccount(nickname: string, postText: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_linkedin', { nickname });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Login failed' };
    }
    const postResult = await executeBrowserTool('post_linkedin', { nickname, postText });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
