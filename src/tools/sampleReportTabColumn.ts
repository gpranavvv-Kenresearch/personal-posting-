import 'dotenv/config';
import { google } from 'googleapis';
const SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: '.accounts/google-service-account.json', scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `New Logic!Y1:Y4809` });
  const vals = (res.data.values ?? []).map(r => r[0] ?? '').filter(v => v.trim());
  console.log('Non-empty "Report Tab" values:', vals.length, 'out of', (res.data.values?.length ?? 1) - 1);
  const counts: Record<string, number> = {};
  vals.forEach(v => counts[v] = (counts[v]||0)+1);
  console.log(counts);
})();
