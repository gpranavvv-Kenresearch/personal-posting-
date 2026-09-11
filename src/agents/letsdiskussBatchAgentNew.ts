/**
 * letsdiskussBatchAgentNew.ts — Letsdiskuss Batch Posting Agent
 * Posts from Letsdiskuss accounts SEQUENTIALLY (reads account name from each row).
 *
 * Content Format: HTML (from "Blog Content for all" column in sheet)
 * Updates sheet with: Letsdiskuss Post URL, status, batch label, last posted date
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import { saveUnifiedLetsdiskussResult } from '../sheets/sheets.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface LetsdiskussBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
  }>;
}

export async function runLetsdiskussBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<LetsdiskussBatchResult> {
  const result: LetsdiskussBatchResult = { posted: 0, failed: 0, results: [] };
  const batchLabel = `Batch ${params.batchNum}`;

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
      await saveUnifiedLetsdiskussResult(row, { postUrl: '', status: 'failed', error: 'No blog content', batch: batchLabel });
      continue;
    }
    if (!title) {
      result.results.push({ nickname: accountName, success: false, error: 'No title found in row' });
      result.failed++;
      await saveUnifiedLetsdiskussResult(row, { postUrl: '', status: 'failed', error: 'No title', batch: batchLabel });
      continue;
    }

    const postResult = await postToLetsdiskussAccount(accountName, title, contentHtml);
    result.results.push({ nickname: accountName, ...postResult });

    await saveUnifiedLetsdiskussResult(row, {
      postUrl: postResult.postUrl ?? '',
      status: postResult.success ? 'posted' : 'failed',
      error: postResult.error,
      batch: batchLabel,
    });

    if (postResult.success) result.posted++;
    else result.failed++;

    await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

async function postToLetsdiskussAccount(
  accountName: string,
  title: string,
  contentHtml: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    console.log(`   [postToLetsdiskussAccount] Login for: ${accountName}`);
    const loginResult = await executeBrowserTool('login_letsdiskuss', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Letsdiskuss login failed' };
    }

    console.log(`   [postToLetsdiskussAccount] Posting...`);
    const postResult = await executeBrowserTool('post_letsdiskuss', { title, htmlContent: contentHtml });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
