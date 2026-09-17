/**
 * Pull report titles from the "Blogs" sheet, generate a cover image for each
 * via ChatGPT (Playwright), save it to a local folder, and write the local
 * file path back into the "Local Image Path" column.
 *
 *   npx tsx src/tools/runBlogCoverImageLocal.ts              # up to 3 pending rows
 *   npx tsx src/tools/runBlogCoverImageLocal.ts --limit 5
 *   npx tsx src/tools/runBlogCoverImageLocal.ts --row 42     # single specific row
 *
 * Run `npx tsx src/tools/addBlogImageColumns.ts` once first if the "Local
 * Image Path" column doesn't exist yet on the Blogs tab.
 */
import 'dotenv/config';
import path from 'path';
import { getBlogRowsNeedingLocalImage, getSheetRowByIndex, saveLocalImagePath, SheetRow } from '../sheets/sheets.js';
import { generateCoverImageLocalOnly } from '../agents/blogImageAgent.js';

const OUTPUT_DIR = path.resolve('generated_images/blog-covers');

function parseArgs() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const rowIdx = args.indexOf('--row');
  return {
    limit: limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 3,
    row: rowIdx >= 0 ? parseInt(args[rowIdx + 1], 10) : undefined,
  };
}

async function processRow(row: SheetRow): Promise<void> {
  console.log(`\n▶ Row ${row.rowIndex}: "${row.title}"`);
  if (!row.title) {
    console.warn('   ⚠️  No title on this row — skipping.');
    return;
  }
  try {
    const localPath = await generateCoverImageLocalOnly({
      marketName: row.title,
      reportUrl: row.targetUrl || '',
      outputDir: OUTPUT_DIR,
    });
    await saveLocalImagePath({ rowIndex: row.rowIndex }, localPath);
    console.log(`   ✅ Saved and recorded: ${localPath}`);
  } catch (err: any) {
    console.error(`   ❌ Failed on row ${row.rowIndex}: ${err.message}`);
  }
}

(async () => {
  const { limit, row: rowArg } = parseArgs();

  if (rowArg) {
    const row = await getSheetRowByIndex(rowArg, 'blog');
    if (!row) {
      console.error(`❌ Row ${rowArg} not found on Blogs tab`);
      process.exit(1);
    }
    await processRow(row);
    process.exit(0);
  }

  const rows = await getBlogRowsNeedingLocalImage(limit);
  if (rows.length === 0) {
    console.log('No Blogs-tab rows need a local cover image right now.');
    process.exit(0);
  }
  console.log(`Found ${rows.length} row(s) needing a local cover image.`);
  for (const row of rows) {
    await processRow(row);
  }
  process.exit(0);
})();
