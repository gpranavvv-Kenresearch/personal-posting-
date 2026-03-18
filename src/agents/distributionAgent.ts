/**
 * distributionAgent.ts — URL Distribution Planner
 *
 * Assigns unassigned rows from X Sheet, FB Sheet, LinkedIn Sheet
 * to accounts + batch slots for today.
 *
 * Targets are set by dailyPlannerAgent (AI decides how many per platform).
 * Per-account max is derived from the target ÷ number of active accounts.
 *
 * Usage:
 *   npm run dev -- distribute          → manual run with AI-decided targets
 *   npm run dev -- distribute 300      → manual run, cap total at 300
 */

import {
  getUnassignedRows,
  assignRowsBatch,
  RowAssignment,
} from '../sheets/sheets.js';
import { getAccounts } from '../config/accounts.js';

// ── Hard safety ceilings ───────────────────────────────────────────────────
// Platform routing is now done per-row by seoAgent at post time.
// Distribution just assigns account + batch + date to unassigned rows.

// Window 11:00–17:30 IST = 390 min. Min gap per batch ~50 min → max 8 batches.
// 8 batches × 15 accounts = 120 rows max per day to stay within the posting window.
const HARD_LIMITS = {
  x: { perAccount: 12, maxTotal: 180 },
};

// ── Target override from dailyPlannerAgent ─────────────────────────────────

export interface PlatformTargets {
  x:        number;
  facebook: number;
  linkedin: number;
}

// ── Assign rows to accounts + batch slots ─────────────────────────────────
//
// Groups rows into batches where each batch = one full round of all accounts.
// Batch 1: accounts 1–15 (first post each)
// Batch 2: accounts 1–15 (second post each)
// ...
// Batch N: accounts 1–K (last partial round if rows don't divide evenly)
//
// This ensures:
//   - Each batch fires with all 15 accounts posting ~simultaneously (8s apart)
//   - Batch count = ceil(totalRows / accountCount)
//   - Scheduler can space batches by accountCount × ~3 min = ~45 min each

function buildAssignments(
  rows: Array<{ rowIndex: number; name?: string }>,
  nicknames: string[],
  today: string,
): RowAssignment[] {
  if (nicknames.length === 0) return [];

  const assignments: RowAssignment[] = [];
  const n = nicknames.length;
  let autoIdx = 0; // round-robin counter only for rows without a pre-filled name

  for (let i = 0; i < rows.length; i++) {
    const prefilled = rows[i].name?.trim();
    const name = prefilled || nicknames[autoIdx % n];
    if (!prefilled) autoIdx++;

    const batchNum = Math.floor(i / n) + 1;

    assignments.push({
      rowIndex: rows[i].rowIndex,
      name,
      batch: batchNum,
      date:  today,
    });
  }

  return assignments;
}

// ── Main distribution function ─────────────────────────────────────────────

export interface DistributionResult {
  x: number;
  facebook: number;
  linkedin: number;
  total: number;
  skipped: number;
  xBatchesUsed: number[];   // distinct batch numbers assigned to X rows today
}

export async function runDistributionAgent(
  targets?: PlatformTargets,
  maxRows?: number,
): Promise<DistributionResult> {
  const today = new Date().toISOString().split('T')[0];

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📦 Distribution Agent — ${today}`);
  console.log('='.repeat(50));

  // ── Load X accounts ────────────────────────────────────────────────────
  // Platform routing (X / FB / LI) is decided per-row by seoAgent at post time.
  // Distribution only assigns X account + batch + date so the scheduler can fire.
  const xNicknames = getAccounts()
    .filter(a => a.active && (a.nickname || a.handle))
    .map(a => a.nickname ?? a.handle);

  console.log(`👥 Active X accounts: ${xNicknames.length}`);

  // ── Read all unassigned rows from unified sheet ───────────────────────
  console.log(`\n🔍 Scanning for unassigned rows...`);
  const allRows = await getUnassignedRows();

  console.log(`\n📋 Unassigned rows found: ${allRows.length}`);

  // ── Determine today's target ───────────────────────────────────────────
  const xTarget = targets
    ? Math.min(targets.x, HARD_LIMITS.x.maxTotal, allRows.length)
    : Math.min(HARD_LIMITS.x.maxTotal, allRows.length);

  const cap = maxRows ?? xTarget;
  const rowsToAssign = allRows.slice(0, cap);

  const batchCount = xNicknames.length > 0 ? Math.ceil(cap / xNicknames.length) : 0;
  console.log(`\n📐 Today's assignment: ${rowsToAssign.length} rows | ${xNicknames.length} accounts | ${batchCount} batches`);

  // ── Build and write assignments ────────────────────────────────────────
  const assignments = buildAssignments(rowsToAssign, xNicknames, today);

  console.log(`\n📝 Writing assignments to sheet...`);
  await assignRowsBatch(assignments);

  const skipped = allRows.length - assignments.length;
  const xBatchesUsed = [...new Set(assignments.map(a => a.batch))].sort((a, b) => a - b);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ Distribution complete!`);
  console.log(`   Assigned : ${assignments.length} rows across batches [${xBatchesUsed.join(', ')}]`);
  if (skipped > 0) console.log(`   Skipped  : ${skipped} (over safe daily limit)`);
  console.log('='.repeat(50));

  return {
    x: assignments.length,
    facebook: 0,
    linkedin: 0,
    total: assignments.length,
    skipped,
    xBatchesUsed,
  };
}
