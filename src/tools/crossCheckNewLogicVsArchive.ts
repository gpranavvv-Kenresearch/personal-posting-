/**
 * crossCheckNewLogicVsArchive.ts — read-only. Checks whether New Logic rows
 * that look "ready but unposted" (Blog Content filled, Blog Platform 1
 * empty) actually already have their URL present in the "Previous blog
 * post" archive tab — which would mean they're stale duplicates, not a
 * real backlog.
 */
import 'dotenv/config';
import { google } from 'googleapis';

const SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: '.accounts/google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() as any });
}

(async () => {
  const sheets = await getSheetsClient();

  const newLogicRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `New Logic!A:AD`,
  });
  const nlRows: string[][] = newLogicRes.data.values ?? [];
  const nlHeaders = nlRows[0] ?? [];
  const idx = (name: string) => nlHeaders.findIndex(h => (h ?? '').trim().toLowerCase() === name.toLowerCase());
  const urlIdx = idx('Target URL') >= 0 ? idx('Target URL') : idx('URL');
  const contentIdx = idx('Blog Content');
  const slot1Idx = idx('Blog Platform 1');

  const readyUrls: string[] = [];
  for (let i = 1; i < nlRows.length; i++) {
    const row = nlRows[i];
    const hasContent = contentIdx >= 0 && (row[contentIdx] ?? '').trim();
    const slotFilled = slot1Idx >= 0 && (row[slot1Idx] ?? '').trim();
    if (hasContent && !slotFilled && urlIdx >= 0 && (row[urlIdx] ?? '').trim()) {
      readyUrls.push((row[urlIdx] ?? '').trim());
    }
  }
  console.log(`New Logic "ready but Slot 1 empty" rows: ${readyUrls.length}`);

  const archiveRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `Previous blog post!A:CU`,
  });
  const arRows: string[][] = archiveRes.data.values ?? [];
  const arHeaders = arRows[0] ?? [];
  console.log(`\n"Previous blog post" tab: ${arRows.length - 1} rows, ${arHeaders.length} cols`);
  console.log('Headers:', arHeaders.slice(0, 15).join(' | '), arHeaders.length > 15 ? '...' : '');

  // Build a set of every URL appearing ANYWHERE in the archive tab (any column),
  // since we don't yet know which column holds the URL there.
  const archiveUrlSet = new Set<string>();
  for (let i = 1; i < arRows.length; i++) {
    for (const cell of arRows[i]) {
      if (cell && cell.startsWith('http')) archiveUrlSet.add(cell.trim());
    }
  }
  console.log(`Distinct URL-looking values found anywhere in archive tab: ${archiveUrlSet.size}`);

  let matchCount = 0;
  const sampleMatches: string[] = [];
  const sampleMisses: string[] = [];
  for (const u of readyUrls) {
    if (archiveUrlSet.has(u)) {
      matchCount++;
      if (sampleMatches.length < 5) sampleMatches.push(u);
    } else {
      if (sampleMisses.length < 5) sampleMisses.push(u);
    }
  }

  console.log(`\nOf ${readyUrls.length} "ready but unposted" New Logic URLs, ${matchCount} also appear in "Previous blog post" archive.`);
  console.log(`\nSample MATCHES (already archived, likely stale):`);
  sampleMatches.forEach(u => console.log('  ' + u));
  console.log(`\nSample NOT found in archive (genuinely still pending):`);
  sampleMisses.forEach(u => console.log('  ' + u));
})().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
