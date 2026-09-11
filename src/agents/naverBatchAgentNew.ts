/**
 * naverBatchAgentNew.ts — Naver Blog Batch Posting Agent
 * Posts sequentially, reads account name from each row.
 *
 * Content Format: HTML (from "Blog Content for all" column)
 * Updates sheet with: Naver Post URL, status, batch label, last posted date
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface NaverBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
  }>;
}

export async function runNaverBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<NaverBatchResult> {
  const result: NaverBatchResult = { posted: 0, failed: 0, results: [] };

  for (const row of params.rows) {
    const accountName = row.name;
    const contentHtml = row.blogContent || '';
    const title = row.title || '';

    if (!accountName) {
      result.results.push({ nickname: 'unknown', success: false, error: 'No account name (row.name) found' });
      result.failed++;
      continue;
    }
    if (!contentHtml) {
      result.results.push({ nickname: accountName, success: false, error: 'No Blog Content (HTML) found in row' });
      result.failed++;
      continue;
    }
    if (!title) {
      result.results.push({ nickname: accountName, success: false, error: 'No title found in row' });
      result.failed++;
      continue;
    }

    const postResult = await postToNaverAccount(accountName, title, contentHtml);
    result.results.push({ nickname: accountName, ...postResult });
    if (postResult.success) result.posted++;
    else result.failed++;

    await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

async function postToNaverAccount(
  accountName: string,
  title: string,
  contentHtml: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    const loginResult = await executeBrowserTool('login_naver', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Naver login failed' };
    }
    const postResult = await executeBrowserTool('post_naver', { title, htmlContent: contentHtml });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
