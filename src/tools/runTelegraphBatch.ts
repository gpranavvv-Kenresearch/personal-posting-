/**
 * runTelegraphBatch.ts — Run one Telegraph posting batch.
 *
 * Usage:
 *   npx tsx src/tools/runTelegraphBatch.ts [batchNum]
 */
import 'dotenv/config';
import { runTelegraphBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runTelegraphBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Telegraph batch failed:', err.message);
    process.exit(1);
  });
