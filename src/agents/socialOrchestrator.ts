/**
 * socialOrchestrator.ts — Facebook & LinkedIn posting pipeline
 *
 * Usage (via index.ts):
 *   npm run dev -- fb-post <url>       → post to Facebook
 *   npm run dev -- linkedin-post <url> → post to LinkedIn
 */

import { loginToFacebook, closeFacebookBrowser } from '../browser/facebook/login.js';
import { postToFacebook } from '../browser/facebook/poster.js';
import { loginToLinkedIn, closeLinkedInBrowser } from '../browser/linkedin/login.js';
import { postToLinkedIn } from '../browser/linkedin/poster.js';
import { generateFacebookPost, generateLinkedInPost } from './contentGenerator.js';
import { getTodaysBatchRows, saveUnifiedFbResult, saveUnifiedLinkedInResult } from '../sheets/sheets.js';
import { getAccountByHandle } from '../config/accounts.js';
import { humanDelay } from '../browser/stagehand.js';
import 'dotenv/config';

// ── Facebook ───────────────────────────────────────────────────────────────

export async function runFacebookPostingAgent(reportUrl: string, nickname?: string) {
  console.log(`\n🔐 Agent 1: Logging into Facebook${nickname ? ` as ${nickname}` : ''}...`);
  const page = await loginToFacebook({ nickname });

  console.log('\n✍️  Agent 2: Generating Facebook post...');
  const postText = await generateFacebookPost(reportUrl, undefined, undefined, nickname);
  console.log(`   Preview: ${postText.slice(0, 80)}...`);

  console.log('\n🚀 Agent 3: Posting to Facebook...');
  await humanDelay(3000, 5000);
  const result = await postToFacebook(page, postText);

  await closeFacebookBrowser();
  return result;
}

// ── Facebook sheet-based flow ──────────────────────────────────────────────

export async function runFbFlowForAccount(nickname: string, batch: number): Promise<void> {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🎯 FB Flow — ${nickname} | Batch ${batch}`);
  console.log('='.repeat(50));

  const account = getAccountByHandle(nickname);
  if (!account) throw new Error(`Account "${nickname}" not found in accounts.json`);

  const rows = await getTodaysBatchRows(batch);
  const row = rows.find(r =>
    r.name.toLowerCase() === nickname.toLowerCase() ||
    r.name.toLowerCase() === account.handle.toLowerCase()
  );

  if (!row) {
    console.log(`   ⚠️  No row found for ${nickname} in FB batch ${batch} today.`);
    console.log(`   Rows in batch ${batch}: ${rows.map(r => r.name).join(', ') || 'none'}`);
    return;
  }

  console.log(`   Found row ${row.rowIndex}: ${row.title || row.targetUrl}`);

  let post = '';
  try {
    console.log('\n✍️  Generating Facebook post...');
    post = await generateFacebookPost(row.targetUrl, row.title, row.marketValue, nickname);
    console.log(`   Preview: ${post.slice(0, 80)}...`);
  } catch (err: any) {
    await saveUnifiedFbResult(row, { post: '', postUrl: '', status: 'Failed', error: `Generation: ${err.message}` });
    throw err;
  }

  try {
    console.log('\n🔐 Logging into Facebook...');
    const page = await loginToFacebook({ nickname });
    await humanDelay(3000, 5000);
    const result = await postToFacebook(page, post);
    await closeFacebookBrowser();
    await saveUnifiedFbResult(row, { post, postUrl: result.postUrl, status: 'Posted' });
    console.log(`\n✅ FB flow complete for ${nickname} batch ${batch}. URL: ${result.postUrl}`);
  } catch (err: any) {
    await closeFacebookBrowser().catch(() => {});
    await saveUnifiedFbResult(row, { post, postUrl: '', status: 'Failed', error: `Post: ${err.message}` });
    throw err;
  }
}

// ── LinkedIn sheet-based flow ──────────────────────────────────────────────

export async function runLinkedInFlowForAccount(nickname: string, batch: number): Promise<void> {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🎯 LinkedIn Flow — ${nickname} | Batch ${batch}`);
  console.log('='.repeat(50));

  const account = getAccountByHandle(nickname);
  if (!account) throw new Error(`Account "${nickname}" not found in accounts.json`);

  const rows = await getTodaysBatchRows(batch);
  const row = rows.find(r =>
    r.name.toLowerCase() === nickname.toLowerCase() ||
    r.name.toLowerCase() === account.handle.toLowerCase()
  );

  if (!row) {
    console.log(`   ⚠️  No row found for ${nickname} in LinkedIn batch ${batch} today.`);
    console.log(`   Rows in batch ${batch}: ${rows.map(r => r.name).join(', ') || 'none'}`);
    return;
  }

  console.log(`   Found row ${row.rowIndex}: ${row.title || row.targetUrl}`);

  let post = '';
  try {
    console.log('\n✍️  Generating LinkedIn post...');
    post = await generateLinkedInPost(row.targetUrl, row.title, row.marketValue);
    console.log(`   Preview: ${post.slice(0, 80)}...`);
  } catch (err: any) {
    await saveUnifiedLinkedInResult(row, { post: '', postUrl: '', status: 'Failed', error: `Generation: ${err.message}` });
    throw err;
  }

  try {
    console.log('\n🔐 Logging into LinkedIn...');
    const page = await loginToLinkedIn();
    await humanDelay(3000, 5000);
    const result = await postToLinkedIn(page, post);
    await closeLinkedInBrowser();
    await saveUnifiedLinkedInResult(row, { post, postUrl: result.postUrl, status: 'Posted' });
    console.log(`\n✅ LinkedIn flow complete for ${nickname} batch ${batch}. URL: ${result.postUrl}`);
  } catch (err: any) {
    await closeLinkedInBrowser().catch(() => {});
    await saveUnifiedLinkedInResult(row, { post, postUrl: '', status: 'Failed', error: `Post: ${err.message}` });
    throw err;
  }
}

// ── Facebook scheduled batch runner ───────────────────────────────────────

export async function runFbScheduledBatch(batch: number): Promise<{ processed: number }> {
  const rows = await getTodaysBatchRows(batch);

  if (rows.length === 0) {
    console.log(`   No FB rows found for batch ${batch} today.`);
    return { processed: 0 };
  }

  console.log(`   Processing ${rows.length} FB accounts...\n`);

  let processed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`\n  📌 FB Row ${row.rowIndex}: ${row.name} → ${row.title || row.targetUrl}`);

    try {
      let post = '';
      console.log('   ✍️  Generating Facebook post...');
      post = await generateFacebookPost(row.targetUrl, row.title, row.marketValue, row.name);

      console.log('   🔐 Logging into Facebook...');
      const page = await loginToFacebook({ nickname: row.name });
      await humanDelay(3000, 5000);
      const result = await postToFacebook(page, post);
      await closeFacebookBrowser();
      await saveUnifiedFbResult(row, { post, postUrl: result.postUrl, status: 'Posted' });
      console.log(`   ✅ Posted! URL: ${result.postUrl}`);
      processed++;
    } catch (err: any) {
      console.error(`   ❌ FB failed for ${row.name}: ${err.message}`);
      await closeFacebookBrowser().catch(() => {});
      await saveUnifiedFbResult(row, { post: '', postUrl: '', status: 'Failed', error: err.message });
    }

    if (i < rows.length - 1) {
      console.log('   ⏳ Waiting 8s before next account...');
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  console.log(`\n✅ FB Batch ${batch} complete. Processed ${processed}/${rows.length} rows.`);
  return { processed };
}

// ── LinkedIn scheduled batch runner ───────────────────────────────────────

export async function runLinkedInScheduledBatch(batch: number): Promise<{ processed: number }> {
  const rows = await getTodaysBatchRows(batch);

  if (rows.length === 0) {
    console.log(`   No LinkedIn rows found for batch ${batch} today.`);
    return { processed: 0 };
  }

  console.log(`   Processing ${rows.length} LinkedIn accounts...\n`);

  let processed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`\n  📌 LinkedIn Row ${row.rowIndex}: ${row.name} → ${row.title || row.targetUrl}`);

    try {
      let post = '';
      console.log('   ✍️  Generating LinkedIn post...');
      post = await generateLinkedInPost(row.targetUrl, row.title, row.marketValue);

      console.log('   🔐 Logging into LinkedIn...');
      const page = await loginToLinkedIn();
      await humanDelay(3000, 5000);
      const result = await postToLinkedIn(page, post);
      await closeLinkedInBrowser();
      await saveUnifiedLinkedInResult(row, { post, postUrl: result.postUrl, status: 'Posted' });
      console.log(`   ✅ Posted! URL: ${result.postUrl}`);
      processed++;
    } catch (err: any) {
      console.error(`   ❌ LinkedIn failed for ${row.name}: ${err.message}`);
      await closeLinkedInBrowser().catch(() => {});
      await saveUnifiedLinkedInResult(row, { post: '', postUrl: '', status: 'Failed', error: err.message });
    }

    if (i < rows.length - 1) {
      console.log('   ⏳ Waiting 8s before next account...');
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  console.log(`\n✅ LinkedIn Batch ${batch} complete. Processed ${processed}/${rows.length} rows.`);
  return { processed };
}

// ── LinkedIn ───────────────────────────────────────────────────────────────

export async function runLinkedInPostingAgent(reportUrl: string) {
  console.log('\n🔐 Agent 1: Logging into LinkedIn...');
  const page = await loginToLinkedIn();

  console.log('\n✍️  Agent 2: Generating LinkedIn post...');
  const postText = await generateLinkedInPost(reportUrl);
  console.log(`   Preview: ${postText.slice(0, 80)}...`);

  console.log('\n🚀 Agent 3: Posting to LinkedIn...');
  await humanDelay(3000, 5000);
  const result = await postToLinkedIn(page, postText);

  await closeLinkedInBrowser();
  return result;
}
