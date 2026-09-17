/**
 * checkNewLogicBacklog.ts — read-only report on how many New Logic rows are
 * already "content filled, slot empty" (i.e. ready but unposted) per slot,
 * so we know whether fresh rows appended at the bottom would get starved by
 * an existing backlog. Diagnostic only — writes nothing.
 */
import 'dotenv/config';
import { google } from 'googleapis';

const SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const SHEET_NAME = 'New Logic';

async function getSheetsClient() {
  const keyFile = '.accounts/google-service-account.json';
  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() as any });
}

(async () => {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AD`,
  });
  const rows: string[][] = res.data.values ?? [];
  const headers = rows[0] ?? [];

  const idx = (name: string) => headers.findIndex(h => (h ?? '').trim().toLowerCase() === name.toLowerCase());
  const contentIdx = idx('Blog Content');
  const slot1Idx = idx('Blog Platform 1');
  const slot2Idx = idx('Blog Platform 2');
  const slot3Idx = idx('Blog Platform 3');
  const urlIdx = idx('Target URL') >= 0 ? idx('Target URL') : idx('URL');

  console.log(`Headers found: Blog Content=${contentIdx}, Blog Platform 1=${slot1Idx}, Blog Platform 2=${slot2Idx}, Blog Platform 3=${slot3Idx}, URL=${urlIdx}`);
  console.log(`Total data rows: ${rows.length - 1}`);

  let totalWithUrl = 0, totalWithContent = 0, totalNoContent = 0;
  let readySlot1 = 0, readySlot2 = 0, readySlot3 = 0;
  let firstReadySlot1Row = -1;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const hasUrl = urlIdx >= 0 && (row[urlIdx] ?? '').trim();
    const hasContent = contentIdx >= 0 && (row[contentIdx] ?? '').trim();
    if (hasUrl) totalWithUrl++;
    if (hasContent) totalWithContent++; else if (hasUrl) totalNoContent++;

    if (hasContent) {
      if (slot1Idx >= 0 && !(row[slot1Idx] ?? '').trim()) {
        readySlot1++;
        if (firstReadySlot1Row === -1) firstReadySlot1Row = i + 1;
      }
      if (slot2Idx >= 0 && !(row[slot2Idx] ?? '').trim()) readySlot2++;
      if (slot3Idx >= 0 && !(row[slot3Idx] ?? '').trim()) readySlot3++;
    }
  }

  console.log(`\nRows with a URL: ${totalWithUrl}`);
  console.log(`Rows with Blog Content filled: ${totalWithContent}`);
  console.log(`Rows with URL but NO Blog Content yet (pending generation): ${totalNoContent}`);
  console.log(`\nBacklog ready-but-unposted (content filled, slot empty):`);
  console.log(`  Slot 1: ${readySlot1} row(s)${firstReadySlot1Row > 0 ? ` (first one at sheet row ${firstReadySlot1Row})` : ''}`);
  console.log(`  Slot 2: ${readySlot2} row(s)`);
  console.log(`  Slot 3: ${readySlot3} row(s)`);
})().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
