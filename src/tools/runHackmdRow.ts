/**
 * Run HackMD posting for a single row by sheet index.
 *   npx tsx src/tools/runHackmdRow.ts 124
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { runHackMDBatchAgent } from '../agents/hackmdBatchAgentNew.js';

const rowIndex = parseInt(process.argv[2] || '124', 10);

(async () => {
  console.log(`\nFetching blog sheet row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'blog');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in Blogs sheet`);
    process.exit(1);
  }

  console.log(`   Title   : ${row.title}`);
  console.log(`   Account : ${row.name}`);
  console.log(`   Content : ${row.blogContent ? row.blogContent.slice(0, 80) + '...' : '(empty)'}`);

  if (!row.blogContent) {
    console.error('❌ No blog content in row — cannot post');
    process.exit(1);
  }

  console.log('\nRunning HackMD post...\n');
  const result = await runHackMDBatchAgent({ rows: [row], batchNum: 1 });
  console.log('\nResult:', JSON.stringify(result, null, 2));
  process.exit(0);
})();
