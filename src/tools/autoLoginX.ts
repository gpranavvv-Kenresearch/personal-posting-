/**
 * autoLoginX.ts — Auto-login to X for all accounts and save persistent sessions
 * Usage: npx tsx src/tools/autoLoginX.ts
 *        npx tsx src/tools/autoLoginX.ts aniket        (single account)
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { getAccounts, getAccountByHandle } from '../config/accounts.js';

const DELAY = (ms: number) => new Promise(r => setTimeout(r, ms));

async function loginAccount(nickname: string, username: string, password: string, handle: string, sessionDir: string): Promise<boolean> {
  const absSessionDir = path.resolve(sessionDir);
  fs.mkdirSync(absSessionDir, { recursive: true });

  console.log(`\n[${ nickname }] Opening Chrome → ${absSessionDir}`);

  let ctx: any = null;
  try {
    ctx = await chromium.launchPersistentContext(absSessionDir, {
      headless: true,
      channel: 'chrome',
      args: ['--start-minimized'],
      slowMo: 80,
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: 1280, height: 900 },
    });

    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

    const pages = ctx.pages();
    const page = pages[0] || await ctx.newPage();

    // Check if already logged in via home page first
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await DELAY(3000);

    const url = page.url();
    console.log(`[${ nickname }] URL: ${url}`);

    if (url.includes('/home') || url.includes('/following') || url.includes('/notifications')) {
      console.log(`[${ nickname }] ✅ Already logged in — session valid`);
      await ctx.close();
      return true;
    }

    // Not logged in — go directly to login flow
    console.log(`[${ nickname }] Not logged in — navigating to login flow...`);
    await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await DELAY(2500);

    console.log(`[${ nickname }] Typing username...`);

    // Fill username — use type() not fill() so React sees keystrokes
    const userInput = page.locator('input[name="text"], input[autocomplete="username"]').first();
    await userInput.waitFor({ state: 'visible', timeout: 20000 });
    await userInput.click();
    await DELAY(400);
    await page.keyboard.selectAll();
    await page.keyboard.press('Backspace');
    await DELAY(200);
    await page.keyboard.type(username, { delay: 80 });
    await DELAY(800);

    // Click Next
    const nextBtn = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await DELAY(2500);

    // Security check (unusual activity) — X may ask for username/handle again
    const secInput = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
    if (await secInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`[${ nickname }] Security check — entering handle...`);
      await secInput.click();
      await page.keyboard.selectAll();
      await page.keyboard.press('Backspace');
      await DELAY(200);
      await page.keyboard.type(handle, { delay: 80 });
      await DELAY(600);
      const secNext = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').first();
      if (await secNext.isVisible().catch(() => false)) await secNext.click();
      else await page.keyboard.press('Enter');
      await DELAY(2500);
    }

    // Fill password — use type() not fill()
    console.log(`[${ nickname }] Typing password...`);
    const passInput = page.locator('input[name="password"]').first();
    await passInput.waitFor({ state: 'visible', timeout: 20000 });
    await passInput.click();
    await DELAY(400);
    await page.keyboard.selectAll();
    await page.keyboard.press('Backspace');
    await DELAY(200);
    await page.keyboard.type(password, { delay: 80 });
    await DELAY(800);

    // Click Log in
    const loginBtn = page.locator('div[role="button"]:has-text("Log in"), button:has-text("Log in")').first();
    if (await loginBtn.isVisible().catch(() => false)) {
      await loginBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await DELAY(4000);

    // Phone/email verification challenge
    const verifyInput = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
    if (await verifyInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log(`[${ nickname }] Verification challenge — entering handle...`);
      await verifyInput.click();
      await page.keyboard.selectAll();
      await page.keyboard.press('Backspace');
      await DELAY(200);
      await page.keyboard.type(handle, { delay: 80 });
      await DELAY(600);
      const verifyNext = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').first();
      if (await verifyNext.isVisible().catch(() => false)) await verifyNext.click();
      else await page.keyboard.press('Enter');
      await DELAY(4000);
    }

    // Wait for home page
    try {
      await page.waitForFunction(
        () => !window.location.href.includes('/flow/login') && !window.location.href.includes('/login'),
        { timeout: 20000 }
      );
    } catch {
      console.log(`[${ nickname }] ⚠️  Still on login page — may need manual verification`);
    }

    const finalUrl = page.url();
    console.log(`[${ nickname }] Final URL: ${finalUrl}`);

    if (finalUrl.includes('/home') || finalUrl.includes('/following') || !finalUrl.includes('login')) {
      console.log(`[${ nickname }] ✅ Login successful — session saved`);
      await ctx.close();
      return true;
    } else {
      console.log(`[${ nickname }] ❌ Login may have failed — check manually`);
      await ctx.close();
      return false;
    }
  } catch (err: any) {
    console.log(`[${ nickname }] ❌ Error: ${err.message}`);
    try { await ctx?.close(); } catch {}
    return false;
  }
}

async function main() {
  const singleNickname = process.argv[2];

  const accounts = singleNickname
    ? (() => { const a = getAccountByHandle(singleNickname); return a ? [a] : []; })()
    : getAccounts().filter(a => a.active);

  if (accounts.length === 0) {
    console.error(`❌ No accounts found${singleNickname ? ` for "${singleNickname}"` : ''}`);
    process.exit(1);
  }

  console.log(`\n🔐 Auto-login X sessions for ${accounts.length} account(s)\n`);

  const results: { nickname: string; success: boolean }[] = [];

  for (const account of accounts) {
    const ok = await loginAccount(
      account.nickname || account.handle,
      account.username,
      account.password,
      account.handle,
      account.sessionDir || `.sessions/chrome-${account.handle}`
    );
    results.push({ nickname: account.nickname || account.handle, success: ok });

    // Wait between accounts to avoid Chrome conflicts
    if (accounts.indexOf(account) < accounts.length - 1) {
      console.log(`\nWaiting 3s before next account...`);
      await DELAY(3000);
    }
  }

  console.log('\n── Summary ──────────────────────────────');
  for (const r of results) {
    console.log(`  ${r.success ? '✅' : '❌'} ${r.nickname}`);
  }
  console.log(`\nDone. ${results.filter(r => r.success).length}/${results.length} sessions saved.`);
}

main().catch(console.error);

