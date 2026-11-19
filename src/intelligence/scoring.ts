/**
 * scoring.ts — opportunity scoring.
 *
 * Answers: "of all the reports we could promote next, which deserve the slot?"
 *
 * Design rules:
 *  - Every signal is normalised to 0..1 before weighting, so a weight genuinely
 *    expresses relative importance rather than accidentally encoding the unit
 *    of its input.
 *  - A missing signal is NOT zero. Zero means "measured, and it was nothing";
 *    missing means "we don't know". Missing signals are excluded and the
 *    remaining weights are renormalised, so a report is never punished merely
 *    for lacking data we failed to collect.
 *  - Every score carries its component breakdown, so it can always be explained.
 *  - Scores are advisory. Changing posting order requires a separate flag.
 *
 * THE WEIGHTS ARE UNCALIBRATED. See weights.ts.
 */

import type { DB } from './db.js';
import { nowIso, daysAgo } from './db.js';
import {
  loadWeights, normaliseWeights, WEIGHTS_VERSION,
  DEFAULT_THRESHOLDS, type ScoreWeights, type Thresholds,
} from './weights.js';
import { FLAGS, enabled } from './flags.js';
import { normaliseUrl } from './indexation.js';
import { computePlatformStats, matchPlatformsForReport, type PlatformWindowStats } from './platformIntelligence.js';

/** A signal is a number in 0..1, or null meaning "not known". */
export type Signal = number | null;

export interface SignalSet {
  searchDemand: Signal;
  rankingOpportunity: Signal;
  indexation: Signal;
  historicalTraffic: Signal;
  historicalLeads: Signal;
  geographic: Signal;
  platformSuitability: Signal;
  /** Days since this report was last promoted; null if never. */
  daysSinceLastPromotion: number | null;
}

export interface ScoreComponent {
  signal: string;
  raw: Signal;
  weight: number;
  contribution: number;
  missing: boolean;
}

export interface ScoreResult {
  reportUrl: string;
  score: number;
  components: ScoreComponent[];
  recencyMultiplier: number;
  weightsVersion: string;
  /** Fraction of total weight that was actually available (0..1). */
  coverage: number;
  explanation: string;
}

export function clamp01(n: number): number {
  // NaN means "no answer" -> 0. Infinity is still an ordering, so it clamps
  // to the bound it is heading toward rather than collapsing to 0, which
  // would silently turn an overflowing signal into the weakest one.
  if (Number.isNaN(n)) return 0;
  if (n === Infinity) return 1;
  if (n === -Infinity) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalise a raw count against a reference ceiling using a log curve.
 * Log, not linear: the difference between 0 and 100 impressions matters far
 * more than between 10,000 and 10,100.
 */
export function logNormalise(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (ceiling <= 1) return clamp01(value);
  return clamp01(Math.log1p(value) / Math.log1p(ceiling));
}

/**
 * Ranking opportunity: mid-page ranks have the most upside.
 *
 * Already #1 => little to gain. Rank 200 => unrealistic. Ranks ~8-30 are where
 * a push plausibly converts to traffic. This mirrors the intent of the existing
 * P1/P2/P3 banding in seoAgentNew.ts rather than inventing a new scheme.
 */
export function rankingOpportunityFrom(position: number | null, t: Thresholds = DEFAULT_THRESHOLDS): Signal {
  if (position === null || !Number.isFinite(position) || position <= 0) return null;
  if (position <= 3) return 0.15;
  if (position <= 10) return 0.75;
  if (position <= t.rankTopBand) return 1.0;
  if (position <= t.rankMidBand) return 0.6;
  if (position <= 100) return 0.25;
  return 0.05;
}

/** Indexation evidence to a signal. 'unknown' stays missing, never 0. */
export function indexationSignal(status: string | null | undefined, confidence = 0.5): Signal {
  if (status === 'indexed') return clamp01(0.5 + confidence * 0.5);
  if (status === 'not_indexed') return clamp01(0.5 - confidence * 0.5);
  return null;
}

/**
 * Recency multiplier. Promoting the same report repeatedly in a short window
 * wastes slots, so a recent promotion scales the score down. Never zero — a
 * genuinely strong report should still be able to win a slot.
 */
export function recencyMultiplier(
  daysSince: number | null,
  weights: ScoreWeights,
  t: Thresholds = DEFAULT_THRESHOLDS,
): number {
  if (daysSince === null) return 1;
  if (daysSince >= t.recencyWindowDays) return 1;
  const freshness = clamp01(daysSince / t.recencyWindowDays);
  return clamp01(1 - weights.recencyPenalty * (1 - freshness));
}

const SIGNAL_KEYS = [
  'searchDemand', 'rankingOpportunity', 'indexation',
  'historicalTraffic', 'historicalLeads', 'geographic', 'platformSuitability',
] as const;

/**
 * Combine signals into a score.
 *
 * Missing signals are dropped and the remaining weights renormalised, so
 * `score` always means "of the evidence we have, how good is this" rather than
 * "how much evidence did we manage to collect". `coverage` reports how much of
 * the weight was actually backed by data — a high score at 20% coverage should
 * be trusted far less than the same score at 90%.
 */
export function computeScore(
  reportUrl: string,
  signals: SignalSet,
  weights: ScoreWeights = loadWeights(),
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ScoreResult {
  const w = normaliseWeights(weights);
  const components: ScoreComponent[] = [];

  let availableWeight = 0;
  let weighted = 0;

  for (const key of SIGNAL_KEYS) {
    const raw = signals[key];
    const weight = w[key];
    const missing = raw === null || raw === undefined || Number.isNaN(raw as number);
    const value = missing ? 0 : clamp01(raw as number);
    const contribution = missing ? 0 : value * weight;

    if (!missing) {
      availableWeight += weight;
      weighted += contribution;
    }
    components.push({ signal: key, raw: missing ? null : value, weight, contribution, missing });
  }

  const coverage = clamp01(availableWeight);
  const base = availableWeight > 0 ? weighted / availableWeight : 0;
  const mult = recencyMultiplier(signals.daysSinceLastPromotion, w, thresholds);
  const score = clamp01(base * mult);

  const present = components.filter(c => !c.missing).sort((a, b) => b.contribution - a.contribution);
  const top = present.slice(0, 3).map(c => `${c.signal}=${(c.raw as number).toFixed(2)}`).join(', ');
  const missingNames = components.filter(c => c.missing).map(c => c.signal);

  const explanation =
    `score ${score.toFixed(3)} (coverage ${(coverage * 100).toFixed(0)}%` +
    `${mult < 1 ? `, recency x${mult.toFixed(2)}` : ''})` +
    `${top ? ` — driven by ${top}` : ' — no signals available'}` +
    `${missingNames.length ? `; missing: ${missingNames.join(', ')}` : ''}`;

  return { reportUrl, score, components, recencyMultiplier: mult, weightsVersion: WEIGHTS_VERSION, coverage, explanation };
}

// ── Signal gathering from the store ──────────────────────────────────────────

export interface GatherOptions {
  db: DB;
  reportUrl: string;
  /** Lookback window for traffic and lead history. */
  windowDays?: number;
  /** Ceiling used to normalise impression counts; defaults to a sane constant. */
  impressionCeiling?: number;
  sessionCeiling?: number;
  leadCeiling?: number;
  /**
   * Precomputed PlatformWindowStats, so scoring a batch of reports doesn't
   * recompute them (a full published_posts/url_performance/leads scan) once
   * per report. Only used when FEATURE_PLATFORM_INTELLIGENCE is on; computed
   * lazily here if omitted, for standalone/test callers.
   */
  platformStats?: PlatformWindowStats[];
}

export function gatherSignals(opts: GatherOptions): SignalSet {
  const { db, reportUrl } = opts;
  const windowDays = opts.windowDays ?? 90;
  const since = daysAgo(windowDays);

  const gsc = db.prepare(
    `SELECT SUM(impressions) AS impressions, SUM(clicks) AS clicks, AVG(position) AS position
       FROM url_performance
      WHERE url = ? AND source IN ('gsc','gsc-manual') AND metric_date >= ? AND metric_scope = 'url'`
  ).get(reportUrl, since) as any;

  const ga4 = db.prepare(
    `SELECT SUM(sessions) AS sessions
       FROM url_performance
      WHERE url = ? AND source IN ('ga4','ga4-manual') AND metric_date >= ? AND metric_scope = 'url'`
  ).get(reportUrl, since) as any;

  const leadRow = db.prepare(
    `SELECT COUNT(*) AS leads FROM leads WHERE report_url = ? AND created_at >= ?`
  ).get(reportUrl, since) as any;

  // indexation_checks is keyed by the NORMALISED url; reportUrl is raw.
  // Looking it up raw silently never matched, so indexation was always missing.
  const idx = db.prepare(
    `SELECT status, confidence FROM indexation_checks
      WHERE url = ? ORDER BY checked_at DESC LIMIT 1`
  ).get(normaliseUrl(reportUrl)) as any;

  const lastPost = db.prepare(
    `SELECT MAX(posted_at) AS last FROM published_posts WHERE report_url = ?`
  ).get(reportUrl) as any;

  // platformSuitability: "given THIS report, is there a platform it should
  // go to that it hasn't been tried on yet, with a proven track record?"
  // Gated on PLATFORM_INTELLIGENCE independently of OPPORTUNITY_SCORING, so
  // turning scoring on alone doesn't silently pull in a second subsystem.
  // Insufficient data stays null (missing, excluded+renormalised) — never 0.
  let platformSuitability: Signal = null;
  if (enabled('PLATFORM_INTELLIGENCE')) {
    const stats = opts.platformStats ?? computePlatformStats({ db, windowDays });
    platformSuitability = matchPlatformsForReport(db, reportUrl, stats).suitability;
  }

  const impressions = Number(gsc?.impressions ?? 0);
  const sessions = Number(ga4?.sessions ?? 0);
  const leads = Number(leadRow?.leads ?? 0);
  const position = gsc?.position === null || gsc?.position === undefined ? null : Number(gsc.position);

  const hasGsc = impressions > 0 || position !== null;
  const hasGa4Row = ga4 && ga4.sessions !== null && ga4.sessions !== undefined;

  let daysSince: number | null = null;
  if (lastPost?.last) {
    const ms = Date.parse(lastPost.last);
    if (!Number.isNaN(ms)) daysSince = Math.floor((Date.now() - ms) / 86_400_000);
  }

  return {
    searchDemand: hasGsc ? logNormalise(impressions, opts.impressionCeiling ?? 50_000) : null,
    rankingOpportunity: rankingOpportunityFrom(position),
    indexation: indexationSignal(idx?.status, idx?.confidence ?? 0.5),
    historicalTraffic: hasGa4Row ? logNormalise(sessions, opts.sessionCeiling ?? 5_000) : null,
    // Leads: zero leads IS a measurement once any lead data exists at all.
    historicalLeads: hasAnyLeadData(db) ? logNormalise(leads, opts.leadCeiling ?? 50) : null,
    geographic: null,
    platformSuitability,
    daysSinceLastPromotion: daysSince,
  };
}

function hasAnyLeadData(db: DB): boolean {
  const r = db.prepare('SELECT COUNT(*) AS c FROM leads').get() as any;
  return Number(r?.c ?? 0) > 0;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export function saveScore(db: DB, result: ScoreResult, shadow = true): number {
  const r = db.prepare(
    `INSERT INTO opportunity_scores (report_url, scored_at, score, components, weights_version, shadow)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    result.reportUrl, nowIso(), result.score,
    JSON.stringify({ components: result.components, coverage: result.coverage, recencyMultiplier: result.recencyMultiplier }),
    result.weightsVersion, shadow ? 1 : 0,
  );
  return Number(r.lastInsertRowid);
}

/**
 * Score a batch of report URLs and persist the results.
 * Returns them ranked, highest first. Gated by FEATURE_OPPORTUNITY_SCORING.
 */
export function scoreReports(db: DB, reportUrls: string[], opts: { windowDays?: number } = {}): ScoreResult[] {
  if (!enabled('OPPORTUNITY_SCORING')) return [];

  const weights = loadWeights();
  // Computed ONCE for the whole batch (not per report) — computePlatformStats
  // scans published_posts/url_performance/leads for every registered
  // platform, so doing it per-report would multiply that scan by report count.
  const platformStats = enabled('PLATFORM_INTELLIGENCE')
    ? computePlatformStats({ db, windowDays: opts.windowDays })
    : undefined;
  const results = reportUrls.map(url =>
    computeScore(url, gatherSignals({ db, reportUrl: url, windowDays: opts.windowDays, platformStats }), weights),
  );

  const shadow = FLAGS.SHADOW_MODE || !FLAGS.SCORING_INFLUENCES_ORDER;
  for (const r of results) saveScore(db, r, shadow);

  return results.sort((a, b) => b.score - a.score);
}

/**
 * The ordering the system should use. Returns the input order UNCHANGED unless
 * scores are explicitly allowed to influence ordering — so turning scoring on
 * is observably safe before it is behaviourally live.
 */
export function applyScoreOrdering(reportUrls: string[], scores: ScoreResult[]): string[] {
  if (!enabled('SCORING_INFLUENCES_ORDER') || FLAGS.SHADOW_MODE) return reportUrls;
  const byUrl = new Map(scores.map(s => [s.reportUrl, s.score]));
  return [...reportUrls].sort((a, b) => (byUrl.get(b) ?? 0) - (byUrl.get(a) ?? 0));
}
