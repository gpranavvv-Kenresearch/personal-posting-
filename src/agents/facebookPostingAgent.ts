/**
 * facebookPostingAgent.ts — Facebook Platform Specialist
 *
 * Owns the full Facebook posting flow for a single row:
 *   generate post → login → post
 *
 * Does NOT write to Google Sheets — the caller saves results.
 */

import { SocialSheetRow } from '../sheets/sheets.js';
import { generateFacebookPost } from './contentGenerator.js';
import { loginToFacebook, closeFacebookBrowser } from '../browser/facebook/login.js';
import { postToFacebook } from '../browser/facebook/poster.js';
import { humanDelay } from '../browser/stagehand.js';
import { getAvailableFbAccount, incrementCount, getCount } from '../config/accountTracker.js';

export interface FbPostResult {
  success: boolean;
  postUrl: string;
  postText: string;
  error?: string;
}

export async function runFacebookAgent(
  row: SocialSheetRow,
  nickname: string,
): Promise<FbPostResult> {
  // ── Step 1: Generate Facebook post ───────────────────────────────────────
  let post = '';
  try {
    console.log(`   ✍️  Generating Facebook post...`);
    post = await generateFacebookPost(row.targetUrl, row.title, row.marketValue, nickname);
    console.log(`   📝 Preview: ${post.slice(0, 80)}...`);
  } catch (err: any) {
    return { success: false, postUrl: '', postText: '', error: `Generation failed: ${err.message}` };
  }

  // ── Step 2: Pick available FB account (daily limit: 4/account) ──────────
  const fbAccount = getAvailableFbAccount();
  if (!fbAccount) {
    console.log(`   ⚠️  All Facebook accounts at daily limit (4/day) — skipping`);
    return { success: false, postUrl: '', postText: post, error: 'All FB accounts at daily limit (4/day)' };
  }
  console.log(`   👤 FB account selected: ${fbAccount.nickname} (${getCount('facebook', fbAccount.nickname ?? '')} posts today)`);

  // ── Step 3: Login to Facebook ─────────────────────────────────────────────
  let page: any;
  try {
    console.log(`   🔐 Logging into Facebook as ${fbAccount.nickname}...`);
    page = await loginToFacebook({ nickname: fbAccount.nickname });
    console.log(`   ✅ Facebook session ready`);
  } catch (err: any) {
    await closeFacebookBrowser().catch(() => {});
    return { success: false, postUrl: '', postText: post, error: `Login failed: ${err.message}` };
  }

  // ── Step 4: Post ──────────────────────────────────────────────────────────
  try {
    await humanDelay(3000, 5000);
    console.log(`   🚀 Posting to Facebook...`);
    const result = await postToFacebook(page, post);
    incrementCount('facebook', fbAccount.nickname);
    console.log(`   ✅ Posted! URL: ${result.postUrl}`);
    return { success: true, postUrl: result.postUrl, postText: post };
  } catch (err: any) {
    return { success: false, postUrl: '', postText: post, error: `Post failed: ${err.message}` };
  } finally {
    await closeFacebookBrowser().catch(() => {});
  }
}
