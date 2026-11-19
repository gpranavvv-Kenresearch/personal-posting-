/**
 * v02Indexation.ts — borrow Google URL Inspection verdicts the V0.2 project
 * already paid for, instead of spending the shared ~1,900/day inspection quota
 * a second time.
 *
 * V0.2 keeps one row per kenresearch.com URL in its own state.db. This opens
 * that file READ-ONLY (it cannot modify or lock it), matches each tracked
 * report to a V0.2 row, and records the verdict in indexation_checks, which
 * is where scoring already looks for the "indexation" signal.
 *
 * Mapping (Google's own words, so nothing is guessed):
 *   html_state INDEXED  + html_indexed date present -> indexed
 *   html_state STALLED (crawled/discovered/unknown/noindex) -> not_indexed
 *   anything else (never inspected, AWAITING CONTENT, INDEXED without a date) -> skipped
 */
import { DatabaseSync } from 'node:sqlite';
import type { DB } from '../db.js';
import { recordCheck } from './../indexation.js';

export interface V02ImportResult {
  trackedReports: number;
  matched: number;
  recorded: { indexed: number; not_indexed: number };
  skipped: number;
}

const norm = (u: unknown) => String(u ?? '').toLowerCase().replace(/\/+$/, '');
const slugOf = (u: string) => norm(u).split('/').pop() ?? '';

export function importV02Indexation(db: DB, v02DbPath: string): V02ImportResult {
  const v02 = new DatabaseSync(v02DbPath, { readOnly: true });
  try {
    const rows = v02.prepare(
      `SELECT url, canonical_url, html_state, html_indexed, html_last_check, verified_on, html_cov FROM urls`,
    ).all() as any[];

    const byUrl = new Map<string, any>();
    const bySlug = new Map<string, any>();
    for (const r of rows) {
      byUrl.set(norm(r.url), r);
      if (r.canonical_url) byUrl.set(norm(r.canonical_url), r);
      bySlug.set(slugOf(String(r.url)), r);
    }

    const reports = (db.prepare(`SELECT DISTINCT report_url AS u FROM published_posts`).all() as any[]).map(r => String(r.u));
    const result: V02ImportResult = { trackedReports: reports.length, matched: 0, recorded: { indexed: 0, not_indexed: 0 }, skipped: 0 };

    for (const report of reports) {
      const row = byUrl.get(norm(report)) ?? bySlug.get(slugOf(report));
      if (!row) { result.skipped++; continue; }
      result.matched++;
      const when = String(row.html_last_check ?? row.verified_on ?? '').slice(0, 10);
      const checkedAt = /^\d{4}-\d{2}-\d{2}$/.test(when) ? `${when}T00:00:00.000Z` : undefined;
      const cov = row.html_cov ? ` (${row.html_cov})` : '';
      if (row.html_state === 'INDEXED' && row.html_indexed) {
        recordCheck(db, report, 'kenresearch', 'v0.2-url-inspection',
          { status: 'indexed', confidence: 0.95, evidence: `Google URL Inspection via V0.2: indexed${cov}`, rawHitCount: null }, checkedAt);
        result.recorded.indexed++;
      } else if (row.html_state === 'STALLED') {
        recordCheck(db, report, 'kenresearch', 'v0.2-url-inspection',
          { status: 'not_indexed', confidence: 0.9, evidence: `Google URL Inspection via V0.2: not indexed${cov}`, rawHitCount: null }, checkedAt);
        result.recorded.not_indexed++;
      } else {
        result.skipped++;
      }
    }
    return result;
  } finally {
    v02.close();
  }
}
