/**
 * runInstapaperBatch.ts — Run one Instapaper posting batch.
 *
 * Usage:
 *   npx tsx src/tools/runInstapaperBatch.ts [batchNum]
 */
import 'dotenv/config';
import { runInstapaperBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runInstapaperBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Instapaper batch failed:', err.message);
    process.exit(1);
  });
