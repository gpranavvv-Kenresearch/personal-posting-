/**
 * runPearltreesBatch.ts — Run one Pearltrees posting batch.
 * Picks up to 15 pending Social Media rows (Pearltrees Status empty) via
 * getRowsForContinuousPearltreesPosting, posts each with its assigned
 * account, writes results back to the sheet.
 *
 * Usage:
 *   npx tsx src/tools/runPearltreesBatch.ts [batchNum]
 *   Example: npx tsx src/tools/runPearltreesBatch.ts 1
 */
import 'dotenv/config';
import { runPearltreesBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runPearltreesBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Pearltrees batch failed:', err.message);
    process.exit(1);
  });
