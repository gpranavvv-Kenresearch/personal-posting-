/**
 * Test the Outlook newsletter send for one New Logic row, without touching
 * the sheet's Newsletter Status column (send-only dry run against real
 * subscribers — use with a subscriber list of just yourself first).
 *
 *   npx tsx src/tools/testNewsletterOutlook.ts <rowIndex>
 *
 * Example:
 *   npx tsx src/tools/testNewsletterOutlook.ts 2
 */
import 'dotenv/config';
import { getSheetRowByIndex } from '../sheets/sheets.js';
import { validateOutlookConfig } from '../config/settings.js';
import { adaptToNewsletterEmail } from '../newsletter-outlook/contentAdapter.js';
import { sendNewsletterEmail } from '../newsletter-outlook/sender.js';
import { getNewsletterSubscribers } from '../newsletter-outlook/subscribers.js';

const rowIndex = parseInt(process.argv[2] || '', 10);
if (!rowIndex) {
  console.error('Usage: npx tsx src/tools/testNewsletterOutlook.ts <rowIndex>');
  process.exit(1);
}

(async () => {
  try {
    validateOutlookConfig();
  } catch (err: any) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  console.log(`\nFetching New Logic row ${rowIndex}...`);
  const row = await getSheetRowByIndex(rowIndex, 'newLogic');
  if (!row) {
    console.error(`❌ Row ${rowIndex} not found in New Logic sheet`);
    process.exit(1);
  }

  console.log(`   Title   : ${row.title}`);
  console.log(`   URL     : ${row.targetUrl}`);
  console.log(`   Content : ${row.blogContent ? row.blogContent.slice(0, 80) + '...' : '(empty)'}`);

  if (!row.blogContent) {
    console.error('❌ No blog content in row — cannot build newsletter');
    process.exit(1);
  }

  const subscribers = getNewsletterSubscribers();
  console.log(`   Subscribers: ${subscribers.length} active`);
  if (subscribers.length === 0) {
    console.error('❌ No active subscribers — populate .accounts/newsletter-subscribers.json first');
    process.exit(1);
  }

  const email = adaptToNewsletterEmail({ title: row.title, blogContent: row.blogContent, targetUrl: row.targetUrl });
  const result = await sendNewsletterEmail(email, subscribers);
  console.log('\n✅ Result:', JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
})();
