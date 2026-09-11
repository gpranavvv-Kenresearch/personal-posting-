import 'dotenv/config';
import { ensureLastPostedBlogPlatformColumns } from '../sheets/sheets.js';

ensureLastPostedBlogPlatformColumns()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
