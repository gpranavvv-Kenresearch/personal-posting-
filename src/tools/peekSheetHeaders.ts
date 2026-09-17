import 'dotenv/config';
import { google } from 'googleapis';

const sheetId = process.argv[2];
const tabName = process.argv[3];
if (!sheetId || !tabName) {
  console.error('Usage: npx tsx src/tools/peekSheetHeaders.ts <spreadsheetId> <tabName>');
  process.exit(1);
}

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: '.accounts/google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tabName}!A1:AC5`,
  });
  const rows = res.data.values ?? [];
  const headers = rows[0] ?? [];
  console.log(`Headers (${headers.length}):`);
  headers.forEach((h, i) => console.log(`  [${i}] ${h}`));
  console.log(`\nFirst 3 data rows:`);
  for (let i = 1; i < Math.min(4, rows.length); i++) {
    console.log(`Row ${i + 1}:`, rows[i]);
  }
})().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
