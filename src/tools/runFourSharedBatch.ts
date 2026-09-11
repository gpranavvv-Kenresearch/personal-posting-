/**
 * runFourSharedBatch.ts — Run one 4shared posting batch.
 *
 * Usage:
 *   npx tsx src/tools/runFourSharedBatch.ts [batchNum]
 */
import 'dotenv/config';
import { runFourSharedBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runFourSharedBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ 4shared batch failed:', err.message);
    process.exit(1);
  });
