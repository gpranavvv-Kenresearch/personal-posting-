/**
 * supervisor.ts — Master Agent Controller
 *
 * Top-level controller that oversees ALL agents in sequence:
 *   1. SEO Analysis  (SerpAPI → index check + keywords + platform decision)
 *   2. Orchestrator  (dispatches to X / Facebook / LinkedIn posting agents)
 *   3. Sheet writes  (saves results after each platform, with per-platform retry)
 *   4. Error diagnosis + auto-fix on any step failure
 *
 * Called by scheduler.ts for every row in a batch.
 */

import { runOrchestratorForRow } from './masterOrchestrator.js';
import { runSeoAnalysis, SeoAnalysisResult, Platform } from './seoAgent.js';
import {
  SheetRow,
  saveUnifiedSeoData,
  savePostingResult,
  saveUnifiedFbResult,
  saveUnifiedLinkedInResult,
} from '../sheets/sheets.js';
import { XAccount } from '../config/accounts.js';
import { BatchContext } from './sanityAgent.js';
import { callOpenRouter } from '../config/openRouterClient.js';
import { incrementCount, xAccountHasCapacity } from '../config/accountTracker.js';
import fs from 'fs';
import 'dotenv/config';

const DIAGNOSIS_MODEL = 'anthropic/claude-haiku-4-5';
const MAX_PLATFORM_RETRIES = 3;
const SEO_RETRY_MAX = 2;
const ERROR_LOG = 'logs/errors.json';

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface SupervisorErrorLog {
  step: 'seo' | 'x' | 'facebook' | 'linkedin' | 'sheet' | 'unknown';
  error: string;
  diagnosis: string;
  fix: string;
  retryable: boolean;
  time: string;
}

export interface SupervisorResult {
  success: boolean;
  seoData?: SeoAnalysisResult;
  platforms: Platform[];
  xResult?: { success: boolean; url: string; error?: string };
  fbResult?: { success: boolean; url: string; error?: string };
  liResult?: { success: boolean; url: string; error?: string };
  attempts: number;
  errors: SupervisorErrorLog[];
}

// ── Error logging ──────────────────────────────────────────────────────────

function logError(step: string, error: string, attempt: number) {
  fs.mkdirSync('logs', { recursive: true });
  const logs = fs.existsSync(ERROR_LOG)
    ? JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8'))
    : [];
  logs.push({ step, error, attempt, time: new Date().toISOString() });
  fs.writeFileSync(ERROR_LOG, JSON.stringify(logs, null, 2));
}

// ── Error diagnosis via OpenRouter ────────────────────────────────────────

async function diagnoseError(
  step: string,
  error: string,
): Promise<{ agent: string; cause: string; fix: string; retryable: boolean }> {
  console.log(`\n🔍 Supervisor diagnosing error at step "${step}"...`);

  try {
    const response = await callOpenRouter({
      model: DIAGNOSIS_MODEL,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a supervisor agent for a social media posting bot (X, Facebook, LinkedIn).

An error occurred at step: "${step}"
Error: ${error}

Known fixes:
- "invalid x-api-key" → ANTHROPIC_API_KEY is wrong, retryable=false
- "not_found_error model" → wrong model name, retryable=false
- "Target page closed" → second browser conflict, retryable=true
- "Timeout" → selector not found or page slow, retryable=true
- "serpapi" or "402" → SerpAPI quota/key error, retryable=false
- "ENOENT sessions" → session folder missing, fix=mkdir, retryable=true
- "net::ERR" → network error, retryable=true
- "stale session" or "expired" → clear browser session, retryable=true
- "Generation failed" → content generation error, retryable=true
- "Login failed" → browser login issue, retryable=true

Return ONLY valid JSON:
{"agent": "seo|x|facebook|linkedin|unknown", "cause": "short cause", "fix": "short fix description", "retryable": true or false}`,
      }],
    });

    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    return {
      agent: parsed.agent ?? 'unknown',
      cause: parsed.cause ?? 'unknown',
      fix: parsed.fix ?? 'none',
      retryable: parsed.retryable ?? false,
    };
  } catch {
    return { agent: 'unknown', cause: 'diagnosis failed', fix: 'retry as-is', retryable: true };
  }
}

// ── Auto-fix actions ───────────────────────────────────────────────────────

async function applyFix(diagnosis: { cause: string; fix: string }, account?: XAccount): Promise<void> {
  console.log(`   🔧 Cause : ${diagnosis.cause}`);
  console.log(`   🔧 Fix   : ${diagnosis.fix}`);

  const fix = (diagnosis.fix + ' ' + diagnosis.cause).toLowerCase();

  if (fix.includes('session folder') || fix.includes('enoent')) {
    console.log('   🔧 Auto-fix: Creating session folders...');
    fs.mkdirSync('.sessions/chrome-profile-1', { recursive: true });
    fs.mkdirSync('.sessions/chrome-profile-2', { recursive: true });
    fs.mkdirSync('.sessions/chrome-profile-3', { recursive: true });
    if (account?.sessionDir) {
      fs.mkdirSync(account.sessionDir, { recursive: true });
    }
  }

  if (fix.includes('stale') || fix.includes('clear session') || fix.includes('expired')) {
    console.log('   🔧 Auto-fix: Clearing stale session...');
    const dir = account?.sessionDir || '.sessions/chrome-profile';
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  if (fix.includes('wait') || fix.includes('retry')) {
    console.log('   ⏳ Auto-fix: Waiting 5s before retry...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

// ── Main supervised run ────────────────────────────────────────────────────

export async function supervisedRun(
  row: SheetRow,
  account: XAccount,
  batchCtx: BatchContext,
  forcePlatforms?: Platform[],
): Promise<SupervisorResult> {
  const errors: SupervisorErrorLog[] = [];
  let totalAttempts = 0;

  console.log(`\n${'='.repeat(55)}`);
  console.log(`🤖 SUPERVISOR — Row ${row.rowIndex}: ${row.title || row.targetUrl}`);
  if (account?.handle) console.log(`   Account: @${account.handle}`);
  console.log('='.repeat(55));

  // ── STEP 0: Skip already-posted platforms + X capacity check ─────────────
  const skip = {
    x:        row.xStatus?.toLowerCase()       === 'posted',
    facebook: row.fbStatus?.toLowerCase()      === 'posted',
    linkedin: row.linkedinStatus?.toLowerCase() === 'posted',
  };
  if (skip.x)        console.log(`   ⏭️  X already posted — skipping`);
  if (skip.facebook) console.log(`   ⏭️  Facebook already posted — skipping`);
  if (skip.linkedin) console.log(`   ⏭️  LinkedIn already posted — skipping`);

  // Check X daily limit (12/account/day)
  if (!skip.x && account?.nickname && !xAccountHasCapacity(account.nickname)) {
    console.log(`   ⛔ @${account.handle} has hit daily X limit (12/day) — skipping X`);
    skip.x = true;
  }

  // ── STEP 1: SEO Analysis (skipped when forcePlatforms is set) ────────────
  let seoData: SeoAnalysisResult | undefined;
  let platforms: Platform[] = [];

  if (forcePlatforms && forcePlatforms.length > 0) {
    console.log(`   📌 Forced platforms: ${forcePlatforms.join(', ')} — skipping SEO analysis`);
    platforms = forcePlatforms;
  }

  for (let attempt = 1; attempt <= (forcePlatforms ? 0 : SEO_RETRY_MAX); attempt++) {
    try {
      seoData = await runSeoAnalysis(row.targetUrl, row.title);
      platforms = seoData.platforms;

      // Write SEO data to sheet immediately
      try {
        await saveUnifiedSeoData(row, seoData);
      } catch (sheetErr: any) {
        console.warn(`   ⚠️  Could not write SEO data to sheet: ${sheetErr.message}`);
      }
      break;
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error(`\n❌ SEO analysis failed (attempt ${attempt}): ${errMsg}`);
      logError('seo', errMsg, attempt);

      const diag = await diagnoseError('seo', errMsg);
      errors.push({ step: 'seo', error: errMsg, diagnosis: diag.cause, fix: diag.fix, retryable: diag.retryable, time: new Date().toISOString() });

      if (!diag.retryable || attempt >= SEO_RETRY_MAX) {
        console.log(`   ⚠️  SEO analysis unavailable — defaulting to X only`);
        platforms = ['x'];
        break;
      }
      await applyFix(diag, account);
    }
  }

  // Remove already-posted platforms from the list
  if (skip.x)        platforms = platforms.filter(p => p !== 'x');
  if (skip.facebook) platforms = platforms.filter(p => p !== 'facebook');
  if (skip.linkedin) platforms = platforms.filter(p => p !== 'linkedin');

  if (platforms.length === 0) {
    console.log(`   ✅ All platforms already posted — nothing to do`);
    return { success: true, seoData, platforms: [], xResult: undefined, fbResult: undefined, liResult: undefined, attempts: 0, errors };
  }

  console.log(`\n🎯 Platforms to post: ${platforms.join(', ')}`);

  // ── STEP 2: Dispatch via orchestrator + retry per platform ────────────────
  let xResult: SupervisorResult['xResult'];
  let fbResult: SupervisorResult['fbResult'];
  let liResult: SupervisorResult['liResult'];

  for (let attempt = 1; attempt <= MAX_PLATFORM_RETRIES; attempt++) {
    totalAttempts = attempt;
    try {
      const orchResult = await runOrchestratorForRow(row, account, batchCtx, platforms);

      // ── Process X result ───────────────────────────────────────────────────
      if (orchResult.results.x) {
        const r = orchResult.results.x;
        xResult = { success: r.success, url: r.tweetUrl, error: r.error };

        if (r.success) {
          if (account?.nickname) incrementCount('x', account.nickname);
          try {
            await savePostingResult(row, { xPost: r.tweetText, xPostUrl: r.tweetUrl, xStatus: 'Posted', xError: '', seoScore: r.seoScore, sanityIssues: r.sanityIssues, messageStatus: 'Done' });
          } catch (sheetErr: any) {
            console.warn(`   ⚠️  Could not save X result to sheet: ${sheetErr.message}`);
          }
          // Remove X from retry list — it succeeded
          platforms = platforms.filter(p => p !== 'x');
        } else {
          console.error(`\n❌ X posting failed: ${r.error}`);
          logError('x', r.error ?? 'unknown', attempt);
          const diag = await diagnoseError('x', r.error ?? 'unknown');
          errors.push({ step: 'x', error: r.error ?? '', diagnosis: diag.cause, fix: diag.fix, retryable: diag.retryable, time: new Date().toISOString() });

          if (!diag.retryable) {
            await savePostingResult(row, { xPost: r.tweetText, xPostUrl: '', xStatus: 'Failed', xError: r.error ?? '', seoScore: r.seoScore, sanityIssues: r.sanityIssues, messageStatus: 'Failed' }).catch(() => {});
            platforms = platforms.filter(p => p !== 'x');
          } else {
            await applyFix(diag, account);
          }
        }
      }

      // ── Process Facebook result ────────────────────────────────────────────
      if (orchResult.results.facebook) {
        const r = orchResult.results.facebook;
        fbResult = { success: r.success, url: r.postUrl, error: r.error };

        if (r.success) {
          try {
            await saveUnifiedFbResult(row, { post: r.postText, postUrl: r.postUrl, status: 'Posted', error: '' });
          } catch (sheetErr: any) {
            console.warn(`   ⚠️  Could not save FB result to sheet: ${sheetErr.message}`);
          }
          platforms = platforms.filter(p => p !== 'facebook');
        } else {
          console.error(`\n❌ Facebook posting failed: ${r.error}`);
          logError('facebook', r.error ?? 'unknown', attempt);
          const diag = await diagnoseError('facebook', r.error ?? 'unknown');
          errors.push({ step: 'facebook', error: r.error ?? '', diagnosis: diag.cause, fix: diag.fix, retryable: diag.retryable, time: new Date().toISOString() });

          if (!diag.retryable) {
            await saveUnifiedFbResult(row, { post: r.postText, postUrl: '', status: 'Failed', error: r.error ?? '' }).catch(() => {});
            platforms = platforms.filter(p => p !== 'facebook');
          } else {
            await applyFix(diag, account);
          }
        }
      }

      // ── Process LinkedIn result ────────────────────────────────────────────
      if (orchResult.results.linkedin) {
        const r = orchResult.results.linkedin;
        liResult = { success: r.success, url: r.postUrl, error: r.error };

        if (r.success) {
          try {
            await saveUnifiedLinkedInResult(row, { post: r.postText, postUrl: r.postUrl, status: 'Posted', error: '' });
          } catch (sheetErr: any) {
            console.warn(`   ⚠️  Could not save LinkedIn result to sheet: ${sheetErr.message}`);
          }
          platforms = platforms.filter(p => p !== 'linkedin');
        } else {
          console.error(`\n❌ LinkedIn posting failed: ${r.error}`);
          logError('linkedin', r.error ?? 'unknown', attempt);
          const diag = await diagnoseError('linkedin', r.error ?? 'unknown');
          errors.push({ step: 'linkedin', error: r.error ?? '', diagnosis: diag.cause, fix: diag.fix, retryable: diag.retryable, time: new Date().toISOString() });

          if (!diag.retryable) {
            await saveUnifiedLinkedInResult(row, { post: r.postText, postUrl: '', status: 'Failed', error: r.error ?? '' }).catch(() => {});
            platforms = platforms.filter(p => p !== 'linkedin');
          } else {
            await applyFix(diag, account);
          }
        }
      }

      // All platforms done (either succeeded or non-retryable failed)
      if (platforms.length === 0) break;

    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.error(`\n❌ Orchestrator error (attempt ${attempt}): ${errMsg}`);
      logError('unknown', errMsg, attempt);

      if (attempt >= MAX_PLATFORM_RETRIES) {
        console.error('\n🚨 Max retries reached.');
        errors.push({ step: 'unknown', error: errMsg, diagnosis: 'max retries', fix: 'manual intervention needed', retryable: false, time: new Date().toISOString() });
        break;
      }

      const diag = await diagnoseError('orchestrator', errMsg);
      errors.push({ step: 'unknown', error: errMsg, diagnosis: diag.cause, fix: diag.fix, retryable: diag.retryable, time: new Date().toISOString() });

      if (!diag.retryable) break;
      await applyFix(diag, account);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const anySuccess = xResult?.success || fbResult?.success || liResult?.success;

  console.log(`\n${'='.repeat(55)}`);
  console.log(`🤖 Supervisor Summary — Row ${row.rowIndex}`);
  console.log('='.repeat(55));
  if (xResult)  console.log(`  X        : ${xResult.success  ? `✅ ${xResult.url}`  : `❌ ${xResult.error}`}`);
  if (fbResult) console.log(`  Facebook : ${fbResult.success ? `✅ ${fbResult.url}` : `❌ ${fbResult.error}`}`);
  if (liResult) console.log(`  LinkedIn : ${liResult.success ? `✅ ${liResult.url}` : `❌ ${liResult.error}`}`);
  if (errors.length > 0) console.log(`  Errors   : ${errors.length}`);
  console.log('='.repeat(55));

  return {
    success: anySuccess ?? false,
    seoData,
    platforms: [
      ...(xResult?.success  ? ['x' as Platform]        : []),
      ...(fbResult?.success ? ['facebook' as Platform]  : []),
      ...(liResult?.success ? ['linkedin' as Platform]  : []),
    ],
    xResult,
    fbResult,
    liResult,
    attempts: totalAttempts,
    errors,
  };
}
