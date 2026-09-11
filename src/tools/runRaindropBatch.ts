/**
 * runRaindropBatch.ts — Run one Raindrop posting batch.
 *
 * Usage:
 *   npx tsx src/tools/runRaindropBatch.ts [batchNum]
 */
import 'dotenv/config';
import { runRaindropBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runRaindropBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Raindrop batch failed:', err.message);
    process.exit(1);
  });
