/**
 * tabGuard.ts — confine a development run to a single spreadsheet tab.
 *
 * Why this exists
 * ---------------
 * The test tab (e.g. "Test_Abhinav") lives INSIDE the live production
 * spreadsheet. Spreadsheet-id isolation therefore cannot help: the id is the
 * production id. The only remaining boundary is the tab name, and tab names
 * appear in ~83 range strings across sheets.ts alone.
 *
 * Rather than edit every call site, this wraps the Google Sheets client at the
 * single point where requests leave the process. Every `range` is rewritten
 * onto the development tab, and anything that cannot be proven safe is
 * refused rather than guessed at.
 *
 * In production this is a pass-through. TAB_LOCK_ACTIVE is false, the original
 * client object is returned unchanged, and nothing about live behaviour
 * differs.
 */

import { DEV_SHEET_TAB, TAB_LOCK_ACTIVE, DEV_TAB_PREFIX, isDevTab } from './sheetIds.js';

/** Thrown when a development run attempts to touch anything but the dev tab. */
export class TabGuardViolation extends Error {
  constructor(message: string) {
    super(`[tabGuard] ${message}`);
    this.name = 'TabGuardViolation';
  }
}

/** Quote a tab name for A1 notation if it needs it. */
export function quoteTab(tab: string): string {
  return /^[A-Za-z0-9_]+$/.test(tab) ? tab : `'${tab.replace(/'/g, "''")}'`;
}

/**
 * Split "Tab!A1:Z" into its tab and cell parts.
 * A range with no "!" has no tab component (Sheets defaults to the first tab).
 */
export function splitRange(range: string): { tab: string | null; cells: string } {
  const idx = range.lastIndexOf('!');
  if (idx === -1) return { tab: null, cells: range };
  let tab = range.slice(0, idx);
  if (tab.startsWith("'") && tab.endsWith("'")) {
    tab = tab.slice(1, -1).replace(/''/g, "'");
  }
  return { tab, cells: range.slice(idx + 1) };
}

/**
 * Rewrite a range so it points at the development tab.
 *
 * A range without a tab is NOT silently accepted: without "!" Sheets targets
 * whichever tab happens to be first in the spreadsheet, which in production is
 * live data. It is given the dev tab explicitly.
 */
export function rewriteRange(
  range: string,
  devTab: string = DEV_SHEET_TAB,
  prefix: string = DEV_TAB_PREFIX,
): string {
  const { tab, cells } = splitRange(range);

  // A tab created for this work is already safe — leave it addressed as-is, so
  // a run can use several of its own tabs instead of being funnelled into one.
  // Anything else (every pre-existing live tab) is redirected.
  if (tab && isDevTab(tab, devTab, prefix)) return `${quoteTab(tab)}!${cells}`;

  return `${quoteTab(devTab)}!${cells}`;
}

function rewriteRangesIn(params: any, devTab: string): any {
  if (!params || typeof params !== 'object') return params;
  const next = { ...params };

  if (typeof next.range === 'string') next.range = rewriteRange(next.range, devTab);
  if (Array.isArray(next.ranges)) next.ranges = next.ranges.map((r: string) => rewriteRange(r, devTab));

  if (next.requestBody && typeof next.requestBody === 'object') {
    const body = { ...next.requestBody };
    if (typeof body.range === 'string') body.range = rewriteRange(body.range, devTab);
    if (Array.isArray(body.data)) {
      body.data = body.data.map((d: any) =>
        d && typeof d.range === 'string' ? { ...d, range: rewriteRange(d.range, devTab) } : d,
      );
    }
    next.requestBody = body;
  }
  return next;
}

/**
 * Wrap a googleapis sheets client so that, under an active tab lock, every
 * request is confined to the development tab.
 *
 * Covered: spreadsheets.values.{get,update,append,clear,batchGet,batchUpdate}
 *   — every path that reads or writes cell data, which is all posting writes.
 * Allowed through: spreadsheets.get — metadata only, read-only, harmless.
 * Refused: spreadsheets.batchUpdate — structural edits (insert/delete/rename
 *   a tab) address tabs by NUMERIC sheetId, which cannot be checked against a
 *   tab name. Guessing could delete a live tab, so it is blocked outright.
 */
/**
 * Decide whether a structural change may proceed under an active tab lock.
 *
 * Permitted: addSheet, but only for a tab belonging to this development run
 * (name matches DEV_TAB_PREFIX, or equals DEV_SHEET_TAB). Creating our own
 * scratch tabs is the point of being able to work here at all.
 *
 * Refused: everything else. deleteSheet, updateSheetProperties (rename),
 * duplicateSheet and friends address tabs by NUMERIC sheetId, which cannot be
 * checked against a tab name — permitting them could delete or rename a live
 * tab. There is no safe way to allow those without resolving ids first.
 */
export function assertStructuralChangeAllowed(
  params: any,
  opts: { active?: boolean; devTab?: string; prefix?: string } = {},
): void {
  const active = opts.active ?? TAB_LOCK_ACTIVE;
  const devTab = opts.devTab ?? DEV_SHEET_TAB;
  const prefix = opts.prefix ?? DEV_TAB_PREFIX;
  if (!active) return;

  const requests = params?.requestBody?.requests ?? params?.resource?.requests;
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new TabGuardViolation(
      'A structural spreadsheet change was attempted with no readable request ' +
      'list, so it cannot be checked. Refusing while the tab lock is active.'
    );
  }

  for (const req of requests) {
    const kind = Object.keys(req ?? {})[0];

    if (kind === 'addSheet') {
      const title = String(req.addSheet?.properties?.title ?? '').trim();
      if (!title) throw new TabGuardViolation('addSheet with no title — refusing.');
      if (!isDevTab(title, devTab, prefix)) {
        throw new TabGuardViolation(
          `Refusing to create the tab "${title}": it is not a development tab. ` +
          `Development tabs must start with "${prefix}" (or equal ` +
          `"${devTab}"), so this run can never create, shadow or collide ` +
          `with a live tab.`
        );
      }
      continue;
    }

    throw new TabGuardViolation(
      `Structural request "${kind}" is blocked while the tab lock is active. ` +
      `It addresses tabs by numeric sheetId, which cannot be verified against a ` +
      `tab name, so it could alter or delete a live tab. Only addSheet for a ` +
      `"${prefix}*" tab is permitted; do anything else by hand.`
    );
  }
}

export function guardSheetsClient<T extends Record<string, any>>(client: T): T {
  if (!TAB_LOCK_ACTIVE) return client;

  const devTab = DEV_SHEET_TAB;
  const values = client.spreadsheets?.values;
  if (!values) return client;

  const wrapValues = (name: string) => {
    const original = values[name];
    if (typeof original !== 'function') return;
    values[name] = function (params: any, ...rest: any[]) {
      return original.call(this, rewriteRangesIn(params, devTab), ...rest);
    };
  };

  for (const m of ['get', 'update', 'append', 'clear', 'batchGet', 'batchUpdate', 'batchClear']) {
    wrapValues(m);
  }

  const originalBatchUpdate = client.spreadsheets.batchUpdate;
  if (typeof originalBatchUpdate === 'function') {
    client.spreadsheets.batchUpdate = function (params: any, ...rest: any[]) {
      assertStructuralChangeAllowed(params);
      return originalBatchUpdate.call(this, params, ...rest);
    };
  }

  return client;
}

/** One-line description for the startup banner. */
export function describeTabLock(): string {
  return TAB_LOCK_ACTIVE
    ? `TAB LOCK ACTIVE — confined to "${DEV_SHEET_TAB}" and "${DEV_TAB_PREFIX}*" tabs`
    : 'tab lock inactive';
}
