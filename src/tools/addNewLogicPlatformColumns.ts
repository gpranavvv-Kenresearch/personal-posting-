import 'dotenv/config';
import { ensureSheetColumns } from '../sheets/sheets.js';

const COLUMNS = [
  // 4shared
  '4shared Post URL', '4shared Status', '4shared Error', '4shared Batch', 'Last Posted 4shared',
  // Scribd
  'Scribd Post URL', 'Scribd Status', 'Scribd Error', 'Scribd Batch', 'Last Posted Scribd',
];

ensureSheetColumns('newLogic', COLUMNS)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
