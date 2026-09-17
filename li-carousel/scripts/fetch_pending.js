import 'dotenv/config';
import { google } from 'googleapis';
import fs from 'node:fs';

const SA = JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
const auth = new google.auth.JWT({ email: SA.client_email, key: SA.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SOCIAL_SHEET_ID, range: "'Social Media'!A:Z" });
const rows = res.data.values ?? [];
const limit = parseInt(process.argv[2] ?? '45', 10);
const results = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const url = (row[0] ?? '').trim();
  const title = (row[1] ?? '').trim();
  const liPost = (row[24] ?? '').trim();
  if (url && !liPost) results.push({ row: i + 1, targetUrl: url, title });
  if (results.length >= limit) break;
}

console.log(JSON.stringify(results, null, 2));
