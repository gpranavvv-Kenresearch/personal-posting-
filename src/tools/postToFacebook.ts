/**
 * postToFacebook.ts — CLI intervention tool for Claude
 *
 * Called by Claude CLI when the main npm run dev Facebook poster fails.
 *
 * Usage:
 *   npx tsx src/tools/postToFacebook.ts --content "post text" --account "vansh"
 *   npx tsx src/tools/postToFacebook.ts --content "post text"
 *
 * Output:
 *   {"success":true,"postUrl":"https://www.facebook.com/...","account":"vansh"}
 *   {"success":false,"error":"...","reason":"NEEDS_HUMAN","screenshot":"screenshots/fb-...png"}
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { resilientClick, resilientType, saveScreenshot, classifyError } from '../browser/resilientBrowser.js';
import { getFacebookAccounts, getFacebookAccountByNickname } from '../browser/facebook/login.js';
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
    ? getFacebookAccountByNickname(accountNickname)
    : getFacebookAccounts().find(a => a.active) ?? null;

  if (!account) {
    out({ success: false, error: `Facebook account not found: ${accountNickname ?? 'no active accounts'}`, reason: 'FATAL' });
    process.exit(1);
  }

  const sessionDir = path.resolve(account.sessionDir);
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
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(2000, 3000);

    const url = page.url();
    if (url.includes('/login')) {
      const screenshot = await saveScreenshot(page, 'fb-login-required');
      out({ success: false, error: 'Not logged in — session expired', reason: 'NEEDS_HUMAN', screenshot });
      return;
    }

    // Open composer — try aria first, then fallbacks
    const composerResult = await resilientClick(page, {
      role: 'button',
      name: /what.s on your mind/i,
      label: 'fb-composer',
    });

    if (!composerResult.success) {
      // Try the span/div fallback
      try {
        await page.click('span:has-text("What\'s on your mind")');
      } catch {
        const screenshot = await saveScreenshot(page, 'fb-composer-fail');
        out({ success: false, error: composerResult.error, reason: composerResult.reason, screenshot });
        return;
      }
    }

    await humanDelay(1500, 2500);

    // Type into the dialog textbox
    const typeResult = await resilientType(page, {
      role: 'textbox',
      name: /what.s on your mind/i,
      text: content,
      label: 'fb-textbox',
    });

    if (!typeResult.success) {
      const screenshot = await saveScreenshot(page, 'fb-type-fail');
      out({ success: false, error: typeResult.error, reason: typeResult.reason, screenshot });
      return;
    }

    await humanDelay(1000, 1500);

    // Click Post button
    const postResult = await resilientClick(page, {
      role: 'button',
      name: /^post$/i,
      label: 'fb-post-button',
    });

    if (!postResult.success) {
      const screenshot = await saveScreenshot(page, 'fb-post-button-fail');
      out({ success: false, error: postResult.error, reason: postResult.reason, screenshot });
      return;
    }

    await humanDelay(3000, 4000);

    const postUrl = account.profileUrl ?? 'https://www.facebook.com/';
    out({ success: true, postUrl, account: account.nickname ?? account.email });
  } catch (err: any) {
    const reason = classifyError(err.message ?? '');
    let screenshot: string | undefined;
    try { screenshot = await saveScreenshot(page, 'fb-fatal'); } catch {}
    out({ success: false, error: err.message, reason, screenshot });
  } finally {
    await ctx.close().catch(() => {});
  }
}

main();
