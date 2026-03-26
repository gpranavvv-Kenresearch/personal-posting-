/**
 * seoAgentNew.ts — SEO Analysis Agent (Claude AI Loop)
 * Checks Google ranking and decides posting priority (P1/P2/P3)
 *
 * Replaces old seoAgent.ts which used direct OpenRouter calls
 */

import Anthropic from '@anthropic-ai/sdk';
import { SEO_TOOLS, executeSeoTool } from '../tools/seoTools.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js';

const MODEL = 'claude-opus-4-1';
const MAX_TOOL_CALLS = 10;

export type Platform = 'x' | 'facebook' | 'linkedin';

export interface SeoAnalysisResult {
  indexStatus: 'indexed' | 'not_indexed' | 'unknown';
  rankPage: number; // 1-100+
  seoRanking: number; // 1-100+
  keywords: string[];
  platforms: Platform[];
  priority: 'P1' | 'P2' | 'P3'; // P1: 1-30 rank, P2: 31-69, P3: 70+
  seoScore?: number;
}

/**
 * Run SEO analysis via Claude AI
 */
export async function runSeoAnalysis(
  targetUrl: string,
  title?: string,
): Promise<SeoAnalysisResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const systemPrompt = `You are an SEO analyst. Your job is to check Google ranking for a URL and decide which social platforms to post to.

Steps:
1. Use search_google to check if the URL is indexed and its ranking position
2. Use search_tavily to find trending keywords related to the topic
3. Analyze the ranking and assign a priority level:
   - P1 (rank 1-30): indexed on page 1-2 → post every day (all platforms: X + FB + LI)
   - P2 (rank 31-69): indexed on page 3-4 → post alternate days (all platforms)
   - P3 (rank 70+ or not indexed): → post 2x/week (all platforms)
4. Return a JSON object with the analysis

Always include:
- indexStatus: "indexed" | "not_indexed" | "unknown"
- rankPage: numeric ranking
- seoRanking: 1-100 scale
- keywords: array of 3-5 keywords
- platforms: ["x", "facebook", "linkedin"]
- priority: "P1" | "P2" | "P3"`;

  const userPrompt = `Analyze this report URL for Google ranking and assign posting priority:
URL: ${targetUrl}
Title: ${title || '(no title)'}

Use the search tools to check indexing status and ranking, then return ONLY a JSON object with no other text.`;

  let messages: MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  let toolCallCount = 0;

  while (toolCallCount < MAX_TOOL_CALLS) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      tools: SEO_TOOLS,
      messages,
    });

    // Check if done
    if (response.stop_reason === 'end_turn') {
      return parseResult(response.content);
    }

    // Handle tool use
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      return parseResult(response.content);
    }

    messages.push({
      role: 'assistant',
      content: response.content,
    });

    toolCallCount += toolUses.length;

    // Execute tools
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => ({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: JSON.stringify(
          await executeSeoTool(tu.name, tu.input as Record<string, any>),
        ),
      })),
    );

    messages.push({
      role: 'user',
      content: toolResults,
    });
  }

  throw new Error('SEO analysis exceeded max tool calls');
}

/**
 * Parse result from Claude response
 */
function parseResult(content: any[]): SeoAnalysisResult {
  const textContent = content.find(b => b.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from SEO agent');
  }

  // Extract JSON from text
  const text = textContent.text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse JSON from SEO agent response');
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    indexStatus: parsed.indexStatus || 'unknown',
    rankPage: parsed.rankPage || 999,
    seoRanking: parsed.seoRanking || parsed.rankPage || 999,
    keywords: parsed.keywords || [],
    platforms: parsed.platforms || ['x'],
    priority: parsed.priority || 'P3',
  };
}

/**
 * SEO optimize (preserved from old agent for backward compatibility)
 * This is NOT replaced by Claude loop - kept as direct function
 */
export async function runSeoOptimize(
  tweetText: string,
  keywords?: string[],
): Promise<{ optimizedTweet: string; seoScore: number }> {
  // TODO: implement if needed
  // For now, return tweet as-is
  return {
    optimizedTweet: tweetText,
    seoScore: 85,
  };
}
