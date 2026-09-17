/**
 * Pull report titles from the "Blogs" sheet, generate a simple branded
 * social-card image for each (for an FB/LinkedIn/X TEXT post, not the blog
 * article itself) via ChatGPT (Playwright), save it to a local folder, and
 * write the local file path back into the "Social Post Image Path" column.
 *
 *   npx tsx src/tools/runSocialPostImageLocal.ts              # up to 3 pending rows
 *   npx tsx src/tools/runSocialPostImageLocal.ts --limit 5
 *   npx tsx src/tools/runSocialPostImageLocal.ts --row 42     # single specific row
 *
 * Run `npx tsx src/tools/addSocialPostImageColumn.ts` once first if the
 * "Social Post Image Path" column doesn't exist yet on the Blogs tab.
 */
import 'dotenv/config';
import path from 'path';
import { getBlogRowsNeedingSocialPostImage, getSheetRowByIndex, saveSocialPostImagePath, SheetRow } from '../sheets/sheets.js';
import { generateSocialPostImageLocalOnly } from '../agents/socialPostImageAgent.js';

const OUTPUT_DIR = path.resolve('generated_images/social-post-cards');

function parseArgs() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const rowIdx = args.indexOf('--row');
  const accountIdx = args.indexOf('--account');
  return {
    limit: limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 3,
    row: rowIdx >= 0 ? parseInt(args[rowIdx + 1], 10) : undefined,
    account: accountIdx >= 0 ? args[accountIdx + 1] : undefined,
  };
}

async function processRow(row: SheetRow, accountHandle?: string): Promise<void> {
  console.log(`\n▶ Row ${row.rowIndex}: "${row.title}"`);
  if (!row.title) {
    console.warn('   ⚠️  No title on this row — skipping.');
    return;
  }
  try {
    const localPath = await generateSocialPostImageLocalOnly({
      title: row.title,
      reportUrl: row.targetUrl || '',
      outputDir: OUTPUT_DIR,
      accountHandle,
    });
    await saveSocialPostImagePath({ rowIndex: row.rowIndex }, localPath);
    console.log(`   ✅ Saved and recorded: ${localPath}`);
  } catch (err: any) {
    console.error(`   ❌ Failed on row ${row.rowIndex}: ${err.message}`);
  }
}

(async () => {
  const { limit, row: rowArg, account } = parseArgs();

  if (rowArg) {
    const row = await getSheetRowByIndex(rowArg, 'blog');
    if (!row) {
      console.error(`❌ Row ${rowArg} not found on Blogs tab`);
      process.exit(1);
    }
    await processRow(row, account);
    process.exit(0);
  }

  const rows = await getBlogRowsNeedingSocialPostImage(limit);
  if (rows.length === 0) {
    console.log('No Blogs-tab rows need a social-post image right now.');
    process.exit(0);
  }
  console.log(`Found ${rows.length} row(s) needing a social-post image.`);
  for (const row of rows) {
    await processRow(row, account);
  }
  process.exit(0);
})();
