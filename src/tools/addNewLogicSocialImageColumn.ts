import 'dotenv/config';
import { ensureSheetColumns } from '../sheets/sheets.js';

ensureSheetColumns('newLogic', ['Social Post Image Path'])
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
