/**
 * leftoverPriorityAgent.ts — Leftover Queue Mover
 * Scans the entire sheet for rows where X Post AND X Post URL are both empty
 * (but title + targetUrl are present), then moves them to the end of the sheet.
 *
 * Flow:
 *   1. Scan entire sheet — no date restriction (1 API call)
 *   2. Batch append all leftover rows at bottom with title + targetUrl only (1 API call)
 *   3. Batch clear title + targetUrl in all original rows (1-2 API calls)
 *
 * Total: ~4 API calls regardless of how many rows there are.
 *
 * Does NOT post tweets — moved rows need name/batch/date filled in manually
 * before the scheduler can process them.
 *
 * Trigger: daily 10:45 AM IST (auto) OR npm run dev -- leftover (manual)
 */

import { getAllLeftoverRows, appendLeftoverRowsBatch, deleteLeftoverOriginalRowsBatch } from '../sheets/sheets.js';

export interface LeftoverMoveResult {
  moved: number;
}

export async function moveLeftoversToQueue(): Promise<LeftoverMoveResult> {
  console.log(`   🔍 Scanning entire sheet for leftover rows...`);

  const rows = await getAllLeftoverRows();

  if (rows.length === 0) {
    return { moved: 0 };
  }

  console.log(`   📦 Found ${rows.length} rows to move:\n`);
  for (const row of rows) {
    console.log(`   ♻️  Row ${row.rowIndex} (@${row.name || 'unknown'}): "${row.title.slice(0, 60)}"`);
  }

  // Batch append — ONE API call for all rows
  console.log(`\n   📤 Appending ${rows.length} rows to end of sheet...`);
  await appendLeftoverRowsBatch(rows.map(r => ({ title: r.title, targetUrl: r.targetUrl })));
  console.log(`   ✅ Appended`);

  // Batch delete entire original rows (sorted descending to preserve indices)
  console.log(`   🗑️  Deleting ${rows.length} original rows...`);
  await deleteLeftoverOriginalRowsBatch(rows.map(r => r.rowIndex));
  console.log(`   ✅ Original rows deleted`);

  return { moved: rows.length };
}
