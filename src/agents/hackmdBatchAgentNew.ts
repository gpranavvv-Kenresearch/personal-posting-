/**
 * hackmdBatchAgentNew.ts — HackMD Batch Posting Agent
 * Posts from HackMD accounts SEQUENTIALLY (reads account name from each row).
 *
 * Content Format: HTML (from "Blog Content for all" column in sheet)
 * Updates sheet with: HackMD Post URL, status, batch label, last posted date
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface HackMDBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
  }>;
}

export async function runHackMDBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<HackMDBatchResult> {
  const result: HackMDBatchResult = { posted: 0, failed: 0, results: [] };

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

    const postResult = await postToHackMDAccount(accountName, title, contentHtml);
    result.results.push({ nickname: accountName, ...postResult });
    if (postResult.success) result.posted++;
    else result.failed++;

    await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

async function postToHackMDAccount(
  accountName: string,
  title: string,
  contentHtml: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    console.log(`   [postToHackMDAccount] Calling login_hackmd for: ${accountName}`);
    const loginResult = await executeBrowserTool('login_hackmd', { nickname: accountName });
    console.log(`   [postToHackMDAccount] Login result:`, loginResult);

    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'HackMD login failed' };
    }

    console.log(`   [postToHackMDAccount] Calling post_hackmd...`);
    const postResult = await executeBrowserTool('post_hackmd', { title, htmlContent: contentHtml });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    console.log(`   [postToHackMDAccount] Exception caught:`, err.message);
    return { success: false, error: err.message };
  }
}
