/**
 * sourceImport.ts — GA4 "Session source" export (one row per source, no page).
 *
 * Page-level exports say how much traffic a report page got; this one says
 * how much each *platform* sent. It is what fills "Sessions per post" in the
 * platform report. Rows are stored exactly where the live GA4 collector would
 * put them (metric_scope='utm_source', url='(property)') so platformIntelligence
 * reads them without caring where they came from.
 *
 * GA4 source names are messy (Blogger / blogger, medium.com, linkedin/,
 * "SEOutm_medium=..."). canonicalSource() folds the known variants onto the
 * platform's utmSource; anything unrecognised is kept under its cleaned name
 * so nothing is silently dropped, it just won't match a platform.
 */
import { PLATFORMS } from '../platforms.js';
import { PROPERTY_SCOPE_URL } from './ga4.js';
import { parseCsv } from './manualImport.js';
import { tx, nowIso, type DB } from '../db.js';

const ALIASES: Record<string, string> = {
  twitter: 'x',
  't.co': 'x',
  linkedinpulse: 'linkedin-pulse',
  'linkedin pulse': 'linkedin-pulse',
  googlesite: 'googlesites',
  'dev.to': 'devto',
};

const HOSTS: Array<[string, string]> = PLATFORMS
  .filter(p => p.domain)
  // linkedin.com is shared by LinkedIn and LinkedIn Pulse; a bare linkedin.com
  // referral can't be told apart, so it counts as plain LinkedIn. Pulse traffic
  // is only claimed when the source is explicitly tagged linkedin-pulse.
  .filter(p => p.utmSource !== 'linkedin-pulse')
  .map(p => [String(p.domain).toLowerCase(), p.utmSource]);

export function canonicalSource(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  if (!s) return '(not set)';
  const cut = s.indexOf('utm_');
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[/ ]+$/, '').replace(/^(www|m|l|lm)\./, '');
  if (ALIASES[s]) return ALIASES[s]!;
  for (const [host, utm] of HOSTS) {
    if (s === host || s.endsWith('.' + host)) return utm;
  }
  const bare = s.replace(/\.com$/, '');
  if (ALIASES[bare]) return ALIASES[bare]!;
  if (PLATFORMS.some(p => p.utmSource === bare)) return bare;
  return s;
}

export interface SourceImportResult {
  rowsParsed: number;
  rowsWritten: number;
  matchedPlatforms: Record<string, number>;
  unmatchedSessions: number;
}

/** True when the header row has a Session source column but no page column. */
export function looksLikeSourceExport(csvText: string): boolean {
  const header = firstHeader(csvText).map(h => h.trim().toLowerCase());
  return header.includes('session source') && !header.some(h => h.startsWith('page'));
}

function firstHeader(csvText: string): string[] {
  const lines = csvText.replace(/^﻿/, '').split(/\r?\n/);
  const i = lines.findIndex(l => l.trim() !== '' && !l.startsWith('#'));
  return i < 0 ? [] : (parseCsv(lines[i]!)[0] ?? []);
}

export function importSourceExport(db: DB, csvText: string, metricDate: string): SourceImportResult {
  const lines = csvText.replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() !== '' && !l.startsWith('#'));
  const table = start < 0 ? [] : parseCsv(lines.slice(start).join('\n'));
  const headers = (table[0] ?? []).map(h => h.trim().toLowerCase());
  const srcCol = headers.indexOf('session source');
  const sessCol = headers.indexOf('sessions');
  const engCol = headers.indexOf('engaged sessions');
  if (srcCol < 0 || sessCol < 0) throw new Error('Source export needs "Session source" and "Sessions" columns.');

  const num = (v: string | undefined) => Number(String(v ?? '').replace(/,/g, '')) || 0;
  const totals = new Map<string, { sessions: number; engaged: number }>();
  let parsed = 0;
  for (const cells of table.slice(1)) {
    const raw = cells[srcCol];
    if (raw === undefined || raw.trim() === '') continue; // the "Grand total" row has no source
    parsed++;
    const key = canonicalSource(raw);
    const t = totals.get(key) ?? { sessions: 0, engaged: 0 };
    t.sessions += num(cells[sessCol]);
    t.engaged += engCol >= 0 ? num(cells[engCol]) : 0;
    totals.set(key, t);
  }

  const known = new Set(PLATFORMS.map(p => p.utmSource));
  const matched: Record<string, number> = {};
  let unmatched = 0;
  const now = nowIso();
  const stmt = db.prepare(
    `INSERT INTO url_performance
       (url, source, metric_date, metric_scope, dimension_value, sessions, engaged_sessions, collected_at)
     VALUES (?, 'ga4-manual', ?, 'utm_source', ?, ?, ?, ?)
     ON CONFLICT(url, source, metric_date, metric_scope, dimension_value) DO UPDATE SET
       sessions = excluded.sessions, engaged_sessions = excluded.engaged_sessions,
       collected_at = excluded.collected_at`,
  );
  let written = 0;
  tx(db, () => {
    for (const [key, t] of totals) {
      stmt.run(PROPERTY_SCOPE_URL, metricDate, key, t.sessions, t.engaged, now);
      written++;
      if (known.has(key)) matched[key] = t.sessions; else unmatched += t.sessions;
    }
  });
  return { rowsParsed: parsed, rowsWritten: written, matchedPlatforms: matched, unmatchedSessions: unmatched };
}
