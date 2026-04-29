/**
 * getPendingRows.ts — CLI intervention tool for Claude
 *
 * Called by Claude CLI to see what rows are pending for a given platform today.
 * Uses existing sheet functions so logic is identical to what npm run dev uses.
 *
 * Usage:
 *   npx tsx src/tools/getPendingRows.ts --platform x
 *   npx tsx src/tools/getPendingRows.ts --platform fb --limit 5
 *   npx tsx src/tools/getPendingRows.ts --platform li --limit 10
 *
 * Output:
 *   [{"rowIndex":42,"title":"Bahrain Aerogel","targetUrl":"...","priority":"P1","lastPostedX":""},...]
 */

import 'dotenv/config';
import {
  getRowsForContinuousXPosting,
  getRowsForContinuousFbPosting,
  getRowsForContinuousLiPosting,
} from '../sheets/sheets.js';

function out(data: object) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const platform = get('--platform')?.toLowerCase();
  const limitStr = get('--limit');
  const limit = limitStr ? parseInt(limitStr, 10) : 15;

  if (!platform) {
    out({ error: '--platform is required. Use: x, fb, li' });
    process.exit(1);
  }

  try {
    let rows;

    if (platform === 'x' || platform === 'twitter') {
      rows = await getRowsForContinuousXPosting(limit);
    } else if (platform === 'fb' || platform === 'facebook') {
      rows = await getRowsForContinuousFbPosting(limit);
    } else if (platform === 'li' || platform === 'linkedin') {
      rows = await getRowsForContinuousLiPosting(limit);
    } else {
      out({ error: `Unknown platform: ${platform}. Use: x, fb, li` });
      process.exit(1);
    }

    // Return only the fields Claude needs to decide what to do
    const summary = rows.map(r => ({
      rowIndex: r.rowIndex,
      title: r.title,
      targetUrl: r.targetUrl,
      priority: r.seoRanking ?? r.priority ?? 'unknown',
      lastPostedX: r.lastPostedX ?? '',
      lastPostedFb: r.lastPostedFb ?? '',
      lastPostedLi: r.lastPostedLi ?? '',
      xStatus: r.xStatus ?? '',
      fbStatus: r.fbStatus ?? '',
      linkedinStatus: r.linkedinStatus ?? '',
      name: r.name,
    }));

    out(summary);
  } catch (err: any) {
    out({ error: err.message });
  }
}

main();
