/**
 * readOnlySheets.ts — the one sanctioned exception to the tab lock.
 *
 * WHY THIS EXISTS
 * ---------------
 * The tab lock (config/tabGuard.ts) redirects every read and write onto the
 * development tab. That is correct for a development run, but it makes one
 * legitimate job impossible: reading the LIVE tabs in order to measure them.
 * Ingesting what has already been published, and copying a live tab's headers
 * so a test tab can mirror them, both require reading real rows.
 *
 * WHY IT IS SAFE
 * --------------
 * This client is created with Google's `spreadsheets.readonly` OAuth scope.
 * That is not a convention or a flag — the token Google issues is physically
 * incapable of writing. A write attempt fails at Google's API boundary with
 * 403, regardless of any bug on our side.
 *
 * So the exception is a one-way hole: real data can come out, nothing can go
 * back in through it.
 *
 * ADDITIONAL BELT AND BRACES
 * --------------------------
 *  - Only the read methods are exposed. The returned object has no update,
 *    append, clear or batchUpdate, so a mistaken call is a TypeError here
 *    rather than a request to Google.
 *  - Every call is logged with the tab being read, so use is auditable.
 *  - The normal (guarded) client remains the ONLY way anything is written.
 */

import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

/** Read-only scope. Google will reject any write made with this token. */
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export interface ReadOnlySheets {
  /** Values of a range, e.g. "Social Media!A1:Z100". */
  getValues(spreadsheetId: string, range: string): Promise<string[][]>;
  /** Header row of a tab. */
  getHeaders(spreadsheetId: string, tab: string): Promise<string[]>;
  /** Tab names and sizes. */
  listTabs(spreadsheetId: string): Promise<Array<{ title: string; rows: number; cols: number }>>;
}

function resolveCredentials(): Record<string, unknown> {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim();
  if (raw) return JSON.parse(raw);
  const file = path.join(process.cwd(), '.accounts', 'google-service-account.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      '[readOnlySheets] No Google service account found. Set ' +
      'GOOGLE_SERVICE_ACCOUNT_JSON or place .accounts/google-service-account.json.'
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function quoteTab(tab: string): string {
  return /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
}

export interface ReadOnlyOptions {
  /** Called with each range read, for auditability. Defaults to console. */
  log?: (message: string) => void;
}

/**
 * Build the read-only client.
 *
 * Note there is deliberately NO guardSheetsClient() here: wrapping it would
 * rewrite ranges onto the dev tab, which is exactly what this client exists
 * to avoid. The safety comes from the scope, not from the wrapper.
 */
export async function createReadOnlySheets(opts: ReadOnlyOptions = {}): Promise<ReadOnlySheets> {
  const log = opts.log ?? ((m: string) => console.log(m));

  const auth = new google.auth.GoogleAuth({
    credentials: resolveCredentials(),
    scopes: [READONLY_SCOPE],
  });
  const api = google.sheets({ version: 'v4', auth });

  return {
    async getValues(spreadsheetId: string, range: string): Promise<string[][]> {
      log(`   [read-only] ${range}`);
      const res = await api.spreadsheets.values.get({ spreadsheetId, range });
      return (res.data.values ?? []) as string[][];
    },

    async getHeaders(spreadsheetId: string, tab: string): Promise<string[]> {
      log(`   [read-only] headers of "${tab}"`);
      const res = await api.spreadsheets.values.get({
        spreadsheetId,
        range: `${quoteTab(tab)}!1:1`,
      });
      return ((res.data.values ?? [[]])[0] ?? []).map(v => String(v ?? ''));
    },

    async listTabs(spreadsheetId: string) {
      log('   [read-only] listing tabs');
      const res = await api.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(title,gridProperties(rowCount,columnCount)))',
      });
      return (res.data.sheets ?? []).map(s => ({
        title: String(s.properties?.title ?? ''),
        rows: Number(s.properties?.gridProperties?.rowCount ?? 0),
        cols: Number(s.properties?.gridProperties?.columnCount ?? 0),
      }));
    },
  };
}

/**
 * True when a read-only client can be built at all (i.e. a credential exists).
 * Lets callers degrade with a clear message instead of throwing.
 */
export function readOnlyAvailable(): boolean {
  if ((process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim()) return true;
  return fs.existsSync(path.join(process.cwd(), '.accounts', 'google-service-account.json'));
}
