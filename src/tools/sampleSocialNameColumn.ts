import 'dotenv/config';
import { google } from 'googleapis';
import { MAIN_SHEET_ID } from '../config/sheetIds.js';
import { guardSheetsClient } from '../config/tabGuard.js';
const SHEET_ID = MAIN_SHEET_ID;
(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: '.accounts/google-service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = guardSheetsClient(google.sheets({ version: 'v4', auth: await auth.getClient() as any }));
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Social Media!A1:W20` });
  const rows = res.data.values ?? [];
  console.log('Headers:', rows[0]);
  for (let i=1;i<rows.length;i++) console.log(`Row ${i+1}:`, rows[i]);
})();
