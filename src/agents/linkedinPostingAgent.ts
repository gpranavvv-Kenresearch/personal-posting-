/**
 * linkedinPostingAgent.ts — LinkedIn Platform Specialist
 *
 * Owns the full LinkedIn posting flow for a single row:
 *   generate post → login → post
 *
 * Does NOT write to Google Sheets — the caller saves results.
 */

import { SocialSheetRow } from '../sheets/sheets.js';
import { generateLinkedInPost } from './contentGenerator.js';
import { loginToLinkedIn, closeLinkedInBrowser } from '../browser/linkedin/login.js';
import { postToLinkedIn } from '../browser/linkedin/poster.js';
import { humanDelay } from '../browser/stagehand.js';
import { getAvailableLinkedInAccount, incrementCount, getCount } from '../config/accountTracker.js';

export interface LinkedInPostResult {
  success: boolean;
  postUrl: string;
  postText: string;
  error?: string;
}

export async function runLinkedInAgent(
  row: SocialSheetRow,
  nickname: string,
): Promise<LinkedInPostResult> {
  // ── Step 1: Generate LinkedIn post ───────────────────────────────────────
  let post = '';
  try {
    console.log(`   ✍️  Generating LinkedIn post...`);
    post = await generateLinkedInPost(row.targetUrl, row.title, row.marketValue);
    console.log(`   📝 Preview: ${post.slice(0, 80)}...`);
  } catch (err: any) {
    return { success: false, postUrl: '', postText: '', error: `Generation failed: ${err.message}` };
  }

  // ── Step 2: Pick available LinkedIn account (daily limit: 3/account) ─────
  const liAccount = getAvailableLinkedInAccount();
  if (!liAccount) {
    console.log(`   ⚠️  All LinkedIn accounts at daily limit (3/day) — skipping`);
    return { success: false, postUrl: '', postText: post, error: 'All LinkedIn accounts at daily limit (3/day)' };
  }
  console.log(`   👤 LinkedIn account selected: ${liAccount.nickname} (${getCount('linkedin', liAccount.nickname ?? '')} posts today)`);

  // ── Step 3: Login to LinkedIn ─────────────────────────────────────────────
  let page: any;
  try {
    console.log(`   🔐 Logging into LinkedIn as ${liAccount.nickname}...`);
    page = await loginToLinkedIn({ nickname: liAccount.nickname });
    console.log(`   ✅ LinkedIn session ready`);
  } catch (err: any) {
    await closeLinkedInBrowser().catch(() => {});
    return { success: false, postUrl: '', postText: post, error: `Login failed: ${err.message}` };
  }

  // ── Step 4: Post ──────────────────────────────────────────────────────────
  try {
    await humanDelay(3000, 5000);
    console.log(`   🚀 Posting to LinkedIn...`);
    const result = await postToLinkedIn(page, post);
    incrementCount('linkedin', liAccount.nickname);
    console.log(`   ✅ Posted! URL: ${result.postUrl}`);
    return { success: true, postUrl: result.postUrl, postText: post };
  } catch (err: any) {
    return { success: false, postUrl: '', postText: post, error: `Post failed: ${err.message}` };
  } finally {
    await closeLinkedInBrowser().catch(() => {});
  }
}
