/**
 * platformIntelligence.ts — which platforms are actually worth posting to.
 *
 * The system posts to 30+ platforms on a fixed schedule. Nobody currently
 * knows which of them produce anything. This module answers that from the
 * collected data, per platform, over a window:
 *
 *   posts        — how many we published
 *   indexed      — how many are in Google's index (evidence-based, tri-state)
 *   sessions     — GA4 traffic attributed to that platform via utm_source
 *   leads        — CRM leads attributed to that platform
 *   per-post     — the ratios that make platforms comparable
 *
 * Deliberate restraint: this module RECOMMENDS, it never changes the schedule.
 * Dropping a platform is a human decision, and the data behind it must be
 * legible enough to argue with.
 */

import type { DB } from './db.js';
import { nowIso, daysAgo, isoDate } from './db.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from './weights.js';
import { PLATFORMS, platformByName, type PlatformInfo } from './platforms.js';
import { enabled } from './flags.js';
import { normaliseUrl } from './indexation.js';

export interface PlatformWindowStats {
  platform: string;
  windowStart: string;
  windowEnd: string;
  posts: number;
  postsIndexed: number;
  postsNotIndexed: number;
  postsUnknown: number;
  sessions: number;
  clicks: number;
  impressions: number;
  leads: number;
  /** Share of posts with positive indexation evidence. Excludes unknowns. */
  indexationRate: number | null;
  sessionsPerPost: number | null;
  leadsPerPost: number | null;
  /** How much of the picture we actually have, 0..1. */
  dataCoverage: number;
}

export type Recommendation = 'keep' | 'investigate' | 'consider-dropping' | 'insufficient-data';

export interface PlatformVerdict {
  platform: string;
  stats: PlatformWindowStats;
  recommendation: Recommendation;
  reasons: string[];
  /** Never silently acted on. Always requires a human. */
  confidence: 'low' | 'medium' | 'high';
}

export interface ComputeOptions {
  db: DB;
  windowDays?: number;
  endDate?: string;
  thresholds?: Thresholds;
}

/**
 * Indexation rate deliberately EXCLUDES unknowns from the denominator.
 * Counting an unknown as "not indexed" would make a flaky SERP provider look
 * like a failing platform.
 */
/**
 * Every spelling of a platform that might appear in published_posts.platform.
 * The sheet, the posting agents and the UTM table do not agree on one form, so
 * matching on a single field silently loses whole platforms.
 */
export function platformAliases(p: PlatformInfo): string[] {
  return [...new Set([p.key, p.name, p.utmSource].map(v => String(v).toLowerCase()))];
}

export function indexationRate(indexed: number, notIndexed: number): number | null {
  const known = indexed + notIndexed;
  return known === 0 ? null : indexed / known;
}

export function computePlatformStats(opts: ComputeOptions): PlatformWindowStats[] {
  const { db } = opts;
  const windowDays = opts.windowDays ?? 90;
  const windowEnd = opts.endDate ?? isoDate();
  const windowStart = daysAgo(windowDays, new Date(`${windowEnd}T00:00:00Z`));

  const out: PlatformWindowStats[] = [];

  for (const p of PLATFORMS) {
    // Match key, display name AND utmSource. The ingest normalises a sheet
    // value like "Google Sites" to "googlesites", which is the utmSource form
    // and matches neither the key ("googlesite") nor the name ("GoogleSite").
    // Without this, 44 Google Sites posts and 17 4shared posts read as zero and
    // both platforms reported "insufficient-data" while being actively used.
    const aliases = platformAliases(p);
    const posts = db.prepare(
      `SELECT COUNT(*) AS c FROM published_posts
        WHERE LOWER(platform) IN (${aliases.map(() => '?').join(',')})
          AND posted_at >= ? AND posted_at <= ?`
    ).get(...aliases, windowStart, `${windowEnd}T23:59:59Z`) as any;

    // indexation_checks stores the NORMALISED url (scheme/www/utm/trailing
    // slash stripped) while published_posts stores the raw url from the sheet.
    // A SQL join on equality therefore matches nothing — it silently reported
    // zero indexation for every platform forever. Normalise in JS and look the
    // checks up by key instead.
    const postUrls = (db.prepare(
      `SELECT published_url FROM published_posts
        WHERE LOWER(platform) IN (${aliases.map(() => '?').join(',')})
          AND posted_at >= ? AND published_url IS NOT NULL`
    ).all(...aliases, windowStart) as any[])
      .map(r => normaliseUrl(String(r.published_url)))
      .filter(Boolean);

    const idx = { indexed: 0, notIndexed: 0, unknown: 0 };
    if (postUrls.length) {
      const latest = db.prepare(
        `SELECT status FROM indexation_checks
          WHERE url = ? ORDER BY checked_at DESC LIMIT 1`
      );
      for (const u of postUrls) {
        const row = latest.get(u) as any;
        if (!row) continue;
        if (row.status === 'indexed') idx.indexed++;
        else if (row.status === 'not_indexed') idx.notIndexed++;
        else idx.unknown++;
      }
    }

    // GA4 attributes traffic by utm_source, which the posting code already sets
    // on every outbound link (see src/utils/utm.ts).
    //
    // Storage convention comes from collectors/ga4.ts and MUST be matched
    // exactly: platform rows use metric_scope='utm_source' and pack the
    // dimension as '<sessionSource>|<sessionCampaign>'. Matching the source
    // part therefore needs a prefix comparison, not equality — an earlier
    // equality match silently returned zero sessions for every platform,
    // which would have made the whole estate look dead.
    const traffic = db.prepare(
      `SELECT SUM(sessions) AS sessions, SUM(clicks) AS clicks, SUM(impressions) AS impressions
         FROM url_performance
        WHERE metric_scope = 'utm_source'
          AND (LOWER(dimension_value) = ? OR LOWER(dimension_value) LIKE ? )
          AND metric_date >= ? AND metric_date <= ?`
    ).get(
      p.utmSource.toLowerCase(),
      `${p.utmSource.toLowerCase()}|%`,
      windowStart, windowEnd,
    ) as any;

    const leadRow = db.prepare(
      `SELECT COUNT(*) AS c FROM leads
        WHERE LOWER(utm_source) = ? AND created_at >= ?`
    ).get(p.utmSource.toLowerCase(), windowStart) as any;

    const postCount = Number(posts?.c ?? 0);
    const indexed = Number(idx?.indexed ?? 0);
    const notIndexed = Number(idx?.notIndexed ?? 0);
    const unknown = Number(idx?.unknown ?? 0);
    const sessions = Number(traffic?.sessions ?? 0);
    const leads = Number(leadRow?.c ?? 0);

    const haveIndexation = indexed + notIndexed + unknown > 0;
    const haveTraffic = traffic && traffic.sessions !== null && traffic.sessions !== undefined;
    const haveLeads = hasAnyLeads(db);
    const coverage = [postCount > 0, haveIndexation, haveTraffic, haveLeads]
      .filter(Boolean).length / 4;

    out.push({
      platform: p.name,
      windowStart, windowEnd,
      posts: postCount,
      postsIndexed: indexed,
      postsNotIndexed: notIndexed,
      postsUnknown: unknown,
      sessions,
      clicks: Number(traffic?.clicks ?? 0),
      impressions: Number(traffic?.impressions ?? 0),
      leads,
      indexationRate: indexationRate(indexed, notIndexed),
      sessionsPerPost: postCount > 0 && haveTraffic ? sessions / postCount : null,
      leadsPerPost: postCount > 0 && haveLeads ? leads / postCount : null,
      dataCoverage: coverage,
    });
  }

  return out;
}

function hasAnyLeads(db: DB): boolean {
  const r = db.prepare('SELECT COUNT(*) AS c FROM leads').get() as any;
  return Number(r?.c ?? 0) > 0;
}

/**
 * Turn stats into a recommendation.
 *
 * The bar for "consider dropping" is deliberately high: a sufficient sample,
 * real traffic data, AND genuinely poor output. Absence of data is reported as
 * absence of data — never as failure.
 */
export function recommend(
  s: PlatformWindowStats,
  t: Thresholds = DEFAULT_THRESHOLDS,
): PlatformVerdict {
  const reasons: string[] = [];

  if (s.posts < t.platformMinimumSample) {
    reasons.push(`only ${s.posts} posts in window (need ${t.platformMinimumSample} to judge)`);
    return { platform: s.platform, stats: s, recommendation: 'insufficient-data', reasons, confidence: 'low' };
  }

  if (s.sessionsPerPost === null && s.leadsPerPost === null) {
    reasons.push('no traffic or lead data collected yet — cannot assess value');
    return { platform: s.platform, stats: s, recommendation: 'insufficient-data', reasons, confidence: 'low' };
  }

  const poorTraffic = s.sessionsPerPost !== null && s.sessionsPerPost < t.platformSessionsPerPostFloor;
  const noLeads = s.leadsPerPost !== null && s.leadsPerPost === 0;
  const poorIndexation = s.indexationRate !== null && s.indexationRate < 0.25;

  if (s.leadsPerPost !== null && s.leadsPerPost > 0) {
    reasons.push(`produces leads (${s.leads} from ${s.posts} posts)`);
    return { platform: s.platform, stats: s, recommendation: 'keep', reasons, confidence: 'high' };
  }

  if (poorTraffic && noLeads) {
    reasons.push(`${s.sessionsPerPost!.toFixed(2)} sessions/post (floor ${t.platformSessionsPerPostFloor})`);
    reasons.push('zero attributed leads');
    if (poorIndexation) reasons.push(`only ${(s.indexationRate! * 100).toFixed(0)}% of posts show indexation evidence`);
    const confidence = s.dataCoverage >= 0.75 ? 'high' : 'medium';
    return { platform: s.platform, stats: s, recommendation: 'consider-dropping', reasons, confidence };
  }

  if (poorIndexation) {
    reasons.push(`low indexation evidence (${(s.indexationRate! * 100).toFixed(0)}%) — posts may not be visible to search`);
    return { platform: s.platform, stats: s, recommendation: 'investigate', reasons, confidence: 'medium' };
  }

  if (poorTraffic) {
    reasons.push(`low traffic (${s.sessionsPerPost!.toFixed(2)} sessions/post) but lead data is inconclusive`);
    return { platform: s.platform, stats: s, recommendation: 'investigate', reasons, confidence: 'medium' };
  }

  reasons.push(`${s.sessionsPerPost?.toFixed(2) ?? '?'} sessions/post`);
  return { platform: s.platform, stats: s, recommendation: 'keep', reasons, confidence: s.dataCoverage >= 0.75 ? 'high' : 'medium' };
}

// ── Per-report platform matching ───────────────────────────────────────────
//
// computePlatformStats/recommend answer "is this platform worth posting to
// at all". This answers the narrower, originally-planned question: "given
// THIS report, which of our platforms should it go on" — scoring.ts has a
// platformSuitability signal slot that has never been filled; this is what
// fills it.
//
// Duplicated tiny helpers (not imported from scoring.ts) to avoid a circular
// import: scoring.ts calls matchPlatformsForReport, so this module must not
// import scoring.ts.
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function logNormalise(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (ceiling <= 1) return clamp01(value);
  return clamp01(Math.log1p(value) / Math.log1p(ceiling));
}

export interface PlatformFit {
  platform: string;
  /** Has THIS report already been posted to this platform? */
  tried: boolean;
  /**
   * 'direct'  — this report's OWN post on this platform has performance data.
   * 'general' — no data for this report specifically; falling back to the
   *             platform's overall track record (computePlatformStats).
   * 'none'    — neither exists. fit is null, never a guessed number.
   */
  evidence: 'direct' | 'general' | 'none';
  sessionsPerPost: number | null;
  leadsPerPost: number | null;
  /** 0..1, log-scaled. null means "not enough data to judge", never zero. */
  fit: number | null;
  reason: string;
}

export interface PlatformMatchResult {
  reportUrl: string;
  /** Every registered platform, best fit first; ties broken by name. */
  ranked: PlatformFit[];
  /** Best-fitting platform this report has NOT been posted to yet, or null. */
  bestUntried: PlatformFit | null;
  /** Scalar for scoring.ts's platformSuitability signal. */
  suitability: number | null;
  /** Fraction of registered platforms with ANY usable fit, direct or general. */
  coverage: number;
}

export interface MatchOptions {
  thresholds?: Thresholds;
  sessionCeiling?: number;
  leadCeiling?: number;
}

/**
 * Rank every registered platform for ONE report. Caller supplies
 * precomputed PlatformWindowStats (from computePlatformStats) rather than
 * this function recomputing them, so scoring an entire batch of reports
 * doesn't re-scan published_posts/url_performance/leads once per report.
 */
export function matchPlatformsForReport(
  db: DB,
  reportUrl: string,
  stats: PlatformWindowStats[],
  opts: MatchOptions = {},
): PlatformMatchResult {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const sessionCeiling = opts.sessionCeiling ?? 5_000;
  const leadCeiling = opts.leadCeiling ?? 50;
  const statsByPlatform = new Map(stats.map(s => [s.platform, s]));

  // Which platforms has THIS report already been posted to, and with which
  // published URL. Matched through the same alias set computePlatformStats
  // uses, since the sheet/posting-agents don't agree on one spelling.
  const triedRows = db.prepare(
    `SELECT LOWER(platform) AS platform, published_url FROM published_posts
      WHERE report_url = ? AND platform IS NOT NULL`
  ).all(reportUrl) as Array<{ platform: string; published_url: string | null }>;

  const ranked: PlatformFit[] = PLATFORMS.map((p): PlatformFit => {
    const aliases = new Set(platformAliases(p));
    const triedRow = triedRows.find(r => aliases.has(r.platform));
    const tried = Boolean(triedRow);
    const general = statsByPlatform.get(p.name) ?? null;

    // Direct evidence: THIS report's own post on THIS platform — stronger
    // than the platform-wide average, because it is literally this content.
    let direct: { sessions: number; leads: number } | null = null;
    if (tried && triedRow?.published_url) {
      const perf = db.prepare(
        `SELECT SUM(sessions) AS sessions FROM url_performance
          WHERE url = ? AND metric_scope = 'url' AND sessions IS NOT NULL`
      ).get(triedRow.published_url) as any;
      const leadRow = db.prepare(
        `SELECT COUNT(*) AS c FROM leads WHERE LOWER(utm_source) = ? AND report_url = ?`
      ).get(p.utmSource.toLowerCase(), reportUrl) as any;
      const hasPerf = perf && perf.sessions !== null && perf.sessions !== undefined;
      const leads = Number(leadRow?.c ?? 0);
      if (hasPerf || leads > 0) direct = { sessions: Number(perf?.sessions ?? 0), leads };
    }

    if (direct) {
      const fit = Math.max(logNormalise(direct.sessions, sessionCeiling), logNormalise(direct.leads, leadCeiling));
      return {
        platform: p.name, tried, evidence: 'direct',
        sessionsPerPost: direct.sessions, leadsPerPost: direct.leads, fit,
        reason: `this report's own post here: ${direct.sessions} session(s), ${direct.leads} lead(s)`,
      };
    }

    const hasGeneralTrack = general !== null
      && general.posts >= thresholds.platformMinimumSample
      && (general.sessionsPerPost !== null || general.leadsPerPost !== null);

    if (hasGeneralTrack && general) {
      const fit = Math.max(
        general.sessionsPerPost !== null ? logNormalise(general.sessionsPerPost, sessionCeiling) : 0,
        general.leadsPerPost !== null ? logNormalise(general.leadsPerPost, leadCeiling) : 0,
      );
      return {
        platform: p.name, tried, evidence: 'general',
        sessionsPerPost: general.sessionsPerPost, leadsPerPost: general.leadsPerPost, fit,
        reason: tried
          ? 'already posted here; no performance data for this specific post yet — showing the platform\'s general track record'
          : `not yet tried for this report; platform's general track record: ${general.sessionsPerPost?.toFixed(2) ?? '0'} sessions/post`,
      };
    }

    return {
      platform: p.name, tried, evidence: 'none',
      sessionsPerPost: general?.sessionsPerPost ?? null, leadsPerPost: general?.leadsPerPost ?? null, fit: null,
      reason: tried
        ? 'already posted here; not enough data yet to judge it'
        : `insufficient data — only ${general?.posts ?? 0} post(s) platform-wide (need ${thresholds.platformMinimumSample})`,
    };
  }).sort((a, b) => (b.fit ?? -1) - (a.fit ?? -1) || a.platform.localeCompare(b.platform));

  const bestUntried = ranked.find(r => !r.tried && r.fit !== null) ?? null;
  const coverage = ranked.length === 0 ? 0 : ranked.filter(r => r.fit !== null).length / ranked.length;

  return { reportUrl, ranked, bestUntried, suitability: bestUntried?.fit ?? null, coverage };
}

/** Human-readable ranked list for the CLI. */
export function formatPlatformMatchReport(result: PlatformMatchResult): string {
  const lines = [
    `Platform fit for ${result.reportUrl}`,
    result.bestUntried
      ? `Best untried platform: ${result.bestUntried.platform} (fit ${result.bestUntried.fit!.toFixed(2)}) — ${result.bestUntried.reason}`
      : 'No untried platform currently has enough data to recommend one.',
    '',
  ];
  for (const r of result.ranked) {
    const fitStr = r.fit === null ? '—' : r.fit.toFixed(2);
    lines.push(`  ${r.platform.padEnd(16)} fit=${fitStr.padStart(4)}  ${(r.tried ? 'tried' : 'untried').padEnd(8)}  (${r.evidence})  ${r.reason}`);
  }
  lines.push('');
  lines.push(`Coverage: ${(result.coverage * 100).toFixed(0)}% of platforms have enough data to judge.`);
  lines.push('"—" means not enough data to judge, never zero. Advisory only — nothing here posts or reorders automatically.');
  return lines.join('\n');
}

export function persistPlatformStats(db: DB, stats: PlatformWindowStats[]): number {
  let n = 0;
  for (const s of stats) {
    db.prepare(
      `INSERT INTO platform_stats
         (platform, window_start, window_end, posts, posts_indexed, posts_unknown,
          sessions, clicks, impressions, leads, success_rate, sessions_per_post,
          leads_per_post, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(platform, window_start, window_end) DO UPDATE SET
         posts=excluded.posts, posts_indexed=excluded.posts_indexed,
         posts_unknown=excluded.posts_unknown, sessions=excluded.sessions,
         clicks=excluded.clicks, impressions=excluded.impressions,
         leads=excluded.leads, success_rate=excluded.success_rate,
         sessions_per_post=excluded.sessions_per_post,
         leads_per_post=excluded.leads_per_post, computed_at=excluded.computed_at`
    ).run(
      s.platform, s.windowStart, s.windowEnd, s.posts, s.postsIndexed, s.postsUnknown,
      s.sessions, s.clicks, s.impressions, s.leads, s.indexationRate,
      s.sessionsPerPost, s.leadsPerPost, nowIso(),
    );
    n++;
  }
  return n;
}

export function analysePlatforms(opts: ComputeOptions): PlatformVerdict[] {
  if (!enabled('PLATFORM_INTELLIGENCE')) return [];
  const stats = computePlatformStats(opts);
  persistPlatformStats(opts.db, stats);
  return stats
    .map(s => recommend(s, opts.thresholds))
    .sort((a, b) => (b.stats.sessionsPerPost ?? -1) - (a.stats.sessionsPerPost ?? -1));
}

/** Human-readable table for the CLI report. */
export function formatPlatformReport(verdicts: PlatformVerdict[]): string {
  if (!verdicts.length) return 'No platform data. Is FEATURE_PLATFORM_INTELLIGENCE enabled, and has any data been collected?';

  const rows = verdicts.map(v => ({
    platform: v.platform,
    posts: String(v.stats.posts),
    idx: v.stats.indexationRate === null ? '—' : `${(v.stats.indexationRate * 100).toFixed(0)}%`,
    spp: v.stats.sessionsPerPost === null ? '—' : v.stats.sessionsPerPost.toFixed(2),
    leads: v.stats.leadsPerPost === null ? '—' : String(v.stats.leads),
    rec: v.recommendation,
  }));

  const w = (k: keyof typeof rows[0], min: number) =>
    Math.max(min, ...rows.map(r => r[k].length));
  const wp = w('platform', 8), wr = w('rec', 14);

  const lines = [
    `${'PLATFORM'.padEnd(wp)}  ${'POSTS'.padStart(5)}  ${'INDEX'.padStart(5)}  ${'SESS/POST'.padStart(9)}  ${'LEADS'.padStart(5)}  RECOMMENDATION`,
    `${'-'.repeat(wp)}  ${'-'.repeat(5)}  ${'-'.repeat(5)}  ${'-'.repeat(9)}  ${'-'.repeat(5)}  ${'-'.repeat(wr)}`,
  ];
  for (const r of rows) {
    lines.push(`${r.platform.padEnd(wp)}  ${r.posts.padStart(5)}  ${r.idx.padStart(5)}  ${r.spp.padStart(9)}  ${r.leads.padStart(5)}  ${r.rec}`);
  }
  lines.push('');
  lines.push('"—" means not measured. Recommendations are advisory; the schedule is never changed automatically.');
  return lines.join('\n');
}
