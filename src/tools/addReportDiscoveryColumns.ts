import 'dotenv/config';
import { ensureSheetColumns } from '../sheets/sheets.js';

// Run once before using the report watcher (src/reportDiscovery/watcher.ts) —
// appendDiscoveredReportRows() looks these up by name and skips them
// silently if absent, so this just enables the extra fields.
ensureSheetColumns('social', ['Type', 'Region'])
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
