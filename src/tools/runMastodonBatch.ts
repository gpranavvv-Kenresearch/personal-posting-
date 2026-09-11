/**
 * runMastodonBatch.ts — Run one Mastodon posting batch.
 *
 * Usage:
 *   npx tsx src/tools/runMastodonBatch.ts [batchNum]
 */
import 'dotenv/config';
import { runMastodonBatch } from '../coordinator/masterCoordinator.js';

const batchNum = parseInt(process.argv[2] || '1', 10);

runMastodonBatch(batchNum)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Mastodon batch failed:', err.message);
    process.exit(1);
  });
