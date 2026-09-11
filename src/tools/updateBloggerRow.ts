// One-shot: update Blogger Post URL for a specific sheet row
import { getSheetRowByIndex, saveUnifiedBloggerResult } from '../sheets/sheets.js';

const SHEET_ROW_INDEX = 2; // actual sheet row number (header=1, first data row=2)
const POST_URL = 'https://aniketmarketer.blogspot.com/2026/04/why-iran-automotive-market-is-stronger_30.html';

(async () => {
  console.log(`Fetching row ${SHEET_ROW_INDEX} from sheet...`);
  const row = await getSheetRowByIndex(SHEET_ROW_INDEX, 'blog');
  if (!row) { console.error(`Row ${SHEET_ROW_INDEX} not found`); process.exit(1); }
  console.log(`Row ${SHEET_ROW_INDEX}: "${row.title?.slice(0, 60)}"`);
  await saveUnifiedBloggerResult(row, {
    postUrl: POST_URL,
    status: 'Posted',
    batch: '1',
  });
  console.log(`✅ Sheet updated with Blogger URL for row ${SHEET_ROW_INDEX}`);
})();
