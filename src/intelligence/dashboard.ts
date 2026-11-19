/**
 * dashboard.ts — one static HTML page for a non-technical reader.
 *
 * Reuses the exact same library functions the CLI text commands call
 * (scoring.ts, platformIntelligence.ts, contentIntelligence.ts,
 * reporting.ts) — this never computes anything differently from
 * `npm run intel report`, it only renders the same facts as a page instead
 * of terminal text.
 *
 * Deliberately observe-only: there is no button here that approves or
 * applies anything. Approving an interlink proposal stays a conscious CLI
 * action (`intel approve <id>`) — that boundary is the whole point of the
 * approval gate, and a dashboard is not the place to erode it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { currentVersion, nowIso, type DB } from './db.js';
import { FLAGS, enabled } from './flags.js';
import { WEIGHTS_VERSION } from './weights.js';
import { scoreReports, type ScoreResult } from './scoring.js';
import { analysePlatforms, matchPlatformsForReport, computePlatformStats, type PlatformVerdict } from './platformIntelligence.js';
import { analyseContent, type FeatureCorrelation } from './contentIntelligence.js';
import { checkCredentials, tableCounts, knownReportUrls, proposalsByStatus, type CredentialCheck } from './reporting.js';
import { scanAndImportInbox, type InboxResult } from './collectors/inbox.js';
import { describeSheetConfig, KEN_ENV } from '../config/sheetIds.js';

export interface DashboardOptions {
  db: DB;
  windowDays?: number;
  reportLimit?: number;
  inboxDir?: string;
  importedDir?: string;
  domain?: string;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to now. */
  generatedAt?: string;
}

export interface DashboardData {
  generatedAt: string;
  environment: string;
  sheets: string;
  shadowMode: boolean;
  intelligenceOn: boolean;
  schemaVersion: number;
  weightsVersion: string;
  credentials: CredentialCheck[];
  inbox: InboxResult;
  platforms: PlatformVerdict[];
  scores: ScoreResult[];
  bestNextMove: { reportUrl: string; score: ScoreResult; platform: string | null } | null;
  content: FeatureCorrelation[];
  pendingApprovals: number;
  trackedReports: number;
  totalRowsStored: number;
}

export function buildDashboardData(opts: DashboardOptions): DashboardData {
  const env = opts.env ?? process.env;
  const windowDays = opts.windowDays ?? 90;
  const inboxDir = opts.inboxDir ?? path.resolve('data', 'manual-imports', 'inbox');

  const inbox = scanAndImportInbox({
    db: opts.db,
    inboxDir,
    ...(opts.importedDir ? { importedDir: opts.importedDir } : {}),
    ...(opts.domain ? { domain: opts.domain } : {}),
  });

  const platforms = enabled('PLATFORM_INTELLIGENCE')
    ? analysePlatforms({ db: opts.db, windowDays })
    : [];

  const urls = knownReportUrls(opts.db, opts.reportLimit ?? 25);
  const scores = enabled('OPPORTUNITY_SCORING') && urls.length
    ? scoreReports(opts.db, urls, { windowDays })
    : [];

  let bestNextMove: DashboardData['bestNextMove'] = null;
  if (scores.length) {
    const top = scores[0]!;
    let platform: string | null = null;
    if (enabled('PLATFORM_INTELLIGENCE')) {
      const stats = computePlatformStats({ db: opts.db, windowDays });
      const match = matchPlatformsForReport(opts.db, top.reportUrl, stats);
      platform = match.bestUntried?.platform ?? null;
    }
    bestNextMove = { reportUrl: top.reportUrl, score: top, platform };
  }

  const content = analyseContent(opts.db, 10);
  const pendingApprovals = proposalsByStatus(opts.db, 'proposed', 500).length;
  const totalRowsStored = tableCounts(opts.db).reduce((a, c) => a + Math.max(0, c.rows), 0);

  return {
    generatedAt: opts.generatedAt ?? nowIso(),
    environment: KEN_ENV,
    sheets: describeSheetConfig(),
    shadowMode: FLAGS.SHADOW_MODE,
    intelligenceOn: FLAGS.INTELLIGENCE_ENABLED,
    schemaVersion: currentVersion(opts.db),
    weightsVersion: WEIGHTS_VERSION,
    credentials: checkCredentials(env),
    inbox,
    platforms,
    scores,
    bestNextMove,
    content,
    pendingApprovals,
    trackedReports: urls.length,
    totalRowsStored,
  };
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

function num(n: number | null, digits = 1): string {
  return n === null ? '—' : n.toFixed(digits);
}

const RECOMMENDATION_LABEL: Record<PlatformVerdict['recommendation'], string> = {
  keep: 'KEEP',
  investigate: 'INVESTIGATE',
  'consider-dropping': 'CONSIDER DROPPING',
  'insufficient-data': 'NOT ENOUGH DATA',
};

const RECOMMENDATION_CLASS: Record<PlatformVerdict['recommendation'], string> = {
  keep: 'badge-good',
  investigate: 'badge-warning',
  'consider-dropping': 'badge-serious',
  'insufficient-data': 'badge-muted',
};

function barWidth(value: number | null, max: number): string {
  if (value === null || max <= 0) return '0%';
  return `${Math.max(2, Math.round((value / max) * 100))}%`;
}

function platformRows(verdicts: PlatformVerdict[]): string {
  if (!verdicts.length) {
    return `<tr><td colspan="5" class="empty">FEATURE_PLATFORM_INTELLIGENCE is off, or there is no data yet.</td></tr>`;
  }
  const maxSessions = Math.max(1, ...verdicts.map(v => v.stats.sessionsPerPost ?? 0));
  return verdicts.map(v => `
    <tr>
      <td class="name">${esc(v.platform)}</td>
      <td><span class="badge ${RECOMMENDATION_CLASS[v.recommendation]}">${RECOMMENDATION_LABEL[v.recommendation]}</span></td>
      <td>${v.stats.posts}</td>
      <td>
        <div class="bar-row"><span class="bar-label">${pct(v.stats.indexationRate)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${barWidth(v.stats.indexationRate === null ? null : v.stats.indexationRate * 100, 100)}"></div></div>
        </div>
      </td>
      <td>
        <div class="bar-row"><span class="bar-label">${num(v.stats.sessionsPerPost, 2)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${barWidth(v.stats.sessionsPerPost, maxSessions)}"></div></div>
        </div>
      </td>
      <td class="num">${v.stats.leads}</td>
    </tr>`).join('');
}

function scoreRows(scores: ScoreResult[]): string {
  if (!scores.length) {
    return `<tr><td colspan="4" class="empty">FEATURE_OPPORTUNITY_SCORING is off, or no reports are known yet — run "ingest" first.</td></tr>`;
  }
  return scores.slice(0, 15).map(s => `
    <tr>
      <td class="urlcell"><a href="${esc(s.reportUrl)}" target="_blank" rel="noopener">${esc(shortenUrl(s.reportUrl))}</a></td>
      <td class="num">${s.score.toFixed(3)}</td>
      <td class="num">${pct(s.coverage)}</td>
      <td class="explain">${esc(s.explanation)}</td>
    </tr>`).join('');
}

function contentRows(rows: FeatureCorrelation[]): string {
  const usable = rows.filter(r => r.r !== null);
  if (!usable.length) {
    return `<tr><td colspan="4" class="empty">FEATURE_CONTENT_INTELLIGENCE is off, or not enough posts yet to say anything (needs a minimum sample size per feature).</td></tr>`;
  }
  return usable.map(r => `
    <tr>
      <td class="name">${esc(r.feature)}</td>
      <td>${esc(r.outcome)}</td>
      <td class="num">${r.r!.toFixed(2)}</td>
      <td class="num">${r.n}</td>
      <td class="explain">${esc(r.interpretation)}</td>
    </tr>`).join('');
}

function shortenUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

function credentialRows(checks: CredentialCheck[]): string {
  return checks.map(c => `
    <tr>
      <td class="name">${esc(c.feature)}</td>
      <td><span class="badge ${c.ok ? 'badge-good' : 'badge-muted'}">${c.ok ? 'CONNECTED' : 'NOT CONNECTED'}</span></td>
      <td class="explain">${esc(c.detail)}</td>
    </tr>`).join('');
}

function inboxSummary(inbox: InboxResult): string {
  if (!inbox.files.length) {
    return `<p class="muted">No new files in the drop folder this run.</p>`;
  }
  const items = inbox.files.map(f => {
    if (f.outcome === 'imported') {
      return `<li><span class="badge badge-good">IMPORTED</span> ${esc(f.file)} — ${f.rowsWritten} row(s) written</li>`;
    }
    return `<li><span class="badge badge-warning">SKIPPED</span> ${esc(f.file)} — ${esc(f.reason ?? '')}</li>`;
  }).join('');
  return `<ul class="inbox-list">${items}</ul>`;
}

export function renderDashboardHtml(data: DashboardData): string {
  const statTiles = [
    { label: 'Reports tracked', value: String(data.trackedReports) },
    { label: 'Platforms measured', value: String(data.platforms.length) },
    { label: 'Leads attributed (window)', value: String(data.platforms.reduce((a, p) => a + p.stats.leads, 0)) },
    { label: 'Interlink suggestions awaiting your approval', value: String(data.pendingApprovals) },
  ];

  const bestMove = data.bestNextMove
    ? `<div class="callout">
         <div class="callout-title">Best next move</div>
         <p><a href="${esc(data.bestNextMove.reportUrl)}" target="_blank" rel="noopener">${esc(shortenUrl(data.bestNextMove.reportUrl))}</a>
            is the highest-scoring report right now (score ${data.bestNextMove.score.score.toFixed(3)}, ${pct(data.bestNextMove.score.coverage)} of the score backed by real data).
            ${data.bestNextMove.platform ? `It has not been posted to <strong>${esc(data.bestNextMove.platform)}</strong> yet, and that platform has the strongest track record for it.` : 'No untried platform clears the minimum evidence bar for it yet.'}</p>
         <p class="muted">${esc(data.bestNextMove.score.explanation)}</p>
       </div>`
    : `<div class="callout muted-callout"><p class="muted">Not enough data yet for a recommendation. Run "ingest", then drop a GA4/GSC export in the inbox folder (see below).</p></div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Distribution Tracker</title>
<style>
  .viz-root {
    color-scheme: light;
    --surface-1:      #fcfcfb;
    --page-plane:     #f9f9f7;
    --text-primary:   #0b0b0b;
    --text-secondary: #52514e;
    --text-muted:     #898781;
    --gridline:       #e1e0d9;
    --border:         rgba(11,11,11,0.10);
    --series-1:       #2a78d6;
    --status-good:        #0ca30c;
    --status-warning:     #fab219;
    --status-serious:     #ec835a;
    --status-critical:    #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1:      #1a1a19;
      --page-plane:     #0d0d0d;
      --text-primary:   #f0efec;
      --text-secondary: #c3c2b7;
      --text-muted:     #898781;
      --gridline:       #2c2c2a;
      --border:         rgba(255,255,255,0.10);
      --series-1:       #3987e5;
      --status-good:        #0ca30c;
      --status-warning:     #fab219;
      --status-serious:     #ec835a;
      --status-critical:    #d03b3b;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page-plane); color: var(--text-primary);
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .viz-root { max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: .04em; }
  .meta { color: var(--text-muted); font-size: 13px; margin-bottom: 28px; }
  .meta span { margin-right: 16px; }
  section { margin-bottom: 36px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .tile .value { font-size: 28px; font-weight: 600; font-variant-numeric: proportional-nums; }
  .tile .label { font-size: 13px; color: var(--text-secondary); margin-top: 4px; }
  .callout { background: var(--surface-1); border: 1px solid var(--border); border-left: 4px solid var(--series-1);
             border-radius: 10px; padding: 16px 20px; }
  .callout-title { font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary); margin-bottom: 8px; }
  .callout p { margin: 6px 0; line-height: 1.5; }
  .muted-callout { border-left-color: var(--text-muted); }
  table { width: 100%; border-collapse: collapse; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--gridline); font-size: 13.5px; vertical-align: top; }
  th { color: var(--text-secondary); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  tr:last-child td { border-bottom: none; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  td.name { font-weight: 600; white-space: nowrap; }
  td.explain { color: var(--text-secondary); }
  td.empty { color: var(--text-muted); text-align: center; padding: 20px; }
  .urlcell a, .callout a { color: var(--series-1); text-decoration: none; }
  .urlcell a:hover, .callout a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700;
           letter-spacing: .02em; color: #fff; white-space: nowrap; }
  .badge-good { background: var(--status-good); }
  .badge-warning { background: var(--status-warning); color: #0b0b0b; }
  .badge-serious { background: var(--status-serious); }
  .badge-critical { background: var(--status-critical); }
  .badge-muted { background: var(--text-muted); }
  .bar-row { display: flex; align-items: center; gap: 8px; min-width: 120px; }
  .bar-label { font-variant-numeric: tabular-nums; font-size: 12.5px; width: 42px; text-align: right; flex: none; }
  .bar-track { flex: 1; height: 6px; border-radius: 4px; background: var(--gridline); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; background: var(--series-1); }
  .muted { color: var(--text-muted); font-size: 13px; }
  .inbox-list { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
  .inbox-list li { padding: 6px 0; border-bottom: 1px solid var(--gridline); }
  .inbox-list li:last-child { border-bottom: none; }
  .footnote { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div class="viz-root">
  <h1>Distribution Tracker</h1>
  <div class="meta">
    <span>Generated ${esc(data.generatedAt)}</span>
    <span>Environment: ${esc(data.environment)}</span>
    <span>${data.intelligenceOn ? (data.shadowMode ? 'Shadow mode ON — observing only' : 'LIVE — can act on approved items') : 'Intelligence layer OFF'}</span>
  </div>

  <section>
    <div class="tiles">
      ${statTiles.map(t => `<div class="tile"><div class="value">${esc(t.value)}</div><div class="label">${esc(t.label)}</div></div>`).join('')}
    </div>
    ${bestMove}
  </section>

  <section>
    <h2>Which platforms actually work</h2>
    <table>
      <thead><tr><th>Platform</th><th>Verdict</th><th>Posts</th><th>Indexed</th><th>Sessions / post</th><th>Leads</th></tr></thead>
      <tbody>${platformRows(data.platforms)}</tbody>
    </table>
  </section>

  <section>
    <h2>Top reports by opportunity score</h2>
    <table>
      <thead><tr><th>Report</th><th>Score</th><th>Coverage</th><th>Why</th></tr></thead>
      <tbody>${scoreRows(data.scores)}</tbody>
    </table>
  </section>

  <section>
    <h2>Content patterns (observational, not causal)</h2>
    <table>
      <thead><tr><th>Trait</th><th>Outcome</th><th>Correlation</th><th>Sample</th><th>Reading</th></tr></thead>
      <tbody>${contentRows(data.content)}</tbody>
    </table>
  </section>

  <section>
    <h2>New files picked up this run (data/manual-imports/inbox)</h2>
    ${inboxSummary(data.inbox)}
    <p class="footnote">Drop a GA4/GSC CSV export named like "ga4-2026-11-17.csv" or "gsc-2026-11-17.csv" into that folder — it's read in automatically next refresh and moved to "imported" once done.</p>
  </section>

  <section>
    <h2>Data sources</h2>
    <table>
      <thead><tr><th>Source</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${credentialRows(data.credentials)}</tbody>
    </table>
    <p class="footnote">${data.totalRowsStored} total row(s) stored locally. Nothing on this page can change a live post — approvals and applies stay in the CLI on purpose.</p>
  </section>
</div>
</body>
</html>`;
}

export function writeDashboard(data: DashboardData, outFile: string): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, renderDashboardHtml(data), 'utf8');
}
