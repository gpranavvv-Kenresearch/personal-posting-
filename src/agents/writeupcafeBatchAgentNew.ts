/**
 * writeupcafeBatchAgentNew.ts — WriteupCafe Batch Posting Agent
 * Posts from WriteupCafe accounts SEQUENTIALLY (reads account name from each row).
 *
 * Content Format: HTML (from "Blog Content for all" column in sheet)
 * Updates sheet with: WriteupCafe Post URL, status, batch label, last posted date
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface WriteupCafeBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
  }>;
}

export async function runWriteupCafeBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<WriteupCafeBatchResult> {
  const result: WriteupCafeBatchResult = { posted: 0, failed: 0, results: [] };

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

    const postResult = await postToWriteupCafeAccount(accountName, title, contentHtml, row.description, row.seedKeyword);
    result.results.push({ nickname: accountName, ...postResult });
    if (postResult.success) result.posted++;
    else result.failed++;

    await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

async function postToWriteupCafeAccount(
  accountName: string,
  title: string,
  contentHtml: string,
  description?: string,
  seedKeyword?: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    console.log(`   [postToWriteupCafeAccount] Calling login_writeupcafe for: ${accountName}`);
    const loginResult = await executeBrowserTool('login_writeupcafe', { nickname: accountName });
    console.log(`   [postToWriteupCafeAccount] Login result:`, loginResult);

    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'WriteupCafe login failed' };
    }

    console.log(`   [postToWriteupCafeAccount] Calling post_writeupcafe...`);
    const postResult = await executeBrowserTool('post_writeupcafe', {
      title,
      htmlContent: contentHtml,
      description,
      seedKeyword,
    });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    console.log(`   [postToWriteupCafeAccount] Exception caught:`, err.message);
    return { success: false, error: err.message };
  }
}
