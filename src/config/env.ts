/**
 * env.ts — environment identification and the startup banner.
 *
 * MILESTONE 0 (safety harness).
 *
 * State isolation is achieved WITHOUT editing the ~200 existing path
 * references. The codebase resolves runtime state through three idioms, all
 * of which are relative to the current working directory:
 *
 *   path.resolve('.sessions/...')
 *   path.resolve('logs/...')
 *   path.join(process.cwd(), '.accounts')
 *
 * Launching the process with its cwd set to a development sandbox therefore
 * redirects every one of them at once, with no source change. This module
 * reports which paths are actually in use so that isolation is visible rather
 * than assumed.
 */

import path from 'path';
import {
  KEN_ENV,
  IS_DEVELOPMENT,
  MAIN_SHEET_ID,
  DISTRIBUTED_URL_SHEET_ID,
  DEV_SHEET_TAB,
  TAB_LOCK_ACTIVE,
  maskId,
} from './sheetIds.js';

export { KEN_ENV, IS_DEVELOPMENT };

export interface StatePaths {
  cwd: string;
  sessions: string;
  logs: string;
  accounts: string;
  /** Reserved for Milestone 3. No database is created in Milestone 0. */
  data: string;
}

/**
 * The runtime state paths as the running process will actually resolve them.
 * Mirrors the three idioms above exactly.
 */
export function getStatePaths(cwd: string = process.cwd()): StatePaths {
  return {
    cwd,
    sessions: path.resolve(cwd, '.sessions'),
    logs: path.resolve(cwd, 'logs'),
    accounts: path.join(cwd, '.accounts'),
    data: path.resolve(cwd, 'data'),
  };
}

/**
 * True when the resolved state paths sit underneath `root`, i.e. this process
 * cannot reach the repository's own production state.
 */
export function isIsolatedUnder(root: string, cwd: string = process.cwd()): boolean {
  const resolvedRoot = path.resolve(root);
  const p = getStatePaths(cwd);
  return [p.sessions, p.logs, p.accounts, p.data].every(target => {
    const rel = path.relative(resolvedRoot, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export function buildStartupBanner(cwd: string = process.cwd()): string {
  const p = getStatePaths(cwd);
  const lines: string[] = [];
  lines.push('─'.repeat(72));
  if (IS_DEVELOPMENT) {
    lines.push('  KEN_ENV=development — DEVELOPMENT RUN (isolated)');
    if (TAB_LOCK_ACTIVE) {
      lines.push(`  TAB LOCK ACTIVE — every read/write confined to "${DEV_SHEET_TAB}"`);
      lines.push('  Structural spreadsheet changes are blocked.');
    }
  } else {
    lines.push('  KEN_ENV=production — ⚠️  RUNNING AGAINST LIVE PRODUCTION DATA');
    lines.push('  Writes go to the production spreadsheets and real accounts.');
    lines.push('  For an isolated run: KEN_ENV=development + dev spreadsheet ids.');
  }
  lines.push('─'.repeat(72));
  lines.push(`  main sheet       : ${maskId(MAIN_SHEET_ID)}`);
  lines.push(`  distributed url  : ${maskId(DISTRIBUTED_URL_SHEET_ID)}`);
  lines.push(`  cwd              : ${p.cwd}`);
  lines.push(`  .sessions        : ${p.sessions}`);
  lines.push(`  logs             : ${p.logs}`);
  lines.push(`  .accounts        : ${p.accounts}`);
  lines.push('─'.repeat(72));
  return lines.join('\n');
}

export function printStartupBanner(cwd: string = process.cwd()): void {
  console.log(buildStartupBanner(cwd));
}
