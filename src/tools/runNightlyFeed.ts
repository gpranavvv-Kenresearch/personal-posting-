/**
 * runNightlyFeed.ts — manually trigger the FULL nightly pipeline: RSS
 * catch-up poll, New Logic feed (100/day quota), Social Media feed (200/day
 * quota), then blog generation + social-card image generation. Use this if
 * the entire 18:30 IST cron tick was missed.
 *
 * Usage:
 *   npx tsx src/tools/runNightlyFeed.ts
 */
import 'dotenv/config';
import { runNightlyRssFeed } from '../coordinator/rssFeeder.js';

runNightlyRssFeed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
