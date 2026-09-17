import 'dotenv/config';
import { google } from 'googleapis';

const sheetId = process.argv[2];
if (!sheetId) {
  console.error('Usage: npx tsx src/tools/listSheetTabs.ts <spreadsheetId>');
  process.exit(1);
}

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: '.accounts/google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any });
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'properties(title),sheets(properties(title,sheetId,gridProperties))',
  });
  console.log(`Spreadsheet: ${meta.data.properties?.title}`);
  for (const s of meta.data.sheets ?? []) {
    console.log(`  - "${s.properties?.title}" (gid=${s.properties?.sheetId}) — ${s.properties?.gridProperties?.rowCount} rows x ${s.properties?.gridProperties?.columnCount} cols`);
  }
})().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
