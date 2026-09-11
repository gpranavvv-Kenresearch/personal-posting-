/**
 * seoTools.ts — SEO Analysis Tools
 * Wraps SerpAPI and Tavily for Claude agent tool use
 */

import { callSerpApi } from '../config/serpApiClient.js';
import { callTavily } from '../config/tavilyClient.js';
import type { Tool } from './browserTools.js';

export interface SerpApiResult {
  ranking: number;
  indexed: boolean;
  organic_results?: any[];
  error?: string;
}

export interface TavilyResult {
  answer?: string;
  results?: Array<{ title: string; url: string; content: string }>;
  error?: string;
}

export const SEO_TOOLS: Tool[] = [
  {
    name: 'search_google',
    description: 'Search Google via SerpAPI to check URL ranking and indexing status. Returns the position in search results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query (URL or topic keywords)',
        },
        num_results: {
          type: 'string',
          description: 'Number of results to return (default 100)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_tavily',
    description: 'Search trending keywords and content via Tavily API. Returns recent articles and insights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query for trending keywords',
        },
        search_depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description: 'Search depth: basic (faster) or advanced (comprehensive)',
        },
        max_results: {
          type: 'string',
          description: 'Max results to return (default 5)',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * Execute SEO tools for Claude agent
 */
export async function executeSeoTool(toolName: string, input: Record<string, any>): Promise<any> {
  try {
    if (toolName === 'search_google') {
      return await searchGoogle(input.query, input.num_results);
    }
    if (toolName === 'search_tavily') {
      return await searchTavily(input.query, input.search_depth, input.max_results);
    }
    return { error: `Unknown tool: ${toolName}` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

/**
 * Search Google via SerpAPI
 */
async function searchGoogle(query: string, numResults?: string): Promise<SerpApiResult> {
  try {
    const num = numResults ? parseInt(numResults, 10) : 100;
    const result = await callSerpApi({
      engine: 'google',
      q: query,
      num,
    });

    if (!result || result.error) {
      return { ranking: 999, indexed: false, error: result?.error || 'No results' };
    }

    const organicResults = result.organic_results || [];
    let ranking = 999;
    let indexed = false;

    // Find the URL in results
    if (query.includes('http')) {
      // Query is a URL — find exact match
      for (let i = 0; i < organicResults.length; i++) {
        const url = organicResults[i].link || '';
        if (url.includes(new URL(query).hostname)) {
          ranking = (i + 1) * 10; // rough page estimate
          indexed = true;
          break;
        }
      }
    } else {
      // Query is a topic — return top results
      ranking = organicResults.length > 0 ? 1 : 999;
      indexed = organicResults.length > 0;
    }

    return {
      ranking,
      indexed,
      organic_results: organicResults.slice(0, 10),
    };
  } catch (err: any) {
    return { ranking: 999, indexed: false, error: err.message };
  }
}

/**
 * Search Tavily for trending keywords
 */
async function searchTavily(
  query: string,
  searchDepth?: string,
  maxResults?: string,
): Promise<TavilyResult> {
  try {
    const depth = (searchDepth === 'advanced' ? 'advanced' : 'basic') as 'basic' | 'advanced';
    const max = maxResults ? parseInt(maxResults, 10) : 5;

    const result = await callTavily({
      query,
      search_depth: depth,
      include_answer: true,
      max_results: max,
    });

    return {
      answer: result.answer,
      results: result.results,
    };
  } catch (err: any) {
    return { error: err.message };
  }
}
