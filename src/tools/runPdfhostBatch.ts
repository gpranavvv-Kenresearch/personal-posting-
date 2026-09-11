/**
 * runPdfhostBatch.ts — Run one PdfHost posting batch.
 *
 * Usage:
 *   npx tsx src/tools/runPdfhostBatch.ts [batchNum]
 */
import 'dotenv/config';
import { runPdfhostBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runPdfhostBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ PdfHost batch failed:', err.message);
    process.exit(1);
  });
