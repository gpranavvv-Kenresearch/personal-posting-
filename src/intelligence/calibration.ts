/**
 * calibration.ts — are the scoring weights any good?
 *
 * weights.ts says plainly that every number in it is an UNCALIBRATED starting
 * guess. This module is the only thing that can turn one of those guesses into
 * a finding: it pairs each historical score with what actually happened
 * afterwards, measures how well the score ORDERED reality, and proposes a
 * better weight set.
 *
 * Four decisions worth stating, because each one is a place this kind of
 * analysis usually goes quietly wrong:
 *
 *  1. NO LOOKAHEAD. An outcome counts only if it happened strictly AFTER the
 *     score was recorded. Scoring a report and then crediting it with traffic
 *     it had already earned would make any weight set look brilliant. The
 *     boundary is enforced in SQL and tested directly (see outcomeBounds).
 *     Scores whose outcome window has not closed yet are excluded too — a
 *     three-day-old score judged on a thirty-day window is not a weak data
 *     point, it is a wrong one.
 *
 *  2. SPEARMAN, NOT PEARSON. The score's job is to decide what gets the next
 *     slot, so only the ORDER matters. Rank correlation measures exactly that
 *     and is unbothered by the fact that sessions are heavy-tailed. Ties get
 *     average ranks, which matters a lot here: "zero leads" is the single most
 *     common outcome in this dataset.
 *
 *  3. DETERMINISTIC SEARCH. Coordinate ascent over a fixed multiplier grid.
 *     No randomness: Math.random() makes a result irreproducible, and an
 *     irreproducible recommendation about weights cannot be reviewed. Running
 *     this twice on the same data gives identical output. The honest cost of
 *     that choice: coordinate ascent stops on a plateau and finds a LOCAL
 *     optimum, so "no improvement found" means "none along these axes at this
 *     grid", not "the current weights are optimal". The report says as much.
 *
 *  4. NOTHING IS APPLIED AUTOMATICALLY. This module NEVER writes weights.ts
 *     and never mutates DEFAULT_WEIGHTS. It persists a calibration_runs row
 *     with applied = 0. Adopting a proposal is a human action: copy the
 *     numbers into DEFAULT_WEIGHTS in weights.ts and BUMP WEIGHTS_VERSION in
 *     the same commit — without the bump, old and new scores silently become
 *     uncomparable. Set calibration_runs.applied = 1 by hand once that commit
 *     lands, so the run that justified the change stays traceable.
 *
 * recencyPenalty is held FIXED during the search. It is a multiplier applied
 * outside the weighted average, and the multiplier that was actually in force
 * is recorded per score; re-deriving it per candidate would mean inventing
 * data. Only the seven positive signal weights are searched.
 */

import type { DB } from './db.js';
import { nowIso, isoDate } from './db.js';
import {
  DEFAULT_THRESHOLDS, WEIGHTS_VERSION, loadWeights, normaliseWeights,
  type ScoreWeights, type Thresholds,
} from './weights.js';
import { clamp01 } from './scoring.js';
import { enabled } from './flags.js';

/** The seven positive signals. recencyPenalty is deliberately not in here. */
export const POSITIVE_SIGNALS = [
  'searchDemand', 'rankingOpportunity', 'indexation',
  'historicalTraffic', 'historicalLeads', 'geographic', 'platformSuitability',
] as const;

export type PositiveSignal = typeof POSITIVE_SIGNALS[number];

export type OutcomeKind = 'sessions' | 'leads';

// ── Dataset ──────────────────────────────────────────────────────────────────

export interface DatasetRow {
  scoreId: number;
  reportUrl: string;
  scoredAt: string;
  /** The score as it was actually recorded, with the weights of that day. */
  score: number;
  weightsVersion: string;
  /** Raw 0..1 signal values; null means "was not known at scoring time". */
  signals: Record<PositiveSignal, number | null>;
  /** The recency multiplier in force for this score. Held fixed in search. */
  recencyMultiplier: number;
  /** What happened in the windowDays strictly after scoredAt. */
  outcome: number;
}

export interface Dataset {
  rows: DatasetRow[];
  /** Recorded scores, aligned index-for-index with `outcomes`. */
  scores: number[];
  outcomes: number[];
  n: number;
  outcome: OutcomeKind;
  windowDays: number;
  /** Scores excluded because their outcome window has not closed yet. */
  immatureExcluded: number;
}

export interface BuildDatasetOptions {
  db: DB;
  /** Days after the score in which outcomes are counted. Default 30. */
  windowDays?: number;
  outcome?: OutcomeKind;
  /** Only scores produced by this weights version. */
  weightsVersion?: string;
  /** Ignore scores older than this ISO timestamp. */
  since?: string;
  /** Injectable clock, so maturity tests do not depend on today's date. */
  now?: Date;
  /**
   * Keep scores whose outcome window has not fully elapsed. Off by default:
   * a truncated outcome is a wrong data point, not merely a noisy one.
   */
  includeImmature?: boolean;
  limit?: number;
}

function addDays(iso: string, days: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + days * 86_400_000).toISOString();
}

/**
 * The outcome window for one score: everything strictly after the score, up to
 * windowDays later.
 *
 * `afterDate` is the score's own calendar day, and the date comparison is
 * STRICT (`metric_date > afterDate`). A daily metric row stamped with the same
 * day as the score covers hours that preceded it, so counting it would leak
 * the past into a forward-looking measurement. Losing at most one day of
 * outcome is the correct price for that guarantee.
 */
export function outcomeBounds(scoredAt: string, windowDays: number) {
  const untilIso = addDays(scoredAt, windowDays);
  return {
    afterIso: scoredAt,
    untilIso,
    afterDate: isoDate(new Date(Date.parse(scoredAt))),
    untilDate: untilIso.slice(0, 10),
  };
}

function emptySignals(): Record<PositiveSignal, number | null> {
  return {
    searchDemand: null, rankingOpportunity: null, indexation: null,
    historicalTraffic: null, historicalLeads: null, geographic: null,
    platformSuitability: null,
  };
}

/** Pull the raw per-signal values back out of a stored components blob. */
export function parseComponents(json: string): {
  signals: Record<PositiveSignal, number | null>;
  recencyMultiplier: number;
} {
  const signals = emptySignals();
  let recencyMultiplier = 1;
  try {
    const parsed = JSON.parse(json);
    const list = Array.isArray(parsed) ? parsed : parsed?.components;
    if (Array.isArray(list)) {
      for (const c of list) {
        const key = c?.signal as PositiveSignal;
        if (!(POSITIVE_SIGNALS as readonly string[]).includes(key)) continue;
        const missing = c?.missing === true || c?.raw === null || c?.raw === undefined;
        signals[key] = missing ? null : clamp01(Number(c.raw));
      }
    }
    // Three cases must stay distinct:
    //   explicit 0  -> 0   (a score fully suppressed by recency: legitimate)
    //   absent/null -> 1   (unknown; JSON turns NaN into null, so they are
    //                       indistinguishable and both mean "no information")
    //   negative    -> 1   (impossible; treat as unknown rather than clamping
    //                       it to 0, which would invent a suppression)
    // The earlier `Number(x) > 0` guard collapsed the first case into the
    // second, inflating every fully-penalised score back to full strength and
    // corrupting the correlation this module exists to measure. Coercing with
    // Number() first is equally wrong, because Number(null) is 0.
    const raw = (parsed as any)?.recencyMultiplier;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      recencyMultiplier = clamp01(raw);
    }
  } catch {
    // A corrupt components blob yields an all-missing row rather than a throw:
    // one bad row must not take down a calibration over thousands.
  }
  return { signals, recencyMultiplier };
}

function outcomeFor(
  db: DB,
  row: { report_url: string; scored_at: string },
  kind: OutcomeKind,
  windowDays: number,
): number {
  const b = outcomeBounds(row.scored_at, windowDays);
  if (kind === 'leads') {
    const r = db.prepare(
      `SELECT COUNT(*) AS v FROM leads
        WHERE report_url = ? AND created_at > ? AND created_at <= ?`
    ).get(row.report_url, b.afterIso, b.untilIso) as any;
    return Number(r?.v ?? 0);
  }
  const r = db.prepare(
    `SELECT COALESCE(SUM(sessions), 0) AS v FROM url_performance
      WHERE url = ? AND source IN ('ga4','ga4-manual') AND metric_scope = 'url'
        AND metric_date > ? AND metric_date <= ?`
  ).get(row.report_url, b.afterDate, b.untilDate) as any;
  return Number(r?.v ?? 0);
}

/** Pair every mature historical score with what actually happened next. */
export function buildDataset(opts: BuildDatasetOptions): Dataset {
  const { db } = opts;
  const windowDays = opts.windowDays ?? 30;
  const outcome: OutcomeKind = opts.outcome ?? 'sessions';
  const now = opts.now ?? new Date();

  const where: string[] = [];
  const args: any[] = [];
  if (opts.weightsVersion) { where.push('weights_version = ?'); args.push(opts.weightsVersion); }
  if (opts.since) { where.push('scored_at >= ?'); args.push(opts.since); }

  const sql =
    `SELECT id, report_url, scored_at, score, components, weights_version
       FROM opportunity_scores
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY scored_at ASC` +
    (opts.limit ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '');

  const raw = db.prepare(sql).all(...args) as any[];

  const rows: DatasetRow[] = [];
  let immatureExcluded = 0;

  for (const r of raw) {
    const scoredAt = String(r.scored_at);
    const ms = Date.parse(scoredAt);
    if (Number.isNaN(ms)) continue;

    const windowClosesAt = ms + windowDays * 86_400_000;
    if (!opts.includeImmature && windowClosesAt > now.getTime()) { immatureExcluded++; continue; }

    const { signals, recencyMultiplier } = parseComponents(String(r.components ?? ''));
    rows.push({
      scoreId: Number(r.id),
      reportUrl: String(r.report_url),
      scoredAt,
      score: Number(r.score),
      weightsVersion: String(r.weights_version ?? ''),
      signals,
      recencyMultiplier,
      outcome: outcomeFor(db, { report_url: String(r.report_url), scored_at: scoredAt }, outcome, windowDays),
    });
  }

  return {
    rows,
    scores: rows.map(r => r.score),
    outcomes: rows.map(r => r.outcome),
    n: rows.length,
    outcome,
    windowDays,
    immatureExcluded,
  };
}

// ── Rank correlation ─────────────────────────────────────────────────────────

/**
 * Fractional ranks, ascending, with TIED VALUES SHARING THEIR AVERAGE RANK.
 * Tie handling is not a detail here: most outcome columns in this dataset are
 * mostly zeros, and breaking those ties arbitrarily would manufacture
 * correlation out of row order.
 */
export function rankValues(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].i] = avg;
    i = j + 1;
  }
  return ranks;
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  // No variance on either side means there is no ordering to agree with.
  if (da === 0 || db === 0) return 0;
  const r = num / Math.sqrt(da * db);
  return Number.isFinite(r) ? Math.min(1, Math.max(-1, r)) : 0;
}

export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  return pearson(rankValues(a), rankValues(b));
}

/**
 * Predicted score for one row under a candidate weight set.
 *
 * Mirrors computeScore: missing signals are dropped and the remaining weights
 * renormalised, then the row's recorded recency multiplier is applied.
 */
export function scoreRowWithWeights(row: DatasetRow, weights: ScoreWeights): number {
  const w = normaliseWeights(weights);
  let available = 0, weighted = 0;
  for (const key of POSITIVE_SIGNALS) {
    const raw = row.signals[key];
    if (raw === null || raw === undefined || Number.isNaN(raw)) continue;
    available += w[key];
    weighted += clamp01(raw) * w[key];
  }
  const base = available > 0 ? weighted / available : 0;
  return clamp01(base * row.recencyMultiplier);
}

/**
 * Spearman rank correlation between predicted score and actual outcome.
 *
 * With no `weights`, the scores AS RECORDED are evaluated — that is the honest
 * "how did the live system actually do" number. With `weights`, each row is
 * re-scored from its stored raw signals.
 */
export function evaluateWeights(dataset: Dataset, weights?: ScoreWeights): number {
  if (dataset.n < 2) return 0;
  const predicted = weights
    ? dataset.rows.map(r => scoreRowWithWeights(r, weights))
    : dataset.scores;
  return spearman(predicted, dataset.outcomes);
}

// ── Proposal ─────────────────────────────────────────────────────────────────

/** Fixed, ordered multiplier grid. Deterministic by construction. */
export const SEARCH_GRID = [0.5, 0.75, 1, 1.5, 2] as const;

export interface ProposeOptions extends Omit<BuildDatasetOptions, 'db'> {
  /** Pre-built dataset, to avoid re-querying. */
  dataset?: Dataset;
  baseline?: ScoreWeights;
  thresholds?: Thresholds;
  /** Coordinate-ascent passes over all seven weights. Default 2. */
  passes?: number;
  /** Persist a calibration_runs row (always with applied = 0). Default true. */
  persist?: boolean;
  notes?: string;
}

export interface CalibrationResult {
  status: 'ok' | 'insufficient_data';
  sampleSize: number;
  minimumSample: number;
  /** Spearman with the current weights. */
  before: number;
  /** Spearman with the proposed weights. */
  after: number;
  improvement: number;
  weightsBefore: ScoreWeights;
  weightsAfter: ScoreWeights;
  weightsVersion: string;
  outcome: OutcomeKind;
  windowDays: number;
  candidatesEvaluated: number;
  /** True when the improvement is inside the noise band for this sample size. */
  withinNoise: boolean;
  noiseBand: number;
  /** Always false. This module never applies anything. */
  applied: false;
  calibrationRunId?: number;
  immatureExcluded: number;
  message: string;
}

/**
 * Standard-error-ish noise band for a Spearman estimate at this sample size,
 * floored at 0.05. An "improvement" smaller than this is not a finding.
 *
 * Below n=3 the band is 2, not 1. Spearman lives in [-1, 1], so an improvement
 * can be as large as 2; a band of 1 would let a two-row dataset flip -1 to +1
 * and have that reported as a real finding. The band has to cover the whole
 * attainable range to actually suppress anything at that size.
 */
export function noiseBandFor(n: number): number {
  if (n < 3) return 2;
  return Math.max(0.05, 1 / Math.sqrt(n - 1));
}

/**
 * A floor on the sample size that NO configuration can lower.
 *
 * thresholds.calibrationMinimumSample is a policy knob and a caller may tune
 * it, but it was possible to set it to 2 and get back a confidently-worded
 * weight table derived from two observations — the noise band could not stop
 * that, because at n=2 Spearman only takes the values -1, 0 and +1 and any
 * "improvement" is an artefact of which of two rows happened to come first.
 * Below this floor there is no rank correlation to estimate, so the answer is
 * a refusal regardless of what the caller asked for.
 */
export const ABSOLUTE_MINIMUM_SAMPLE = 30;

/** The minimum actually enforced: the configured one, never below the floor. */
export function effectiveMinimumSample(thresholds: Thresholds): number {
  const configured = Number(thresholds.calibrationMinimumSample);
  if (!Number.isFinite(configured)) return ABSOLUTE_MINIMUM_SAMPLE;
  return Math.max(ABSOLUTE_MINIMUM_SAMPLE, Math.floor(configured));
}

function insufficient(dataset: Dataset, baseline: ScoreWeights, minimum: number): CalibrationResult {
  return {
    status: 'insufficient_data',
    sampleSize: dataset.n,
    minimumSample: minimum,
    before: 0, after: 0, improvement: 0,
    weightsBefore: baseline, weightsAfter: baseline,
    weightsVersion: WEIGHTS_VERSION,
    outcome: dataset.outcome,
    windowDays: dataset.windowDays,
    candidatesEvaluated: 0,
    withinNoise: true,
    noiseBand: noiseBandFor(dataset.n),
    applied: false,
    immatureExcluded: dataset.immatureExcluded,
    message:
      `Insufficient data: ${dataset.n} paired observation(s), minimum ${minimum}. ` +
      `No weight change is proposed — a recommendation from this little evidence ` +
      `would be noise wearing a number.`,
  };
}

/**
 * Bounded, deterministic coordinate ascent over the seven positive weights.
 *
 * Refuses to propose anything below thresholds.calibrationMinimumSample — or
 * below ABSOLUTE_MINIMUM_SAMPLE, whichever is larger, so a caller cannot
 * configure the refusal away. NEVER writes weights.ts — the proposal is persisted with applied = 0 for a
 * human to adopt.
 */
export function proposeWeights(db: DB, options: ProposeOptions = {}): CalibrationResult {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const baseline = normaliseWeights(options.baseline ?? loadWeights());
  const dataset = options.dataset ?? buildDataset({ db, ...options });
  const minimum = effectiveMinimumSample(thresholds);

  if (dataset.n < minimum) {
    return insufficient(dataset, baseline, minimum);
  }

  const before = evaluateWeights(dataset, baseline);

  let best: ScoreWeights = { ...baseline };
  let bestScore = before;
  let candidates = 0;

  const passes = Math.max(1, Math.floor(options.passes ?? 2));
  for (let pass = 0; pass < passes; pass++) {
    let improvedThisPass = false;
    for (const key of POSITIVE_SIGNALS) {
      for (const mult of SEARCH_GRID) {
        if (mult === 1) continue;
        const candidate = normaliseWeights({ ...best, [key]: best[key] * mult });
        candidates++;
        const r = evaluateWeights(dataset, candidate);
        // Strictly greater: a tie keeps the incumbent, so reruns cannot drift.
        if (r > bestScore) { bestScore = r; best = candidate; improvedThisPass = true; }
      }
    }
    if (!improvedThisPass) break;
  }

  const improvement = bestScore - before;
  const noiseBand = noiseBandFor(dataset.n);
  const withinNoise = improvement < noiseBand;

  const result: CalibrationResult = {
    status: 'ok',
    sampleSize: dataset.n,
    minimumSample: minimum,
    before, after: bestScore, improvement,
    weightsBefore: baseline, weightsAfter: best,
    weightsVersion: WEIGHTS_VERSION,
    outcome: dataset.outcome,
    windowDays: dataset.windowDays,
    candidatesEvaluated: candidates,
    withinNoise, noiseBand,
    applied: false,
    immatureExcluded: dataset.immatureExcluded,
    message: withinNoise
      ? `Proposed weights improve rank correlation by ${improvement.toFixed(3)}, which is ` +
        `inside the noise band (${noiseBand.toFixed(3)}) for n=${dataset.n}. Not a finding.`
      : `Proposed weights improve rank correlation from ${before.toFixed(3)} to ` +
        `${bestScore.toFixed(3)} (+${improvement.toFixed(3)}) on n=${dataset.n}.`,
  };

  if (options.persist !== false) {
    result.calibrationRunId = saveCalibrationRun(db, result, options.notes);
  }
  return result;
}

/** Persist a proposal. ALWAYS applied = 0 — adoption is a human commit. */
export function saveCalibrationRun(db: DB, result: CalibrationResult, notes?: string): number {
  const r = db.prepare(
    `INSERT INTO calibration_runs
       (run_at, window_start, window_end, sample_size, weights_before, weights_after,
        correlation, applied, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    nowIso(),
    isoDate(new Date(Date.now() - result.windowDays * 86_400_000)),
    isoDate(),
    result.sampleSize,
    JSON.stringify(result.weightsBefore),
    JSON.stringify(result.weightsAfter),
    JSON.stringify({
      metric: 'spearman', outcome: result.outcome,
      before: result.before, after: result.after,
      improvement: result.improvement, noiseBand: result.noiseBand,
      withinNoise: result.withinNoise,
    }),
    notes ?? result.message,
  );
  return Number(r.lastInsertRowid);
}

/**
 * Flag-gated entry point. With FEATURE_OPPORTUNITY_SCORING off (the default)
 * this is a no-op that touches nothing.
 */
export function runCalibration(db: DB, options: ProposeOptions = {}): CalibrationResult | null {
  if (!enabled('OPPORTUNITY_SCORING')) return null;
  return proposeWeights(db, options);
}

// ── Reporting ────────────────────────────────────────────────────────────────

function signed(n: number): string { return (n >= 0 ? '+' : '') + n.toFixed(3); }

/** Human-readable summary. Always states the sample size. */
export function formatCalibrationReport(result: CalibrationResult): string {
  const L: string[] = [];
  L.push('Weight calibration');
  L.push('='.repeat(60));
  L.push(`Outcome measured : ${result.outcome} in the ${result.windowDays} days after each score`);
  L.push(`Sample size      : ${result.sampleSize} paired observation(s) (minimum ${result.minimumSample})`);
  if (result.immatureExcluded > 0) {
    L.push(`Excluded         : ${result.immatureExcluded} score(s) whose outcome window has not closed`);
  }
  L.push(`Weights version  : ${result.weightsVersion}`);
  L.push('');

  if (result.status === 'insufficient_data') {
    L.push('RESULT: insufficient data — no proposal.');
    L.push(result.message);
    L.push('');
    L.push('Keep collecting. The weights stay as they are, and remain uncalibrated guesses.');
    return L.join('\n');
  }

  L.push(`Rank correlation (Spearman), current weights : ${result.before.toFixed(3)}`);
  L.push(`Rank correlation (Spearman), proposed        : ${result.after.toFixed(3)}`);
  L.push(`Improvement                                  : ${signed(result.improvement)} (noise band ${result.noiseBand.toFixed(3)})`);
  L.push(`Candidates evaluated                         : ${result.candidatesEvaluated}`);
  L.push('');

  if (result.withinNoise) {
    L.push('RESULT: no meaningful improvement.');
    L.push('The proposed weights are not distinguishable from the current ones at this');
    L.push('sample size. Read that as "we cannot tell yet", not as "the weights are right".');
  } else {
    L.push('RESULT: a better-ordering weight set exists.');
    L.push('');
    L.push('  signal                 current   proposed');
    for (const key of POSITIVE_SIGNALS) {
      const b = result.weightsBefore[key], a = result.weightsAfter[key];
      const arrow = Math.abs(a - b) < 0.005 ? ' ' : (a > b ? 'up' : 'down');
      L.push(`  ${key.padEnd(22)} ${b.toFixed(3)}     ${a.toFixed(3)} ${arrow}`);
    }
  }

  if (result.before < 0) {
    L.push('');
    L.push('WARNING: the CURRENT weights correlate NEGATIVELY with outcomes — the live');
    L.push('score is ordering reports worse than chance. Investigate before trusting it.');
  }

  L.push('');
  L.push(`Applied: NO (calibration_runs.applied = 0${result.calibrationRunId ? `, run #${result.calibrationRunId}` : ''}).`);
  L.push('To adopt: copy the proposed numbers into DEFAULT_WEIGHTS in weights.ts and bump');
  L.push('WEIGHTS_VERSION in the same commit, then set applied = 1 on this run by hand.');
  return L.join('\n');
}
