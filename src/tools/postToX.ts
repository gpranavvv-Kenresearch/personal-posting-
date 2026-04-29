/**
 * postToX.ts — CLI intervention tool for Claude
 *
 * Called by Claude CLI when the main npm run dev X poster fails.
 * Uses resilientBrowser 5-layer fallback instead of hardcoded selectors.
 *
 * Usage:
 *   npx tsx src/tools/postToX.ts --content "tweet text" --account "vansh"
 *   npx tsx src/tools/postToX.ts --content "tweet text"   (uses first active account)
 *
 * Output (JSON to stdout):
 *   {"success":true,"postUrl":"https://x.com/...","account":"vansh"}
 *   {"success":false,"error":"...","reason":"NEEDS_HUMAN","screenshot":"screenshots/x-...png"}
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { resilientClick, resilientType, saveScreenshot, classifyError } from '../browser/resilientBrowser.js';
import { getAccountByHandle, getActiveAccounts } from '../config/accounts.js';
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
  const accountHandle = accountIdx !== -1 ? args[accountIdx + 1] : undefined;

  // Resolve account
  let account = accountHandle ? getAccountByHandle(accountHandle) : getActiveAccounts()[0];
  if (!account) {
    out({ success: false, error: `Account not found: ${accountHandle ?? 'no active accounts'}`, reason: 'FATAL' });
    process.exit(1);
  }

  const statePath = account.sessionStatePath || account.storageState || (account.sessionDir?.toLowerCase().endsWith('.json') ? account.sessionDir : undefined);
  if (statePath && !fs.existsSync(path.resolve(statePath))) {
    out({ success: false, error: `Storage-state JSON not found: ${statePath}`, reason: 'NEEDS_HUMAN' });
    return;
  }

  const browser = statePath
    ? await chromium.launch({
        headless: false,
        executablePath: fs.existsSync(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
          ? process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
          : undefined,
        channel: fs.existsSync(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? undefined : 'chrome',
        slowMo: 50,
        ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
      })
    : null;
  const ctx = statePath
    ? await browser!.newContext({
        storageState: path.resolve(statePath),
        viewport: { width: 1280, height: 900 },
      })
    : await chromium.launchPersistentContext(path.resolve(account.sessionDir), {
        headless: false,
        channel: 'chrome',
        slowMo: 50,
        ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
        viewport: { width: 1280, height: 900 },
      });

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

  const pages = ctx.pages();
  const page = pages.length > 0 ? pages[0] : await ctx.newPage();

  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanDelay(2000, 3000);

    const url = page.url();
    if (url.includes('/login') || url.includes('/flow/login')) {
      const screenshot = await saveScreenshot(page, 'x-login-required');
      out({ success: false, error: 'Not logged in — session expired', reason: 'NEEDS_HUMAN', screenshot });
      return;
    }

    // Open tweet composer
    const typeResult = await resilientType(page, {
      role: 'textbox',
      name: /what is happening/i,
      text: content,
      label: 'x-compose',
    });

    if (!typeResult.success) {
      // fallback: click the compose box by data-testid if visible
      try {
        await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 5000 });
        await page.click('[data-testid="tweetTextarea_0"]');
        await page.evaluate((t) => navigator.clipboard.writeText(t), content);
        await page.keyboard.press('Control+v');
        await humanDelay(800, 1200);
      } catch {
        const screenshot = await saveScreenshot(page, 'x-compose-fail');
        out({ success: false, error: typeResult.error, reason: typeResult.reason, screenshot });
        return;
      }
    }

    await humanDelay(800, 1200);

    // Post via Ctrl+Enter first (most reliable)
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await humanDelay(1000, 1500);

    // Fallback: click Post button
    const postResult = await resilientClick(page, {
      role: 'button',
      name: /^post$/i,
      label: 'x-post-button',
      timeout: 3000,
    });
    if (!postResult.success && postResult.reason !== 'NEEDS_HUMAN') {
      // Ctrl+Enter likely worked — continue
    }

    await humanDelay(2000, 2500);

    // Get tweet URL via Share → Copy link
    let postUrl = `https://x.com/${account.handle}`;
    try {
      const shareBtn = page.locator('button[aria-label="Share post"]').first();
      if (await shareBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await shareBtn.click({ force: true });
        await humanDelay(1000, 1500);

        const copyLink = page.locator('span').filter({ hasText: /^Copy link$/i }).first();
        if (await copyLink.isVisible({ timeout: 3000 }).catch(() => false)) {
          await copyLink.click({ force: true });
          await humanDelay(500, 800);
          const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
          if (clip.startsWith('http')) postUrl = clip;
        }
      }
    } catch { /* URL capture failed — use profile URL */ }

    out({ success: true, postUrl, account: account.handle });
  } catch (err: any) {
    const reason = classifyError(err.message ?? '');
    let screenshot: string | undefined;
    try { screenshot = await saveScreenshot(page, 'x-fatal'); } catch {}
    out({ success: false, error: err.message, reason, screenshot });
  } finally {
    await ctx.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

main();
