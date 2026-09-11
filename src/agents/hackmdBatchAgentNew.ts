/**
 * hackmdBatchAgentNew.ts — HackMD Batch Posting Agent
 *
 * Posting strategy (per account):
 *   1. PRIMARY  — HackMD REST API (fast, no browser needed)
 *   2. FALLBACK — Browser automation via saved Playwright session
 *
 * Content Format: HTML (from "Blog Content for all" column in sheet)
 * Updates sheet with: HackMD Post URL, status, batch label, last posted date
 */

import { executeBrowserTool } from '../tools/browserTools.js';
import { postToHackMDApi } from '../browser/hackmd/apiPoster.js';
import { getHackMDAccounts } from '../browser/hackmd/login.js';
import type { SheetRow } from '../sheets/sheets.js';

export interface HackMDBatchResult {
  posted: number;
  failed: number;
  results: Array<{
    nickname: string;
    success: boolean;
    postUrl?: string;
    error?: string;
    method?: 'api' | 'browser';
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
): Promise<{ success: boolean; postUrl?: string; error?: string; method?: 'api' | 'browser' }> {

  // ── 1. Try API first ────────────────────────────────────────────────────────
  const apiKey = getApiKeyForAccount(accountName);

  if (apiKey) {
    console.log(`   [${accountName}] Trying HackMD API...`);
    const apiResult = await postToHackMDApi(apiKey, title, contentHtml);

    if (apiResult.success) {
      console.log(`   [${accountName}] ✅ Posted via API`);
      return { success: true, postUrl: apiResult.postUrl, method: 'api' };
    }

    console.warn(`   [${accountName}] API failed: ${apiResult.error} — falling back to browser`);
  } else {
    console.warn(`   [${accountName}] No API key found — falling back to browser`);
  }

  // ── 2. Fallback: browser automation ────────────────────────────────────────
  try {
    console.log(`   [${accountName}] Trying browser session...`);
    const loginResult = await executeBrowserTool('login_hackmd', { nickname: accountName });

    if (!loginResult.success) {
      return { success: false, error: loginResult.error || 'HackMD login failed', method: 'browser' };
    }

    const postResult = await executeBrowserTool('post_hackmd', { title, htmlContent: contentHtml });
    console.log(`   [${accountName}] ✅ Posted via browser`);
    return {
      success: postResult.success ?? false,
      postUrl: postResult.postUrl,
      error: postResult.error,
      method: 'browser',
    };
  } catch (err: any) {
    console.error(`   [${accountName}] Browser fallback also failed: ${err.message}`);
    return { success: false, error: err.message, method: 'browser' };
  }
}

function getApiKeyForAccount(nickname: string): string | null {
  try {
    const accounts = getHackMDAccounts();
    const account = accounts.find(
      a => a.nickname?.toLowerCase() === nickname.toLowerCase()
        || a.username?.toLowerCase() === nickname.toLowerCase()
        || a.email?.toLowerCase() === nickname.toLowerCase(),
    );
    return (account as any)?.apiKey || null;
  } catch {
    return null;
  }
}
