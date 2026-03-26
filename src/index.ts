/**
 * index.ts — Entry Point
 *
 * Modes:
 *   npm run dev                        → scheduler daemon (checks every 5 min like n8n)
 *   npm run dev -- once                → run current batch once and exit
 *   npm run dev -- post <url> [handle] → manually post to X
 *   npm run dev -- fb-post <url> [nickname] → post to Facebook
 *   npm run dev -- linkedin-post <url> → post to LinkedIn
 *   npm run dev -- schedule            → print today's schedule and exit
 *   npm run dev -- orchestrate <url> [nickname] → AI decides platform + posts
 *   npm run dev -- distribute [count]          → assign unassigned rows to accounts + batches
 *   npm run dev -- leftover                    → requeue unposted rows from before today
 */

import 'dotenv/config';
import { startSchedulerDaemon, runScheduledBatch, runXFlowForAccount, runBatchNow } from './agents/scheduler.js';
import { supervisedRun } from './agents/supervisor.js';
import { printSchedule } from './config/schedule.js';
import { runFacebookPostingAgent, runLinkedInPostingAgent, runFbFlowForAccount, runLinkedInFlowForAccount } from './agents/socialOrchestrator.js';
import { runDistributionAgent } from './agents/distributionAgent.js';
import { runLeftoverAgent } from './agents/leftoverAgent.js';
import { loginAllXAccounts, loginAllFacebookAccounts, loginAllLinkedInAccounts } from './agents/loginAgent.js';
import { getRowByIndex, saveUnifiedLinkedInResult, saveUnifiedFbResult, savePostingResult } from './sheets/sheets.js';
import { runLinkedInAgent } from './agents/linkedinPostingAgent.js';
import { runFacebookAgent } from './agents/facebookPostingAgent.js';

const mode = process.argv[2];

async function main() {
  if (mode === 'schedule') {
    printSchedule();
    return;
  }

  if (mode === 'once') {
    console.log('🔁 Running current batch once...\n');
    const result = await runScheduledBatch();
    if (result.skipped) {
      console.log('⏰ No batch scheduled at this time.');
      printSchedule();
    } else {
      console.log(`\n✅ Done. Batch ${result.batch} — ${result.processed} posted.`);
    }
    return;
  }

  if (mode === 'post') {
    const reportUrl = process.argv[3];
    if (!reportUrl) {
      console.error('Usage: npm run dev -- post <report-url> [account-handle]');
      process.exit(1);
    }
    const accountHandle = process.argv[4] || undefined;
    console.log(`📌 Manual post mode: ${reportUrl}`);
    if (accountHandle) console.log(`   Account: @${accountHandle}`);
    console.log();
    const { getAccountByHandle, getAccounts } = await import('./config/accounts.js');
    let account = accountHandle ? getAccountByHandle(accountHandle) : getAccounts().find(a => a.active);
    if (!account) { console.error('No account found'); process.exit(1); }
    const row = { rowIndex: 0, targetUrl: reportUrl, title: '', marketValue: '', batch: '', date: '', name: account.handle, xPost: '', xPostUrl: '', xStatus: '', xError: '', fbStatus: '', linkedinStatus: '', seoScore: '', sanityIssues: '', messageStatus: '' };
    const result = await supervisedRun(row as any, account, { seenUrls: new Set(), seenTexts: [] });
    console.log('\n' + '='.repeat(50));
    if (result.success) {
      console.log('✅ DONE!');
      console.log(`   Tweet   : ${result.xResult?.url}`);
      console.log(`   Attempts: ${result.attempts}`);
    } else {
      console.log('❌ FAILED');
      console.log(`   Errors  : ${result.errors.map(e => e.error).join(' | ')}`);
      console.log(`   Check   : logs/errors.json`);
    }
    console.log('='.repeat(50));
    return;
  }

  if (mode === 'fb-post') {
    const reportUrl = process.argv[3];
    if (!reportUrl) {
      console.error('Usage: npm run dev -- fb-post <report-url> [nickname]');
      process.exit(1);
    }
    const nickname = process.argv[4] || undefined;
    console.log(`📌 Facebook post mode: ${reportUrl}${nickname ? ` (account: ${nickname})` : ''}\n`);
    const result = await runFacebookPostingAgent(reportUrl, nickname);
    console.log('\n' + '='.repeat(50));
    console.log('✅ DONE!');
    console.log(`   Post URL: ${result.postUrl}`);
    console.log('='.repeat(50));
    return;
  }

  if (mode === 'fb-flow') {
    const nickname = process.argv[3];
    const batch = parseInt(process.argv[4] || '', 10);
    if (!nickname || isNaN(batch)) {
      console.error('Usage: npm run dev -- fb-flow <nickname> <batch>');
      console.error('Example: npm run dev -- fb-flow vansh 3');
      process.exit(1);
    }
    await runFbFlowForAccount(nickname, batch);
    return;
  }

  if (mode === 'linkedin-flow') {
    const nickname = process.argv[3];
    const batch = parseInt(process.argv[4] || '', 10);
    if (!nickname || isNaN(batch)) {
      console.error('Usage: npm run dev -- linkedin-flow <nickname> <batch>');
      console.error('Example: npm run dev -- linkedin-flow vansh 2');
      process.exit(1);
    }
    await runLinkedInFlowForAccount(nickname, batch);
    return;
  }

  if (mode === 'run-batch') {
    const batchNum = parseInt(process.argv[3] || '', 10);
    if (isNaN(batchNum)) {
      console.error('Usage: npm run dev -- run-batch <number> [x|fb|linkedin|all]');
      process.exit(1);
    }
    const platform = process.argv[4] || undefined;
    await runBatchNow(batchNum, platform);
    return;
  }

  if (mode === 'x-flow') {
    const nickname = process.argv[3];
    const batch = parseInt(process.argv[4] || '', 10);
    if (!nickname || isNaN(batch)) {
      console.error('Usage: npm run dev -- x-flow <nickname> <batch>');
      console.error('Example: npm run dev -- x-flow vansh 10');
      process.exit(1);
    }
    await runXFlowForAccount(nickname, batch);
    return;
  }

  if (mode === 'linkedin-post') {
    const reportUrl = process.argv[3];
    if (!reportUrl) {
      console.error('Usage: npm run dev -- linkedin-post <report-url>');
      process.exit(1);
    }
    console.log(`📌 LinkedIn post mode: ${reportUrl}\n`);
    const result = await runLinkedInPostingAgent(reportUrl);
    console.log('\n' + '='.repeat(50));
    console.log('✅ DONE!');
    console.log(`   Post URL: ${result.postUrl}`);
    console.log('='.repeat(50));
    return;
  }

  if (mode === 'login-x') {
    const nickname = process.argv[3];
    await loginAllXAccounts(nickname);
    return;
  }

  if (mode === 'login-fb') {
    const nickname = process.argv[3];
    await loginAllFacebookAccounts(nickname);
    return;
  }

  if (mode === 'login-li') {
    const nickname = process.argv[3];
    await loginAllLinkedInAccounts(nickname);
    return;
  }

  if (mode === 'leftover') {
    const result = await runLeftoverAgent();
    console.log(`\n✅ Done — ${result.found} leftover rows found, ${result.requeued} requeued.`);
    return;
  }

  if (mode === 'retry-post') {
    // Usage: npm run dev -- retry-post <rowIndex> <li|fb|x> [nickname]
    // Reads already-generated content from the sheet and posts without regenerating.
    const rowIndex = parseInt(process.argv[3] || '', 10);
    const platform = (process.argv[4] || '').toLowerCase();

    if (isNaN(rowIndex) || !['li', 'fb', 'x'].includes(platform)) {
      console.error('Usage: npm run dev -- retry-post <rowIndex> <li|fb|x>');
      console.error('Example: npm run dev -- retry-post 17 li');
      process.exit(1);
    }

    console.log(`\n🔁 Retry post — row ${rowIndex}, platform: ${platform}`);
    const row = await getRowByIndex(rowIndex);
    if (!row) {
      console.error(`❌ Row ${rowIndex} not found in sheet`);
      process.exit(1);
    }

    // Allow overriding the account via 5th arg, otherwise use row's assigned name
    const forceNickname = process.argv[5] || row.name;
    console.log(`   📌 Row: ${row.title} | Account: ${forceNickname}`);

    if (platform === 'li') {
      const existingContent = row.linkedinPost?.trim();
      if (!existingContent) {
        console.error(`❌ No LinkedIn post content in row ${rowIndex} — run normal batch first to generate`);
        process.exit(1);
      }
      console.log(`   📝 Existing content (${existingContent.length} chars): ${existingContent.slice(0, 80)}...`);
      const result = await runLinkedInAgent(row, forceNickname, existingContent);
      if (result.success) {
        await saveUnifiedLinkedInResult(row, { post: result.postText, postUrl: result.postUrl, status: 'Posted' });
        console.log(`\n✅ Posted! URL: ${result.postUrl}`);
      } else {
        await saveUnifiedLinkedInResult(row, { post: result.postText, postUrl: '', status: 'Failed', error: result.error });
        console.error(`\n❌ Failed: ${result.error}`);
      }

    } else if (platform === 'fb') {
      const existingContent = row.fbPost?.trim();
      if (!existingContent) {
        console.error(`❌ No Facebook post content in row ${rowIndex} — run normal batch first to generate`);
        process.exit(1);
      }
      console.log(`   📝 Existing content (${existingContent.length} chars): ${existingContent.slice(0, 80)}...`);
      const result = await runFacebookAgent(row, forceNickname, existingContent);
      if (result.success) {
        await saveUnifiedFbResult(row, { post: result.postText, postUrl: result.postUrl, status: 'Posted' });
        console.log(`\n✅ Posted! URL: ${result.postUrl}`);
      } else {
        await saveUnifiedFbResult(row, { post: result.postText, postUrl: '', status: 'Failed', error: result.error });
        console.error(`\n❌ Failed: ${result.error}`);
      }

    } else if (platform === 'x') {
      const existingContent = row.xPost?.trim();
      if (!existingContent) {
        console.error(`❌ No X post content in row ${rowIndex} — run normal batch first to generate`);
        process.exit(1);
      }
      console.log(`   📝 Existing tweet (${existingContent.length} chars): ${existingContent.slice(0, 80)}...`);
      const { getAccountByHandle, getAccounts } = await import('./config/accounts.js');
      const account = forceNickname ? getAccountByHandle(forceNickname) : getAccounts().find(a => a.active);
      if (!account) {
        console.error(`❌ X account not found for nickname: ${forceNickname}`);
        process.exit(1);
      }
      const { runXPostingAgent } = await import('./agents/xPostingAgent.js');
      const { createBatchContext } = await import('./agents/sanityAgent.js');
      const batchCtx = createBatchContext();
      const result = await runXPostingAgent({ ...row, xPost: existingContent }, account, batchCtx);
      if (result.success) {
        await savePostingResult(row, { xPostUrl: result.tweetUrl, xStatus: 'Posted', xPost: result.tweetText, seoScore: result.seoScore, sanityIssues: result.sanityIssues });
        console.log(`\n✅ Posted! URL: ${result.tweetUrl}`);
      } else {
        await savePostingResult(row, { xPostUrl: '', xStatus: 'Failed', xError: result.error });
        console.error(`\n❌ Failed: ${result.error}`);
      }
    }
    return;
  }

  if (mode === 'distribute') {
    const count = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
    if (process.argv[3] && isNaN(count!)) {
      console.error('Usage: npm run dev -- distribute [count]');
      process.exit(1);
    }
    await runDistributionAgent(undefined, count);
    return;
  }

  // Default: start scheduler daemon
  await startSchedulerDaemon();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});