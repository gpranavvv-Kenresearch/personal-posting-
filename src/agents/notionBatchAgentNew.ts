/**
 * notionBatchAgentNew.ts — Notion Batch Posting Agent
 * Posts sequentially, reads account name from each row.
 *
 * Content Format: HTML (from "Blog Content for all" column)
 * Updates sheet with: Notion Post URL, status, batch label, last posted date
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface NotionBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
  }>;
}

export async function runNotionBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<NotionBatchResult> {
  const result: NotionBatchResult = { posted: 0, failed: 0, results: [] };

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

    const postResult = await postToNotionAccount(accountName, title, contentHtml);
    result.results.push({ nickname: accountName, ...postResult });
    if (postResult.success) result.posted++;
    else result.failed++;

    await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

async function postToNotionAccount(
  accountName: string,
  title: string,
  contentHtml: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`   🔁 Notion retry attempt ${attempt + 1} for ${accountName}...`);
        await new Promise(r => setTimeout(r, 3000));
      }
      const loginResult = await executeBrowserTool('login_notion', { nickname: accountName });
      if (!loginResult.success) {
        lastError = loginResult.error || 'Notion login failed';
        continue;
      }
      const postResult = await executeBrowserTool('post_notion', { title, htmlContent: contentHtml });
      if (postResult.success) {
        return { success: true, postUrl: postResult.postUrl };
      }
      lastError = postResult.error || 'post_notion returned failure';
    } catch (err: any) {
      lastError = err.message;
    }
  }
  return { success: false, error: lastError };
}
