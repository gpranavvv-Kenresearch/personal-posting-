/**
 * postToLinkedin.ts — CLI intervention tool for Claude
 *
 * Called by Claude CLI when the main npm run dev LinkedIn poster fails.
 *
 * Usage:
 *   npx tsx src/tools/postToLinkedin.ts --content "post text" --account "vansh"
 *   npx tsx src/tools/postToLinkedin.ts --content "post text"
 *
 * Output:
 *   {"success":true,"postUrl":"https://www.linkedin.com/...","account":"vansh"}
 *   {"success":false,"error":"...","reason":"NEEDS_HUMAN","screenshot":"screenshots/li-...png"}
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { resilientClick, resilientType, saveScreenshot, classifyError } from '../browser/resilientBrowser.js';
import { getLinkedInAccounts, getLinkedInAccountByNickname } from '../browser/linkedin/login.js';
import { humanDelay } from '../browser/stagehand.js';

function out(data: object) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const contentIdx = args.indexOf('--content');
  const accountIdx = args.indexOf('--account');

  if (contentIdx === -1 || !args[contentIdx + 1]) {
    out({ success: false, error: '--content is required', reason: 'FIXABLE' });
    process.exit(1);
  }

  const content = args[contentIdx + 1];
  const accountNickname = accountIdx !== -1 ? args[accountIdx + 1] : undefined;

  const account = accountNickname
    ? getLinkedInAccountByNickname(accountNickname)
    : getLinkedInAccounts().find(a => a.active) ?? null;

  if (!account) {
    out({ success: false, error: `LinkedIn account not found: ${accountNickname ?? 'no active accounts'}`, reason: 'FATAL' });
    process.exit(1);
  }

  const sessionDir = account.sessionDir
    ? path.resolve(account.sessionDir)
    : path.resolve('li-sessions', String(account.email ?? 'default').replace(/[^a-z0-9_-]/gi, '_'));

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  if (!fs.existsSync(chromePath)) {
    out({ success: false, error: `Chrome not found at ${chromePath}`, reason: 'FATAL' });
    process.exit(1);
  }

  const ctx = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--no-sandbox', '--start-maximized', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
  });

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

  const pages = ctx.pages();
  const page = pages.length > 0 ? pages[0] : await ctx.newPage();

  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(2000, 3000);

    const url = page.url();
    if (url.includes('/login') || url.includes('/authwall') || url.includes('/checkpoint')) {
      const screenshot = await saveScreenshot(page, 'li-login-required');
      out({ success: false, error: 'Not logged in — session expired or checkpoint', reason: 'NEEDS_HUMAN', screenshot });
      return;
    }

    // Click "Start a post" button
    const composerResult = await resilientClick(page, {
      role: 'button',
      name: /start a post/i,
      label: 'li-composer',
    });

    if (!composerResult.success) {
      const screenshot = await saveScreenshot(page, 'li-composer-fail');
      out({ success: false, error: composerResult.error, reason: composerResult.reason, screenshot });
      return;
    }

    await humanDelay(1500, 2000);

    // Type into the modal textbox
    const typeResult = await resilientType(page, {
      role: 'textbox',
      name: /what do you want to talk about/i,
      text: content,
      label: 'li-textbox',
    });

    if (!typeResult.success) {
      const screenshot = await saveScreenshot(page, 'li-type-fail');
      out({ success: false, error: typeResult.error, reason: typeResult.reason, screenshot });
      return;
    }

    await humanDelay(1000, 1500);

    // Click Post button
    const postResult = await resilientClick(page, {
      role: 'button',
      name: /^post$/i,
      label: 'li-post-button',
    });

    if (!postResult.success) {
      const screenshot = await saveScreenshot(page, 'li-post-button-fail');
      out({ success: false, error: postResult.error, reason: postResult.reason, screenshot });
      return;
    }

    await humanDelay(3000, 4000);

    const postUrl = account.profileUrl ?? 'https://www.linkedin.com/feed/';
    out({ success: true, postUrl, account: account.nickname ?? account.email });
  } catch (err: any) {
    const reason = classifyError(err.message ?? '');
    let screenshot: string | undefined;
    try { screenshot = await saveScreenshot(page, 'li-fatal'); } catch {}
    out({ success: false, error: err.message, reason, screenshot });
  } finally {
    await ctx.close().catch(() => {});
  }
}

main();
