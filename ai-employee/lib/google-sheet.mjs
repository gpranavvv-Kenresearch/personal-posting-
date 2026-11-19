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

/**
 * Milestone 0 safety harness. The shipped observer.config.example.json used to
 * carry the live PRODUCTION spreadsheet id, so the documented setup path
 * (copy the example, run the observer) wrote straight into production. The
 * example now ships a placeholder, and this guard refuses to write when the
 * id is missing or still the placeholder, instead of failing obscurely later.
 */
const PLACEHOLDER_SPREADSHEET_ID = 'YOUR_DEVELOPMENT_SPREADSHEET_ID_HERE';

export function assertUsableSpreadsheetId(spreadsheetId) {
  if (!spreadsheetId || !String(spreadsheetId).trim()) {
    throw new Error(
      'spreadsheetId is required when Sheet reporting is enabled. ' +
      'Set it in ai-employee/observer.config.json, or set sheetReporting to false.'
    );
  }
  if (String(spreadsheetId).trim() === PLACEHOLDER_SPREADSHEET_ID) {
    throw new Error(
      `spreadsheetId is still the placeholder ${PLACEHOLDER_SPREADSHEET_ID}. ` +
      'Replace it in ai-employee/observer.config.json with the spreadsheet you ' +
      'actually want the AI Guardian to write to. Refusing to write.'
    );
  }
}

export async function appendGuardianEvents(events, config, projectRoot) {
  if (!config.sheetReporting || !events.length) return { appended: 0, skipped: true };
  assertUsableSpreadsheetId(config.spreadsheetId);
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
