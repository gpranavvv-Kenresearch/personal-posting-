/**
 * liBatchAgentNew.ts — LinkedIn Batch Posting Agent
 * Posts from 15 LI accounts SEQUENTIALLY (not parallel)
 */

import Anthropic from '@anthropic-ai/sdk';
import { BROWSER_TOOLS, executeBrowserTool } from '../tools/browserTools.js';
import { getAccounts } from '../config/accounts.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';
import type { SheetRow } from '../sheets/sheets.js';

const MODEL = 'claude-opus-4-1';

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

    const postResult = await postToLiAccount(account.nickname || account.handle, row.liPost || '');

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
 * Post to single LI account
 */
async function postToLiAccount(nickname: string, postText: string): Promise<{
  success: boolean;
  postUrl?: string;
  error?: string;
}> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const systemPrompt = `You are a LinkedIn posting specialist. Post the given text to LinkedIn.

Steps:
1. Call login_linkedin with the account nickname
2. Call post_linkedin with the post text
3. Return result as JSON

Return format: { "success": boolean, "postUrl": string or null, "error": string or null }`;

  const userPrompt = `Post this to LinkedIn account (${nickname}):

"${postText}"

Return ONLY JSON with the result.`;

  let messages: MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: BROWSER_TOOLS,
        messages,
      });

      if (response.stop_reason === 'end_turn') {
        return parseLiResult(response.content);
      }

      const toolUses = response.content.filter(b => b.type === 'tool_use');
      if (toolUses.length === 0) {
        return parseLiResult(response.content);
      }

      messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Execute tools
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: JSON.stringify(
            await executeBrowserTool(tu.name, tu.input as Record<string, any>),
          ),
        })),
      );

      messages.push({
        role: 'user',
        content: toolResults,
      });

      // Check if successful
      if (toolResults.some(r => JSON.parse(r.content).success)) {
        const finalResponse = await client.messages.create({
          model: MODEL,
          max_tokens: 512,
          system: systemPrompt,
          tools: BROWSER_TOOLS,
          messages,
        });

        return parseLiResult(finalResponse.content);
      }
    }

    return { success: false, error: 'Failed to post to LinkedIn' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Parse LI result
 */
function parseLiResult(content: any[]): {
  success: boolean;
  postUrl?: string;
  error?: string;
} {
  const textContent = content.find(b => b.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    return { success: false, error: 'No response' };
  }

  try {
    const text = textContent.text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'Could not parse response' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      success: parsed.success ?? false,
      postUrl: parsed.postUrl,
      error: parsed.error,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
