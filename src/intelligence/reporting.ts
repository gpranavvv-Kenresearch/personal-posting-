/**
 * reporting.ts — read-only summaries shared by the CLI and the dashboard.
 *
 * Pulled out of cli.ts so a second renderer (dashboard.ts) can reuse the
 * exact same credential/table/proposal logic without importing cli.ts and
 * creating a cycle (cli.ts already imports dashboard.ts for the `dashboard`
 * command). Nothing here prints to a terminal or touches anything external
 * — it only reads the local database and env and returns data or text.
 */

import fs from 'fs';
import type { DB } from './db.js';
import { maskId } from '../config/sheetIds.js';
import { canApplyInterlinks } from './platforms.js';
import { normaliseUrl } from './indexation.js';

// ── Secret masking ────────────────────────────────────────────────────────────

/**
 * Never prints a usable secret. Still shows enough (length, last 4 chars) to
 * be useful to someone reading a log, but returns enough to answer "is the
 * thing I pasted the thing that is loaded?".
 */
export function maskSecret(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v) return '(not set)';
  if (v.length <= 8) return `*** (${v.length} chars)`;
  return `***${v.slice(-4)} (${v.length} chars)`;
}

/** An email is not a key, but a service-account address is still not for logs. */
export function maskEmail(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!v) return '(not set)';
  const at = v.indexOf('@');
  if (at <= 0) return maskSecret(v);
  const local = v.slice(0, at);
  const head = local.slice(0, 2);
  return `${head}***${v.slice(at)}`;
}

// ── Credential inventory ─────────────────────────────────────────────────────

export interface CredentialCheck {
  feature: string;
  ok: boolean;
  /** Env vars / files that are absent. Empty when ok. */
  missing: string[];
  detail: string;
}

export const SERVICE_ACCOUNT_FILE = '.accounts/google-service-account.json';

function serviceAccountPresent(env: NodeJS.ProcessEnv, exists: (f: string) => boolean): boolean {
  if ((env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '').trim()) return true;
  return exists(SERVICE_ACCOUNT_FILE);
}

/**
 * Which credentials exist, and therefore which features can possibly work.
 * Pure apart from the injected `exists` probe, so it is directly testable.
 */
export function checkCredentials(
  env: NodeJS.ProcessEnv = process.env,
  exists: (f: string) => boolean = (f) => fs.existsSync(f),
): CredentialCheck[] {
  const sa = serviceAccountPresent(env, exists);
  const saMissing = sa ? [] : [`GOOGLE_SERVICE_ACCOUNT_JSON or ${SERVICE_ACCOUNT_FILE}`];

  const gscSite = (env.GSC_SITE_URL ?? '').trim();
  const ga4Prop = (env.GA4_PROPERTY_ID ?? '').trim();
  const pdToken = (env.PIPEDRIVE_API_TOKEN ?? '').trim();

  const out: CredentialCheck[] = [];

  out.push({
    feature: 'Google Search Console',
    ok: sa && !!gscSite,
    missing: [...saMissing, ...(gscSite ? [] : ['GSC_SITE_URL'])],
    detail: sa && gscSite
      ? `service account present, site ${gscSite}`
      : 'cannot collect impressions, clicks or ranking position',
  });

  out.push({
    feature: 'Google Analytics 4',
    ok: sa && !!ga4Prop,
    missing: [...saMissing, ...(ga4Prop ? [] : ['GA4_PROPERTY_ID'])],
    detail: sa && ga4Prop
      ? `service account present, property ${maskId(ga4Prop)}`
      : 'cannot measure whether ANY platform sends real traffic',
  });

  out.push({
    feature: 'Pipedrive (leads)',
    ok: !!pdToken,
    missing: pdToken ? [] : ['PIPEDRIVE_API_TOKEN'],
    detail: pdToken
      ? `token ${maskSecret(pdToken)}`
      : 'cannot attribute leads to reports or platforms',
  });

  out.push({
    feature: 'Google Sheets (ingest)',
    ok: sa,
    missing: saMissing,
    detail: sa ? 'service account present' : 'cannot read the distribution sheet',
  });

  return out;
}

export function formatCredentials(checks: CredentialCheck[]): string {
  const lines: string[] = [];
  const w = Math.max(...checks.map(c => c.feature.length));
  for (const c of checks) {
    lines.push(`  ${c.ok ? 'OK     ' : 'MISSING'}  ${c.feature.padEnd(w)}  ${c.detail}`);
    if (!c.ok) lines.push(`${' '.repeat(11 + w + 2)}set: ${c.missing.join(', ')}`);
  }
  const broken = checks.filter(c => !c.ok);
  lines.push('');
  lines.push(broken.length
    ? `${broken.length} of ${checks.length} data sources cannot work yet: ${broken.map(b => b.feature).join(', ')}.`
    : 'All data sources have credentials.');
  return lines.join('\n');
}

// ── Database helpers ─────────────────────────────────────────────────────────

export function tableCounts(db: DB): Array<{ table: string; rows: number }> {
  const tables = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as any[]).map(r => String(r.name));

  return tables.map(t => {
    let rows = 0;
    try {
      rows = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any)?.n ?? 0);
    } catch { rows = -1; }
    return { table: t, rows };
  });
}

export function formatTableCounts(counts: Array<{ table: string; rows: number }>): string {
  if (!counts.length) return '  (no tables — run "migrate")';
  const w = Math.max(...counts.map(c => c.table.length));
  const total = counts.reduce((a, c) => a + Math.max(0, c.rows), 0);
  const lines = counts.map(c => `  ${c.table.padEnd(w)}  ${String(c.rows).padStart(7)}`);
  if (total === 0) {
    lines.push('');
    lines.push('  Every table is empty — no data yet. Run "ingest" then "collect".');
  }
  return lines.join('\n');
}

/** Report URLs we know about, best-known first. Empty on an empty database. */
export function knownReportUrls(db: DB, limit = 50): string[] {
  const rows = db.prepare(
    `SELECT report_url, MAX(posted_at) AS last_posted, COUNT(*) AS n
       FROM published_posts
      WHERE report_url IS NOT NULL AND report_url <> ''
      GROUP BY report_url
      ORDER BY last_posted DESC
      LIMIT ?`,
  ).all(limit) as any[];
  return rows.map(r => String(r.report_url));
}

export function recentPublishedPosts(db: DB, limit = 25): Array<{ url: string; platform: string | null }> {
  const rows = db.prepare(
    `SELECT published_url, platform FROM published_posts
      WHERE published_url IS NOT NULL AND published_url <> ''
      ORDER BY posted_at DESC LIMIT ?`,
  ).all(limit) as any[];
  return rows.map(r => ({ url: String(r.published_url), platform: r.platform ?? null }));
}

/**
 * Budgeted URL selection for indexation checks, built for the gap between a
 * large, slow-growing backlog (tens of thousands of URLs) and a small,
 * free-tier SERP call budget (tens to low hundreds per day). Checking every
 * URL on every run is not an option at that ratio, so two priorities compete
 * for the same fixed budget instead of one list getting checked in order:
 *
 *   - `newBudget` slots go to the most recently published posts first —
 *     "did this month's work land" matters more than re-confirming an old one.
 *   - `backlogBudget` slots go to whatever has gone LONGEST without a check
 *     (including "never checked" first) — so the 43k-URL backlog keeps
 *     rotating instead of the same unlucky tail never being reached.
 *
 * A post can appear in both halves if it is both recent and never checked;
 * checkIndexation()'s own recency skip (maxAgeDays) is the backstop that
 * keeps a budget slot from being wasted on a URL checked earlier today.
 */
export function selectUrlsForIndexCheck(
  db: DB,
  opts: { newBudget: number; backlogBudget: number; newWindowDays?: number },
): Array<{ url: string; platform: string | null }> {
  const newWindowDays = opts.newWindowDays ?? 14;
  const newBudget = Math.max(0, Math.trunc(opts.newBudget));
  const backlogBudget = Math.max(0, Math.trunc(opts.backlogBudget));

  const fresh = newBudget > 0 ? (db.prepare(
    `SELECT published_url, platform FROM published_posts
      WHERE published_url IS NOT NULL AND published_url <> ''
        AND posted_at >= datetime('now', ?)
      ORDER BY posted_at DESC LIMIT ?`,
  ).all(`-${newWindowDays} days`, newBudget) as any[]) : [];

  const seen = new Set(fresh.map(r => String(r.published_url)));

  let backlog: Array<{ published_url: string; platform: string | null }> = [];
  if (backlogBudget > 0) {
    // indexation_checks stores the NORMALISED url (see recordCheck in
    // indexation.ts); published_posts keeps the raw one. A plain SQL join on
    // the raw string would miss almost every match (scheme/www/trailing-slash
    // differences), silently making every backlog URL look "never checked"
    // and defeating the rotation. Build the "last checked" map in JS instead,
    // keyed by the same normaliseUrl() the recorder uses.
    const lastCheckedByNormalised = new Map<string, string>();
    for (const row of db.prepare(
      `SELECT url, MAX(checked_at) AS last_checked FROM indexation_checks GROUP BY url`,
    ).all() as Array<{ url: string; last_checked: string }>) {
      lastCheckedByNormalised.set(row.url, row.last_checked);
    }

    const candidates = db.prepare(
      `SELECT published_url, platform FROM published_posts
        WHERE published_url IS NOT NULL AND published_url <> ''`,
    ).all() as Array<{ published_url: string; platform: string | null }>;

    backlog = candidates
      .filter(r => !seen.has(r.published_url))
      .map(r => ({ ...r, lastChecked: lastCheckedByNormalised.get(normaliseUrl(r.published_url)) ?? '' }))
      .sort((a, b) => (a.lastChecked < b.lastChecked ? -1 : a.lastChecked > b.lastChecked ? 1 : 0))
      .slice(0, backlogBudget);
  }

  return [...fresh, ...backlog].map(r => ({ url: String(r.published_url), platform: r.platform ?? null }));
}

// ── Interlinking proposals ───────────────────────────────────────────────────

export interface ProposalRow {
  id: number;
  source_url: string;
  source_platform: string | null;
  destination_url: string;
  anchor_text: string;
  relevance: number | null;
  rationale: string | null;
  status: string;
  created_at: string;
  decided_by: string | null;
}

export function proposalsByStatus(db: DB, status: string, limit = 50): ProposalRow[] {
  return db.prepare(
    `SELECT id, source_url, source_platform, destination_url, anchor_text,
            relevance, rationale, status, created_at, decided_by
       FROM interlink_proposals WHERE status = ?
      ORDER BY relevance DESC, id ASC LIMIT ?`,
  ).all(status, limit) as any[];
}

export function formatProposals(rows: ProposalRow[], emptyNote: string): string {
  if (!rows.length) return emptyNote;
  const lines: string[] = [];
  for (const r of rows) {
    const rel = r.relevance === null || r.relevance === undefined ? '—' : r.relevance.toFixed(2);
    lines.push(`  #${r.id}  rel ${rel}  [${r.source_platform ?? 'unknown platform'}]`);
    lines.push(`      from  ${r.source_url}`);
    lines.push(`      to    ${r.destination_url}`);
    lines.push(`      anchor "${r.anchor_text}"`);
    if (r.rationale) lines.push(`      why   ${r.rationale}`);
    if (!canApplyInterlinks(r.source_platform ?? '')) {
      lines.push('      NOTE  this platform cannot be edited after publishing — approval here changes nothing.');
    }
  }
  lines.push('');
  lines.push(`${rows.length} proposal(s).`);
  return lines.join('\n');
}
