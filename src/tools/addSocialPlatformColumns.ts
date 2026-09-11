import 'dotenv/config';
import { ensureSheetColumns } from '../sheets/sheets.js';

const COLUMNS = [
  // Instapaper
  'Instapaper Post URL', 'Instapaper Note', 'Instapaper Status', 'Instapaper Error', 'Instapaper Batch', 'Last Posted Instapaper',
  // Raindrop
  'Raindrop Post URL', 'Raindrop Note', 'Raindrop Status', 'Raindrop Error', 'Raindrop Batch', 'Last Posted Raindrop',
  // PdfHost
  'PdfHost Post URL', 'PdfHost Status', 'PdfHost Error', 'PdfHost Batch', 'Last Posted PdfHost',
  // Mastodon
  'Mastodon Post', 'Mastodon Post URL', 'Mastodon Status', 'Mastodon Error', 'Mastodon Batch', 'Last Posted Mastodon',
  // Pearltrees
  'Pearltrees Post URL', 'Pearltrees Status', 'Pearltrees Error', 'Pearltrees Batch', 'Last Posted Pearltrees',
];

ensureSheetColumns('social', COLUMNS)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  });
