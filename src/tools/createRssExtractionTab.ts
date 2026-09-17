import 'dotenv/config';
import { createRssExtractionTabIfMissing } from '../sheets/sheets.js';

createRssExtractionTabIfMissing()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
