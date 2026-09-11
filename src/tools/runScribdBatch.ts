/**
 * runScribdBatch.ts — Run one Scribd posting batch.
 *
 * Usage:
 *   npx tsx src/tools/runScribdBatch.ts [batchNum]
 */
import 'dotenv/config';
import { runScribdBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runScribdBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Scribd batch failed:', err.message);
    process.exit(1);
  });
