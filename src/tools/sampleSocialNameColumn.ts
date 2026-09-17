import 'dotenv/config';
import { google } from 'googleapis';
const SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: '.accounts/google-service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `Social Media!A1:W20` });
  const rows = res.data.values ?? [];
  console.log('Headers:', rows[0]);
  for (let i=1;i<rows.length;i++) console.log(`Row ${i+1}:`, rows[i]);
})();
