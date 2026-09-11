/**
 * fbBatchAgentNew.ts — Facebook Batch Posting Agent
 * Posts from 15 FB accounts SEQUENTIALLY (not parallel)
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import { getAccounts } from '../config/accounts.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface FbBatchResult {
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
 * Run FB batch posting (sequential, 15 accounts)
 */
export async function runFbBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<FbBatchResult> {
  const fbAccounts = getAccounts()
    .filter(a => a.active)
    .slice(0, 15); // Take first 15 active accounts

  const result: FbBatchResult = {
    posted: 0,
    failed: 0,
    results: [],
  };

  // Process each account sequentially with its corresponding row
  for (let i = 0; i < Math.min(fbAccounts.length, params.rows.length); i++) {
    const account = fbAccounts[i];
    const row = params.rows[i];

    const postResult = await postToFbAccount(account.nickname || account.handle, row.fbPost || '');

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
    if (i < fbAccounts.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return result;
}

/**
 * Post to single FB account — direct tool calls, no LLM
 */
async function postToFbAccount(nickname: string, postText: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_facebook', { nickname });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Login failed' };
    }
    const postResult = await executeBrowserTool('post_facebook', { nickname, postText });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
