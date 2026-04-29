/**
 * substackBatchAgentNew.ts — Substack Batch Posting Agent
 * Posts from Substack accounts SEQUENTIALLY (reads account name from each row).
 *
 * Content Format: HTML (from "Blog Content for all" column in sheet)
 * Updates sheet with: Substack Post URL, status, batch label, last posted date
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface SubstackBatchResult {
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
 * Run Substack batch posting (sequential, reads account name from each row)
 */
export async function runSubstackBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<SubstackBatchResult> {
  const result: SubstackBatchResult = { posted: 0, failed: 0, results: [] };

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

    const postResult = await postToSubstackAccount(accountName, title, contentHtml);
    result.results.push({ nickname: accountName, ...postResult });
    if (postResult.success) result.posted++;
    else result.failed++;

    await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

async function postToSubstackAccount(
  accountName: string,
  title: string,
  contentHtml: string,
): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  try {
    const loginResult = await executeBrowserTool('login_substack', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Substack login failed' };
    }

    const postResult = await executeBrowserTool('post_substack', { title, htmlContent: contentHtml });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
