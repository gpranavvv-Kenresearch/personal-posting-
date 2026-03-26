/**
 * contentTools.ts — Content Generation Tools
 * Wraps content generation and sanity checking
 */

import { generateTweetFromSheetRow, generateFacebookPost, generateLinkedInPost, generateBlogFromKen } from '../agents/contentGenerator.js';
import { runSanityCheck } from '../agents/sanityAgent.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { SheetRow, SanityCheckResult } from '../sheets/sheets.js';
import type { BatchContext } from '../agents/sanityAgent.js';

export const CONTENT_TOOLS: Tool[] = [
  {
    name: 'generate_tweet',
    description: 'Generate a tweet for an X post (280 chars max)',
    input_schema: {
      type: 'object' as const,
      properties: {
        targetUrl: { type: 'string', description: 'URL to post about' },
        title: { type: 'string', description: 'Report title' },
        marketValue: { type: 'string', description: 'Market value/context' },
      },
      required: ['targetUrl'],
    },
  },
  {
    name: 'generate_facebook_post',
    description: 'Generate a Facebook post (conversational, emoji-friendly)',
    input_schema: {
      type: 'object' as const,
      properties: {
        targetUrl: { type: 'string', description: 'URL to post about' },
        title: { type: 'string', description: 'Report title' },
        marketValue: { type: 'string', description: 'Market value/context' },
      },
      required: ['targetUrl'],
    },
  },
  {
    name: 'generate_linkedin_post',
    description: 'Generate a LinkedIn post (professional, B2B tone)',
    input_schema: {
      type: 'object' as const,
      properties: {
        targetUrl: { type: 'string', description: 'URL to post about' },
        title: { type: 'string', description: 'Report title' },
        marketValue: { type: 'string', description: 'Market value/context' },
      },
      required: ['targetUrl'],
    },
  },
  {
    name: 'generate_blog_post',
    description: 'Generate a blog post (600-800 words, in-depth)',
    input_schema: {
      type: 'object' as const,
      properties: {
        targetUrl: { type: 'string', description: 'URL to post about' },
        title: { type: 'string', description: 'Report title' },
      },
      required: ['targetUrl'],
    },
  },
  {
    name: 'run_sanity_check',
    description: 'Validate tweet content (14 checks: length, URL, hashtags, spam, duplicates, etc.)',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet: { type: 'string', description: 'Tweet text to validate' },
        rowJson: { type: 'string', description: 'SheetRow as JSON string' },
        batchCtxJson: { type: 'string', description: 'BatchContext as JSON string (optional)' },
      },
      required: ['tweet', 'rowJson'],
    },
  },
];

/**
 * Execute content tools for Claude agent
 */
export async function executeContentTool(toolName: string, input: Record<string, any>): Promise<any> {
  try {
    if (toolName === 'generate_tweet') {
      return await generateTweet(input.targetUrl, input.title, input.marketValue);
    }
    if (toolName === 'generate_facebook_post') {
      return await generateFbPost(input.targetUrl, input.title, input.marketValue);
    }
    if (toolName === 'generate_linkedin_post') {
      return await generateLiPost(input.targetUrl, input.title, input.marketValue);
    }
    if (toolName === 'generate_blog_post') {
      return await generateBlog(input.targetUrl, input.title);
    }
    if (toolName === 'run_sanity_check') {
      return await sanitizeTweet(input.tweet, input.rowJson, input.batchCtxJson);
    }
    return { error: `Unknown tool: ${toolName}` };
  } catch (err: any) {
    return { error: err.message || String(err) };
  }
}

/**
 * Generate tweet
 */
async function generateTweet(url: string, title?: string, marketValue?: string): Promise<any> {
  try {
    const tweet = await generateTweetFromSheetRow({
      targetUrl: url,
      title: title || '',
      marketValue: marketValue || '',
      batch: 0,
      date: new Date().toISOString().split('T')[0],
      name: '',
      rowIndex: 0,
    } as SheetRow);

    return { tweet, success: true };
  } catch (err: any) {
    return { error: err.message, success: false };
  }
}

/**
 * Generate Facebook post
 */
async function generateFbPost(url: string, title?: string, marketValue?: string): Promise<any> {
  try {
    const post = await generateFacebookPost(url, title, marketValue);
    return { fbPost: post, success: true };
  } catch (err: any) {
    return { error: err.message, success: false };
  }
}

/**
 * Generate LinkedIn post
 */
async function generateLiPost(url: string, title?: string, marketValue?: string): Promise<any> {
  try {
    const post = await generateLinkedInPost(url, title, marketValue);
    return { liPost: post, success: true };
  } catch (err: any) {
    return { error: err.message, success: false };
  }
}

/**
 * Generate blog post
 */
async function generateBlog(url: string, title?: string): Promise<any> {
  try {
    if (!title) {
      return { error: 'Title required for blog generation', success: false };
    }
    const result = await generateBlogFromKen(url, title);
    return { blog: result.blog, success: true };
  } catch (err: any) {
    return { error: err.message, success: false };
  }
}

/**
 * Run sanity check
 */
async function sanitizeTweet(
  tweet: string,
  rowJson: string,
  batchCtxJson?: string,
): Promise<any> {
  try {
    const row = JSON.parse(rowJson) as SheetRow;
    let batchCtx: BatchContext | undefined;
    if (batchCtxJson) {
      const parsed = JSON.parse(batchCtxJson);
      batchCtx = {
        seenUrls: new Set(parsed.seenUrls || []),
        seenTexts: parsed.seenTexts || [],
      };
    }

    const result = await runSanityCheck(tweet, row, batchCtx);

    return {
      valid: result.valid,
      issues: result.issues,
      sanitized: result.sanitized,
    };
  } catch (err: any) {
    return { error: err.message, valid: false };
  }
}
