import { executeBrowserTool } from '../tools/browserTools.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface ParagraphBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
  }>;
}

export async function runParagraphBatchAgent(params: {
  rows: SheetRow[];
  batchNum: number;
}): Promise<ParagraphBatchResult> {
  const result: ParagraphBatchResult = { posted: 0, failed: 0, results: [] };

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

    const postResult = await postToParagraphAccount(accountName, title, contentHtml);
    result.results.push({ nickname: accountName, ...postResult });
    if (postResult.success) result.posted++;
    else result.failed++;

    await new Promise(r => setTimeout(r, 1000));
  }

  return result;
}

async function postToParagraphAccount(
  accountName: string,
  title: string,
  contentHtml: string,
): Promise<{ success: boolean; postUrl?: string; error?: string }> {
  try {
    console.log(`   [postToParagraphAccount] Logging in as: ${accountName}`);
    const loginResult = await executeBrowserTool('login_paragraph', { nickname: accountName });
    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'Paragraph login failed' };
    }
    console.log(`   [postToParagraphAccount] Posting to Paragraph...`);
    const postResult = await executeBrowserTool('post_paragraph', { title, htmlContent: contentHtml });
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
