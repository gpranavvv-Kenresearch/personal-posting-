/**
 * loginAgent.ts — Bulk session login for X, Facebook, LinkedIn
 *
 * - Tries auto-login for each account
 * - If already logged in → saves session → moves on automatically
 * - If login fails / CAPTCHA / 2FA appears → pauses and asks you in terminal:
 *     [d] Login done — save session and continue
 *     [s] Skip this account
 *
 * Usage:
 *   npm run dev -- login-x [nickname]
 *   npm run dev -- login-fb [nickname]
 *   npm run dev -- login-li [nickname]
 */

import readline from 'readline';
import { getAccounts } from '../config/accounts.js';
import { loginToX, closeBrowser as closeXBrowser } from '../browser/twitter/login.js';
import { loginToFacebook, closeFacebookBrowser, getFacebookAccounts } from '../browser/facebook/login.js';
import { loginToLinkedIn, closeLinkedInBrowser, getLinkedInAccounts } from '../browser/linkedin/login.js';
import { humanDelay } from '../browser/stagehand.js';

// ── Terminal prompt helper ────────────────────────────────────────────────────

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * After auto-login attempt, check URL to decide if already done.
 * If not done, pause and let the user complete login manually, then confirm.
 * Returns true = session saved, false = skipped.
 */
async function confirmOrWait(
  accountLabel: string,
  getUrl: () => string,
  isLoggedInCheck: (url: string) => boolean,
  closeFn: () => Promise<void>,
): Promise<boolean> {
  const url = getUrl();
  if (isLoggedInCheck(url)) {
    console.log(`   ✅ Logged in — session saved for ${accountLabel}`);
    return true;
  }

  // Not logged in — could be CAPTCHA, 2FA, checkpoint, etc.
  console.log(`   ⚠️  Auto-login incomplete — current URL: ${url}`);
  console.log(`   👉 Complete the login manually in the browser window, then answer below:`);

  while (true) {
    const answer = await askUser(`   [d] Done (save session)  [s] Skip > `);
    if (answer === 'd' || answer === 'done') {
      console.log(`   ✅ Session saved for ${accountLabel}`);
      return true;
    }
    if (answer === 's' || answer === 'skip') {
      console.log(`   ⏭️  Skipped ${accountLabel}`);
      await closeFn().catch(() => {});
      return false;
    }
    console.log(`   Please type 'd' to save or 's' to skip.`);
  }
}

// ── X Login ──────────────────────────────────────────────────────────────────

export async function loginAllXAccounts(nickname?: string) {
  const all = getAccounts().filter(a => a.active);
  const targets = nickname
    ? all.filter(a => a.nickname?.toLowerCase() === nickname.toLowerCase())
    : all;

  if (targets.length === 0) {
    console.log(`❌ No X account found${nickname ? ` for nickname "${nickname}"` : ''}`);
    return;
  }

  console.log(`\n🔐 X Login — ${targets.length} account(s)\n`);

  for (const account of targets) {
    console.log(`\n── @${account.handle} (${account.nickname}) ──`);
    let page: any;
    try {
      page = await loginToX(account);
    } catch (err: any) {
      console.error(`   ❌ Auto-login threw error: ${err.message}`);
      console.log(`   👉 The browser should still be open. Complete login manually.`);
    }

    await confirmOrWait(
      `@${account.handle}`,
      () => page?.url?.() ?? '',
      url => url.includes('x.com') && (url.includes('/home') || url.includes('/i/') || url.endsWith('x.com/')),
      () => closeXBrowser(),
    );

    await closeXBrowser().catch(() => {});
    await humanDelay(2000, 3000);
  }

  console.log('\n✅ X login sweep complete.');
}

// ── Facebook Login ────────────────────────────────────────────────────────────

export async function loginAllFacebookAccounts(nickname?: string) {
  const all = (getFacebookAccounts() as any[]).filter(a => a.active);
  const targets = nickname
    ? all.filter(a => a.nickname?.toLowerCase() === nickname.toLowerCase())
    : all;

  if (targets.length === 0) {
    console.log(`❌ No Facebook account found${nickname ? ` for nickname "${nickname}"` : ''}`);
    return;
  }

  console.log(`\n🔐 Facebook Login — ${targets.length} account(s)\n`);

  for (const account of targets) {
    console.log(`\n── ${account.email} (${account.nickname}) ──`);
    let page: any;
    try {
      page = await loginToFacebook({ nickname: account.nickname });
    } catch (err: any) {
      console.error(`   ❌ Auto-login threw error: ${err.message}`);
      console.log(`   👉 The browser should still be open. Complete login manually.`);
    }

    await confirmOrWait(
      account.nickname,
      () => page?.url?.() ?? '',
      url => url.includes('facebook.com') && (url.includes('/home') || url.includes('/feed')),
      () => closeFacebookBrowser(),
    );

    await closeFacebookBrowser().catch(() => {});
    await humanDelay(3000, 5000);
  }

  console.log('\n✅ Facebook login sweep complete.');
}

// ── LinkedIn Login ────────────────────────────────────────────────────────────

export async function loginAllLinkedInAccounts(nickname?: string) {
  const all = (getLinkedInAccounts() as any[]).filter(a => a.active);
  const targets = nickname
    ? all.filter(a => a.nickname?.toLowerCase() === nickname.toLowerCase())
    : all;

  if (targets.length === 0) {
    console.log(`❌ No LinkedIn account found${nickname ? ` for nickname "${nickname}"` : ''}`);
    return;
  }

  console.log(`\n🔐 LinkedIn Login — ${targets.length} account(s)\n`);

  for (const account of targets) {
    console.log(`\n── ${account.email} (${account.nickname}) ──`);
    let page: any;
    try {
      page = await loginToLinkedIn({ email: account.email, password: account.password });
    } catch (err: any) {
      console.error(`   ❌ Auto-login threw error: ${err.message}`);
      console.log(`   👉 The browser should still be open. Complete login manually.`);
    }

    await confirmOrWait(
      account.nickname,
      () => page?.url?.() ?? '',
      url => url.includes('linkedin.com') && (url.includes('/feed') || url.includes('/in/') || url.includes('/mynetwork')),
      () => closeLinkedInBrowser(),
    );

    await closeLinkedInBrowser().catch(() => {});
    await humanDelay(3000, 5000);
  }

  console.log('\n✅ LinkedIn login sweep complete.');
}
