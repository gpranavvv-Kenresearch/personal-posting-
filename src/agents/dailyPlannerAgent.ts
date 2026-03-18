/**
 * dailyPlannerAgent.ts — AI Daily Posting Planner
 *
 * Runs at 10:30 AM every day.
 * Looks at total backlog across all 3 platforms,
 * then uses AI to decide how many posts to do on each platform today.
 *
 * Varies daily to look natural — LinkedIn some days 3, some days 8.
 * Adjusts X volume up when LinkedIn/FB backlogs are small.
 * Never exceeds platform hard limits.
 */

import { callOpenRouter } from '../config/openRouterClient.js';
import { getUnassignedRows } from '../sheets/sheets.js';

const PLANNER_MODEL = 'google/gemini-2.0-flash-001';

// Hard safety ceilings — based on per-account daily limits × number of accounts
const HARD_LIMITS = {
  x:        { max: 180, perAccount: 12 },  // 15 accounts × 12/day
  facebook: { max: 52,  perAccount: 4  },  // 13 accounts × 4/day
  linkedin: { max: 42,  perAccount: 3  },  // 14 accounts × 3/day
};

export interface DailyPlan {
  x:        number;
  facebook: number;
  linkedin: number;
  reasoning: string;
  backlog: { x: number; facebook: number; linkedin: number };
}

// ── Fetch current backlog from all 3 sheets ───────────────────────────────

async function getBacklogCounts(): Promise<{ x: number; facebook: number; linkedin: number }> {
  const rows = await getUnassignedRows();
  // Single unified sheet — all 3 platforms share the same rows.
  // Each row is posted to X always; FB + LI decided per-row by seoAgent based on rank.
  // All 3 show the same backlog count so AI understands the full picture.
  return {
    x:        rows.length,
    facebook: 0,
    linkedin: 0,
  };
}

// ── AI decides today's targets ────────────────────────────────────────────

async function askAIForPlan(backlog: { x: number; facebook: number; linkedin: number }): Promise<{
  x: number; facebook: number; linkedin: number; reasoning: string;
}> {
  const totalBacklog = backlog.x + backlog.facebook + backlog.linkedin;

  try {
    const response = await callOpenRouter({
      model: PLANNER_MODEL,
      max_tokens: 300,
      system: `You are a social media posting planner for Ken Research, a B2B market research firm.
You have a unified queue of report URLs. Each URL is always posted to X. Facebook and LinkedIn get posts only for URLs ranking poorly on Google (SEO agent decides per-row).

HARD DAILY LIMITS (never exceed):
- X        : 180 posts/day (15 accounts × 12/day)
- Facebook : 52  posts/day (13 accounts × 4/day)  — subset of X rows
- LinkedIn : 42  posts/day (14 accounts × 3/day)  — subset of X rows

You only need to decide how many ROWS to process today (X count drives everything).
Natural variation: 80–150 rows/day. Don't always hit max — looks unnatural.
Goal: drain the backlog steadily over time.

Return ONLY valid JSON (no markdown):
{"x": <number between 80-150>, "facebook": 0, "linkedin": 0, "reasoning": "<1 sentence why>"}`,
      messages: [{
        role: 'user',
        content: `Today's backlog: ${backlog.x} unprocessed report URLs waiting to be posted.
Each URL is guaranteed to post to X.
Facebook and LinkedIn are conditional subsets chosen later by SEO.
How many rows should we process today?`,
      }],
    });

    const raw = response.content[0]?.text ?? '';
    const match = raw.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as {
        x?: number; facebook?: number; linkedin?: number; reasoning?: string;
      };
      return {
        x:        Math.min(parsed.x        ?? 100, HARD_LIMITS.x.max,        backlog.x),
        facebook: Math.min(parsed.facebook ?? 30,  HARD_LIMITS.facebook.max, backlog.facebook),
        linkedin: Math.min(parsed.linkedin ?? 10,  HARD_LIMITS.linkedin.max, backlog.linkedin),
        reasoning: parsed.reasoning ?? 'AI plan applied',
      };
    }
  } catch (err: any) {
    console.warn(`   ⚠️  AI planner failed (${err.message}) — using smart defaults`);
  }

  // Fallback: proportional defaults based on backlog size
  return {
    x:        Math.min(Math.ceil(backlog.x        * 0.4), HARD_LIMITS.x.max),
    facebook: Math.min(Math.ceil(backlog.facebook * 0.4), HARD_LIMITS.facebook.max),
    linkedin: Math.min(Math.ceil(backlog.linkedin * 0.3), HARD_LIMITS.linkedin.max),
    reasoning: 'Fallback: process about 40% of the unified backlog',
  };
}

// ── Main entry ────────────────────────────────────────────────────────────

export async function runDailyPlannerAgent(): Promise<DailyPlan> {
  console.log(`\n${'='.repeat(50)}`);
  console.log('🧠 Daily Planner Agent — deciding today\'s posting budget');
  console.log('='.repeat(50));

  // 1. Check backlog
  console.log('\n📊 Fetching backlog from unified sheet (insta)...');
  const backlog = await getBacklogCounts();
  console.log(`\n   Unassigned rows : ${backlog.x} URLs`);
  console.log(`   Each row → X always + FB/LinkedIn decided per-row by SEO rank`);

  if (backlog.x === 0) {
    console.log('\n✅ No backlog — nothing to plan today.');
    return { x: 0, facebook: 0, linkedin: 0, reasoning: 'No backlog', backlog };
  }

  // 2. Ask AI
  console.log('\n🤖 Asking AI for today\'s optimal posting plan...');
  const plan = await askAIForPlan(backlog);

  console.log(`\n📋 Today's plan:`);
  console.log(`   Rows to process : ${plan.x}`);
  console.log(`   Guaranteed      : ${plan.x} X posts`);
  console.log(`   Conditional     : Facebook / LinkedIn only on SEO-selected rows`);
  console.log(`   Reason          : ${plan.reasoning}`);
  console.log('='.repeat(50));

  return { ...plan, backlog };
}
