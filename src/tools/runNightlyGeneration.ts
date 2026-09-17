/**
 * runNightlyGeneration.ts — manually trigger blog generation (text + cover
 * image) AND social-card image (LI carousel) generation together, without
 * re-running the RSS/Distributed-URL feed step. Use this if the 18:30 IST
 * cron tick was missed (e.g. daemon was down) but New Logic already has
 * rows pending — both generation functions just pick whatever's pending on
 * the sheet regardless of how it got there.
 *
 * Usage:
 *   npx tsx src/tools/runNightlyGeneration.ts
 */
import 'dotenv/config';
import { runGenerationOnly } from '../coordinator/rssFeeder.js';

runGenerationOnly()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
