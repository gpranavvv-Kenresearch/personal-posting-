import fs from 'node:fs/promises';
import path from 'node:path';

const HEADERS = [
  'Observed At', 'Source', 'Severity', 'Type', 'Title', 'Summary',
  'Evidence', 'Fingerprint', 'Status', 'Owner Action',
];

async function credentials(projectRoot) {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return JSON.parse(await fs.readFile(path.join(projectRoot, '.accounts', 'google-service-account.json'), 'utf8'));
}

export async function appendGuardianEvents(events, config, projectRoot) {
  if (!config.sheetReporting || !events.length) return { appended: 0, skipped: true };
  if (!config.spreadsheetId) throw new Error('spreadsheetId is required when Sheet reporting is enabled');
  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: await credentials(projectRoot),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const tab = config.sheetTab || 'AI Guardian';
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: config.spreadsheetId,
    fields: 'sheets(properties(title))',
  });
  const exists = meta.data.sheets?.some(sheet => sheet.properties?.title === tab);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `'${tab.replaceAll("'", "''")}'!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
  const values = events.map(event => [
    event.observedAt, event.source, event.severity, event.type, event.title, event.summary,
    JSON.stringify(event.evidence || {}), event.fingerprint || '', 'Open', '',
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `'${tab.replaceAll("'", "''")}'!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return { appended: values.length, tab };
}
