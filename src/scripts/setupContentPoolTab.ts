/**
 * setupContentPoolTab.ts — One-time setup script
 *
 * Creates the "Content Pool" tab (if it doesn't already exist) on the shared
 * spreadsheet and writes the header row. Run once:
 *
 *   npx ts-node src/scripts/setupContentPoolTab.ts
 *
 * Safe to re-run: if the tab already exists, it only (re)writes the header
 * row — it never touches existing data rows.
 */

import 'dotenv/config';
import { google } from 'googleapis';

const SPREADSHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const SHEET_NAME = 'Content Pool';

const HEADERS = [
  'Title', 'Description', 'Blog Content',
  'Group Assigned', 'Claimed At', 'Name', 'New Name',
  // LinkedIn Pulse
  'LinkedIn Pulse Post URL', 'LinkedIn Pulse Status', 'LinkedIn Pulse Error', 'LinkedIn Pulse Batch', 'lastPostedLinkedinPulse',
  // Linkmate
  'Linkmate Content', 'Linkmate Post URL', 'Linkmate Status', 'Linkmate Error', 'Linkmate Batch', 'lastPostedLinkmate',
  // Calisthenics
  'Calisthenics Post URL', 'Calisthenics Status', 'Calisthenics Error', 'Calisthenics Batch', 'lastPostedCalisthenics',
  // Dev.to
  'Dev.to Post URL', 'Dev.to Status', 'Dev.to Error', 'Dev.to Batch', 'lastPostedDevto',
  // HackMD
  'HackMD Post URL', 'HackMD Status', 'HackMD Error', 'HackMD Batch', 'lastPostedHackmd',
  // WordPress
  'WordPress Post URL', 'WordPress Status', 'WordPress Error', 'WordPress Batch', 'lastPostedWordpress',
  // Blogger
  'Blogger Post URL', 'Blogger Status', 'Blogger Error', 'Blogger Batch', 'lastPostedBlogger',
  // Notion
  'Notion Post URL', 'Notion Status', 'Notion Error', 'Notion Batch', 'lastPostedNotion',
  // Naver
  'Naver Post URL', 'Naver Status', 'Naver Error', 'Naver Batch', 'lastPostedNaver',
  // Coda
  'Coda Post URL', 'Coda Status', 'Coda Error', 'Coda Batch', 'lastPostedCoda',
  // Medium
  'Medium Post URL', 'Medium Status', 'Medium Error', 'Medium Batch', 'lastPostedMedium',
  // Google Site
  'Google Site Post URL', 'Google Site Status', 'Google Site Error', 'Google Site Batch', 'lastPostedGoogleSite',
];

async function main() {
  let credentials: object;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    const fs = (await import('fs')).default;
    const raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
    credentials = JSON.parse(raw);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = meta.data.sheets?.find(s => s.properties?.title === SHEET_NAME);

  if (!existing) {
    console.log(`Creating "${SHEET_NAME}" tab...`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
      },
    });
    console.log('Tab created.');
  } else {
    console.log(`"${SHEET_NAME}" tab already exists — only updating the header row.`);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });

  console.log(`✅ Header row written (${HEADERS.length} columns).`);
  console.log(`\nNow add rows below the header with at least: Title, Description, Blog Content.`);
  console.log(`Leave "Group Assigned", "Claimed At", "Name", "New Name", and all per-platform columns blank — automation fills those in.`);
}

main().catch(err => {
  console.error('❌ Setup failed:', err.message);
  process.exit(1);
});
