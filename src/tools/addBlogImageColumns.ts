import 'dotenv/config';
import { ensureSheetColumns } from '../sheets/sheets.js';

const COLUMNS = ['Local Image Path'];

ensureSheetColumns('blog', COLUMNS)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
