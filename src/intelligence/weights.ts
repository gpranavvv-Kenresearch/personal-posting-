/**
 * weights.ts — scoring weights and thresholds.
 *
 * ============================================================================
 * EVERY NUMBER IN THIS FILE IS UNCALIBRATED.
 * ============================================================================
 *
 * These are starting guesses, not findings. They were chosen to be reasonable
 * and legible, NOT because any evidence says they are right. Until
 * calibration.ts has run against real lead and traffic outcomes and a
 * calibration_runs row records an improvement, treat every score produced with
 * these weights as a hypothesis.
 *
 * This is a standing project decision: initial scoring weights and thresholds
 * are experimental values requiring calibration against actual performance and
 * lead outcomes.
 *
 * Consequences that are deliberately baked in:
 *   - Scores are computed in shadow mode by default and do NOT reorder posting
 *     (FEATURE_SCORING_INFLUENCES_ORDER is a separate flag).
 *   - Every score records its weights_version, so a score can always be traced
 *     to the weight set that produced it.
 *   - Changing a weight REQUIRES bumping WEIGHTS_VERSION, otherwise historical
 *     scores become uncomparable without anyone noticing.
 */

export const WEIGHTS_VERSION = 'v0-uncalibrated-2026-11';

export interface ScoreWeights {
  /** Search demand for the report's topic (impressions, volume). */
  searchDemand: number;
  /** Current ranking position — mid-page ranks have the most upside. */
  rankingOpportunity: number;
  /** Whether the report page itself is indexed and visible. */
  indexation: number;
  /** Historical traffic this report has earned. */
  historicalTraffic: number;
  /** Historical LEADS attributed to this report. The outcome that matters. */
  historicalLeads: number;
  /** Geographic fit between the report's region and where demand is. */
  geographic: number;
  /** How well the platform mix historically performs for this kind of report. */
  platformSuitability: number;
  /** Penalty for recency — avoid re-promoting the same thing repeatedly. */
  recencyPenalty: number;
}

/**
 * Weights sum to 1.0 across the positive signals; recencyPenalty is applied
 * separately as a multiplier, not summed.
 *
 * Rationale for the ordering (again: a hypothesis, not a finding):
 * leads outrank traffic because traffic without leads is vanity; search demand
 * outranks current ranking because demand is the ceiling and rank is the gap.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  searchDemand: 0.22,
  rankingOpportunity: 0.18,
  indexation: 0.10,
  historicalTraffic: 0.15,
  historicalLeads: 0.25,
  geographic: 0.05,
  platformSuitability: 0.05,
  recencyPenalty: 0.30,
};

export interface Thresholds {
  /** Rank bands. Mirrors the existing P1/P2/P3 logic in seoAgentNew.ts. */
  rankTopBand: number;
  rankMidBand: number;
  /** Days before a report may be re-promoted without a recency penalty. */
  recencyWindowDays: number;
  /** Below this score a report is not worth a slot (advisory only). */
  minimumViableScore: number;
  /** A platform producing fewer than this many sessions per post is suspect. */
  platformSessionsPerPostFloor: number;
  /** Minimum posts before platform stats are considered meaningful at all. */
  platformMinimumSample: number;
  /** Minimum rows before calibration is allowed to change anything. */
  calibrationMinimumSample: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  rankTopBand: 30,
  rankMidBand: 69,
  recencyWindowDays: 30,
  minimumViableScore: 0.15,
  platformSessionsPerPostFloor: 0.5,
  platformMinimumSample: 20,
  calibrationMinimumSample: 100,
};

/**
 * Interlinking limits.
 *
 * These are CONFIGURABLE SAFETY CONTROLS, not Google policy thresholds. No
 * search engine publishes a number that makes N links safe and N+1 unsafe.
 * They exist so that an automated system cannot do something drastic at scale
 * before a human notices — that is the entire justification.
 */
export interface InterlinkLimits {
  maxNewLinksPerSourcePage: number;
  maxLinksAddedPerRun: number;
  maxLinksPerDestinationPerWeek: number;
  minRelevanceToPropose: number;
  minParagraphWords: number;
  /** Never propose a link on a page edited within this many hours. */
  cooldownHours: number;
}

export const DEFAULT_INTERLINK_LIMITS: InterlinkLimits = {
  maxNewLinksPerSourcePage: 3,
  maxLinksAddedPerRun: 10,
  maxLinksPerDestinationPerWeek: 5,
  minRelevanceToPropose: 0.55,
  minParagraphWords: 25,
  cooldownHours: 24,
};

/** Read a weight override from env, for calibration experiments. */
export function loadWeights(env: NodeJS.ProcessEnv = process.env): ScoreWeights {
  const raw = (env.SCORING_WEIGHTS_JSON ?? '').trim();
  if (!raw) return { ...DEFAULT_WEIGHTS };
  try {
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_WEIGHTS, ...parsed };
  } catch {
    console.warn('[weights] SCORING_WEIGHTS_JSON is not valid JSON — using defaults.');
    return { ...DEFAULT_WEIGHTS };
  }
}

/**
 * Bounds for every interlink limit: [minimum, maximum, integerOnly].
 *
 * A limit that is not a usable number is NOT a licence to do the thing without
 * a limit. An override of `"none"`, `null`, `NaN` or `-1` used to flow straight
 * into `Math.max(0, limit)` and produce NaN, and every `count >= NaN` test is
 * false — which silently removed the cap entirely. Garbage in now means the
 * DEFAULT, loudly, never "unlimited".
 */
const INTERLINK_LIMIT_BOUNDS: Record<keyof InterlinkLimits, [number, number, boolean]> = {
  maxNewLinksPerSourcePage:     [0, 100,   true],
  maxLinksAddedPerRun:          [0, 1000,  true],
  maxLinksPerDestinationPerWeek:[0, 1000,  true],
  minRelevanceToPropose:        [0, 1,     false],
  minParagraphWords:            [0, 10000, true],
  cooldownHours:                [0, 8760,  false],
};

/**
 * Coerce one override into a usable limit, or fall back to the default.
 * Clamping is deliberate: an out-of-range override is a typo, and the safe
 * reading of a typo is the nearest value that still bounds the blast radius.
 */
export function sanitiseInterlinkLimits(
  raw: unknown,
  warn: (msg: string) => void = (m) => console.warn(m),
): InterlinkLimits {
  const out: InterlinkLimits = { ...DEFAULT_INTERLINK_LIMITS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  for (const key of Object.keys(INTERLINK_LIMIT_BOUNDS) as Array<keyof InterlinkLimits>) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = (raw as Record<string, unknown>)[key];
    const [min, max, intOnly] = INTERLINK_LIMIT_BOUNDS[key];

    // Only a real number counts. A numeric STRING is still a configuration
    // error, and guessing what "3" meant is how a cap quietly disappears.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // JSON.stringify(NaN) is "null", which would make the warning lie about
      // what was actually configured.
      const shown = typeof value === 'number' ? String(value) : JSON.stringify(value);
      warn(`[weights] INTERLINK_LIMITS_JSON.${key} is not a finite number (${shown}) — using the default ${DEFAULT_INTERLINK_LIMITS[key]}.`);
      continue;
    }

    let v = intOnly ? Math.floor(value) : value;
    if (v < min || v > max) {
      const clamped = Math.min(max, Math.max(min, v));
      warn(`[weights] INTERLINK_LIMITS_JSON.${key}=${value} is outside [${min}, ${max}] — clamped to ${clamped}.`);
      v = clamped;
    }
    out[key] = v;
  }
  return out;
}

export function loadInterlinkLimits(env: NodeJS.ProcessEnv = process.env): InterlinkLimits {
  const raw = (env.INTERLINK_LIMITS_JSON ?? '').trim();
  if (!raw) return { ...DEFAULT_INTERLINK_LIMITS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[weights] INTERLINK_LIMITS_JSON is not valid JSON — using defaults.');
    return { ...DEFAULT_INTERLINK_LIMITS };
  }
  return sanitiseInterlinkLimits(parsed);
}

/** Positive weights should sum to ~1.0. Used by tests and by calibration. */
export function positiveWeightSum(w: ScoreWeights): number {
  return w.searchDemand + w.rankingOpportunity + w.indexation + w.historicalTraffic
    + w.historicalLeads + w.geographic + w.platformSuitability;
}

/** Scale positive weights so they sum to exactly 1.0, preserving ratios. */
export function normaliseWeights(w: ScoreWeights): ScoreWeights {
  const sum = positiveWeightSum(w);
  if (sum === 0) return { ...DEFAULT_WEIGHTS };
  const k = 1 / sum;
  return {
    searchDemand: w.searchDemand * k,
    rankingOpportunity: w.rankingOpportunity * k,
    indexation: w.indexation * k,
    historicalTraffic: w.historicalTraffic * k,
    historicalLeads: w.historicalLeads * k,
    geographic: w.geographic * k,
    platformSuitability: w.platformSuitability * k,
    recencyPenalty: w.recencyPenalty,
  };
}
