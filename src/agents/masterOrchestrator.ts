/**
 * masterOrchestrator.ts — Platform Dispatcher
 *
 * Pure dispatcher: receives platforms[] (decided by seoAgent) and routes
 * to the appropriate platform-specialist agents. No AI calls here.
 *
 * Platform decision is owned by seoAgent.runSeoAnalysis().
 * This file only executes the dispatch.
 */

import { getAccountByHandle, getActiveAccounts, XAccount } from '../config/accounts.js';
import { runXPostingAgent, XPostResult } from './xPostingAgent.js';
import { runFacebookAgent, FbPostResult } from './facebookPostingAgent.js';
import { runLinkedInAgent, LinkedInPostResult } from './linkedinPostingAgent.js';
import { createBatchContext, BatchContext } from './sanityAgent.js';
import { runSeoAnalysis, Platform } from './seoAgent.js';
import { SheetRow } from '../sheets/sheets.js';

export type { Platform };

export interface RowOrchestratorResult {
  platforms: Platform[];
  results: {
    x?:        XPostResult;
    facebook?: FbPostResult;
    linkedin?: LinkedInPostResult;
  };
}

// ── Scheduler-facing entry point ───────────────────────────────────────────
// Called by supervisor.ts — platforms[] already decided by seoAgent.

export async function runOrchestratorForRow(
  row: SheetRow,
  account: XAccount,
  batchCtx: BatchContext,
  platforms: Platform[],
): Promise<RowOrchestratorResult> {
  console.log(`\n🎬 Orchestrator dispatching to: ${platforms.join(', ')}`);

  const result: RowOrchestratorResult = { platforms, results: {} };

  // X runs alone first (never parallel with another X post across rows — scheduler is sequential)
  // FB and LI run in parallel with each other alongside X
  const tasks: Promise<void>[] = [];

  if (platforms.includes('x')) {
    tasks.push((async () => {
      console.log(`\n${'─'.repeat(40)}\n🐦 X Posting Agent\n${'─'.repeat(40)}`);
      result.results.x = await runXPostingAgent(row, account, batchCtx);
    })());
  }

  if (platforms.includes('facebook')) {
    tasks.push((async () => {
      console.log(`\n${'─'.repeat(40)}\n📘 Facebook Posting Agent\n${'─'.repeat(40)}`);
      result.results.facebook = await runFacebookAgent(row, row.name);
    })());
  }

  if (platforms.includes('linkedin')) {
    tasks.push((async () => {
      console.log(`\n${'─'.repeat(40)}\n💼 LinkedIn Posting Agent\n${'─'.repeat(40)}`);
      result.results.linkedin = await runLinkedInAgent(row, row.name);
    })());
  }

  // Run all platforms in parallel — X + FB + LI fire simultaneously
  await Promise.all(tasks);

  return result;
}

// ── CLI-facing entry point (npm run dev -- orchestrate <url>) ──────────────
// Runs seoAnalysis itself when called manually, then dispatches.

export interface OrchestratorResult {
  platform: string;
  style: string;
  results: {
    x?:        { success: boolean; url: string; error?: string };
    facebook?: { success: boolean; url: string; error?: string };
    linkedin?: { success: boolean; url: string; error?: string };
  };
}

export async function runMasterOrchestrator(params: {
  targetUrl: string;
  title?: string;
  marketValue?: string;
  nickname?: string;
}): Promise<OrchestratorResult> {
  const { targetUrl, title = '', marketValue = '', nickname } = params;

  console.log(`\n🧠 Master Orchestrator — analyzing report...`);
  console.log(`   URL: ${targetUrl}`);

  // SEO agent decides platform (replaces old Gemini AI call)
  const seoData = await runSeoAnalysis(targetUrl, title);
  const platforms = seoData.platforms;

  console.log(`\n🎯 Orchestrator decided: platform(s)=${platforms.join(', ').toUpperCase()}`);
  console.log(`   Index: ${seoData.indexStatus}, Page: ${seoData.rankPage === 99 ? 'N/A' : seoData.rankPage}`);

  const result: OrchestratorResult = { platform: platforms.join(','), style: '', results: {} };

  const account = nickname
    ? getAccountByHandle(nickname)
    : getActiveAccounts()[0];

  const batchCtx = createBatchContext();

  // Make a minimal SheetRow for the CLI path
  const row: SheetRow = {
    rowIndex: 0,
    title,
    targetUrl,
    marketValue,
    batch: 0,
    date: new Date().toISOString().split('T')[0],
    name: nickname ?? account?.handle ?? '',
  };

  const cliTasks: Promise<void>[] = [];

  if (platforms.includes('x')) {
    cliTasks.push((async () => {
      console.log(`\n${'─'.repeat(40)}\n🐦 X Posting Agent\n${'─'.repeat(40)}`);
      if (!account) {
        result.results.x = { success: false, url: '', error: `Account "${nickname}" not found` };
      } else {
        const r = await runXPostingAgent(row, account, batchCtx);
        result.results.x = { success: r.success, url: r.tweetUrl, error: r.error };
      }
    })());
  }

  if (platforms.includes('facebook')) {
    cliTasks.push((async () => {
      console.log(`\n${'─'.repeat(40)}\n📘 Facebook Posting Agent\n${'─'.repeat(40)}`);
      const r = await runFacebookAgent(row, nickname ?? 'default');
      result.results.facebook = { success: r.success, url: r.postUrl, error: r.error };
    })());
  }

  if (platforms.includes('linkedin')) {
    cliTasks.push((async () => {
      console.log(`\n${'─'.repeat(40)}\n💼 LinkedIn Posting Agent\n${'─'.repeat(40)}`);
      const r = await runLinkedInAgent(row, nickname ?? 'default');
      result.results.linkedin = { success: r.success, url: r.postUrl, error: r.error };
    })());
  }

  await Promise.all(cliTasks);

  // Summary
  console.log(`\n${'='.repeat(50)}\n🧠 Orchestrator Summary\n${'='.repeat(50)}`);
  if (result.results.x)        console.log(`  X       : ${result.results.x.success        ? `✅ ${result.results.x.url}`        : `❌ ${result.results.x.error}`}`);
  if (result.results.facebook) console.log(`  Facebook: ${result.results.facebook.success ? `✅ ${result.results.facebook.url}` : `❌ ${result.results.facebook.error}`}`);
  if (result.results.linkedin) console.log(`  LinkedIn: ${result.results.linkedin.success ? `✅ ${result.results.linkedin.url}` : `❌ ${result.results.linkedin.error}`}`);
  console.log('='.repeat(50));

  return result;
}
