import 'dotenv/config';
import { ensureSheetColumns } from '../sheets/sheets.js';

// Social Media tab, 2-slot shared posting:
//   Slot 1: X, LinkedIn, Instapaper, Raindrop
//   Slot 2: Facebook, Tumblr, Pearltrees
const COLUMNS = [
  'Social Platform 1', 'Social URL 1', 'Last Posted Social Platform 1', 'Social Status 1', 'Social Batch 1', 'Social Error 1',
  'Social Platform 2', 'Social URL 2', 'Last Posted Social Platform 2', 'Social Status 2', 'Social Batch 2', 'Social Error 2',
];

ensureSheetColumns('social', COLUMNS)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
