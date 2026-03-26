/**
 * browserTools.ts — Browser Automation Tools
 * Wraps all 6 browser scripts (login + posting for X, FB, LI)
 *
 * Key design: Page objects stored in module-level variables
 * since they cannot be serialized across Claude tool boundaries
 */

import { loginToX, closeBrowser } from '../browser/twitter/login.js';
import { postTweet } from '../browser/twitter/poster.js';
import { loginToFacebook, closeFacebookBrowser } from '../browser/facebook/login.js';
import { postToFacebook } from '../browser/facebook/poster.js';
import { loginToLinkedIn, closeLinkedInBrowser } from '../browser/linkedin/login.js';
import { postToLinkedIn } from '../browser/linkedin/poster.js';
import { getAccountByHandle } from '../config/accounts.js';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import type { Page } from 'playwright';

// Module-level page state
let xPage: Page | null = null;
let fbPage: Page | null = null;
let liPage: Page | null = null;

export const BROWSER_TOOLS: Tool[] = [
  {
    name: 'login_x',
    description: 'Login to X (Twitter) with account credentials',
    input_schema: {
      type: 'object' as const,
      properties: {
        accountHandle: { type: 'string', description: 'X account handle (e.g., "vansh")' },
      },
      required: ['accountHandle'],
    },
  },
  {
    name: 'post_tweet',
    description: 'Post a tweet to X. Must call login_x first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweetText: { type: 'string', description: 'Tweet text (≤280 chars)' },
        handle: { type: 'string', description: 'X account handle' },
      },
      required: ['tweetText', 'handle'],
    },
  },
  {
    name: 'login_facebook',
    description: 'Login to Facebook with account credentials',
    input_schema: {
      type: 'object' as const,
      properties: {
        nickname: { type: 'string', description: 'Facebook account nickname' },
      },
      required: ['nickname'],
    },
  },
  {
    name: 'post_facebook',
    description: 'Post to Facebook. Must call login_facebook first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        postText: { type: 'string', description: 'Facebook post text' },
      },
      required: ['postText'],
    },
  },
  {
    name: 'login_linkedin',
    description: 'Login to LinkedIn with account credentials',
    input_schema: {
      type: 'object' as const,
      properties: {
        nickname: { type: 'string', description: 'LinkedIn account nickname' },
      },
      required: ['nickname'],
    },
  },
  {
    name: 'post_linkedin',
    description: 'Post to LinkedIn. Must call login_linkedin first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        postText: { type: 'string', description: 'LinkedIn post text' },
      },
      required: ['postText'],
    },
  },
];

/**
 * Execute browser tools
 */
export async function executeBrowserTool(toolName: string, input: Record<string, any>): Promise<any> {
  try {
    if (toolName === 'login_x') {
      return await loginXTool(input.accountHandle);
    }
    if (toolName === 'post_tweet') {
      return await postTweetTool(input.tweetText, input.handle);
    }
    if (toolName === 'login_facebook') {
      return await loginFbTool(input.nickname);
    }
    if (toolName === 'post_facebook') {
      return await postFbTool(input.postText);
    }
    if (toolName === 'login_linkedin') {
      return await loginLiTool(input.nickname);
    }
    if (toolName === 'post_linkedin') {
      return await postLiTool(input.postText);
    }
    return { error: `Unknown tool: ${toolName}`, success: false };
  } catch (err: any) {
    return { error: err.message || String(err), success: false };
  }
}

/**
 * X Tools
 */
async function loginXTool(accountHandle: string): Promise<any> {
  try {
    const account = getAccountByHandle(accountHandle);
    if (!account) {
      return { error: `Account "${accountHandle}" not found`, success: false };
    }

    xPage = await loginToX(account);
    return { success: true, message: `Logged in to @${account.handle}` };
  } catch (err: any) {
    xPage = null;
    return { error: err.message, success: false };
  }
}

async function postTweetTool(tweetText: string, handle: string): Promise<any> {
  try {
    if (!xPage) {
      return { error: 'Not logged in. Call login_x first.', success: false };
    }

    const result = await postTweet(xPage, tweetText, handle);
    return { success: true, tweetUrl: result.tweetUrl, tweetText };
  } catch (err: any) {
    return { error: err.message, success: false };
  } finally {
    if (xPage) {
      try {
        await closeBrowser(xPage);
      } catch (e) {
        console.warn('Failed to close X browser:', e);
      }
      xPage = null;
    }
  }
}

/**
 * Facebook Tools
 */
async function loginFbTool(nickname: string): Promise<any> {
  try {
    fbPage = await loginToFacebook(nickname);
    return { success: true, message: `Logged in to Facebook (${nickname})` };
  } catch (err: any) {
    fbPage = null;
    return { error: err.message, success: false };
  }
}

async function postFbTool(postText: string): Promise<any> {
  try {
    if (!fbPage) {
      return { error: 'Not logged in. Call login_facebook first.', success: false };
    }

    const postUrl = await postToFacebook(fbPage, postText);
    return { success: true, postUrl, postText };
  } catch (err: any) {
    return { error: err.message, success: false };
  } finally {
    if (fbPage) {
      try {
        await closeFacebookBrowser(fbPage);
      } catch (e) {
        console.warn('Failed to close FB browser:', e);
      }
      fbPage = null;
    }
  }
}

/**
 * LinkedIn Tools
 */
async function loginLiTool(nickname: string): Promise<any> {
  try {
    liPage = await loginToLinkedIn(nickname);
    return { success: true, message: `Logged in to LinkedIn (${nickname})` };
  } catch (err: any) {
    liPage = null;
    return { error: err.message, success: false };
  }
}

async function postLiTool(postText: string): Promise<any> {
  try {
    if (!liPage) {
      return { error: 'Not logged in. Call login_linkedin first.', success: false };
    }

    const postUrl = await postToLinkedIn(liPage, postText);
    return { success: true, postUrl, postText };
  } catch (err: any) {
    return { error: err.message, success: false };
  } finally {
    if (liPage) {
      try {
        await closeLinkedInBrowser(liPage);
      } catch (e) {
        console.warn('Failed to close LI browser:', e);
      }
      liPage = null;
    }
  }
}

/**
 * Get current page state (for debugging)
 */
export function getPageState(): { x: boolean; fb: boolean; li: boolean } {
  return {
    x: xPage !== null,
    fb: fbPage !== null,
    li: liPage !== null,
  };
}

/**
 * Force close all browsers (cleanup)
 */
export async function closeAllBrowsers(): Promise<void> {
  if (xPage) {
    try {
      await closeBrowser(xPage);
    } catch (e) {}
    xPage = null;
  }
  if (fbPage) {
    try {
      await closeFacebookBrowser(fbPage);
    } catch (e) {}
    fbPage = null;
  }
  if (liPage) {
    try {
      await closeLinkedInBrowser(liPage);
    } catch (e) {}
    liPage = null;
  }
}
