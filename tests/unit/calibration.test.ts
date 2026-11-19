/**
 * Weight calibration. Pure maths plus a temp-file database — no network, no
 * live API, no spreadsheet. Every dataset here is synthetic and the right
 * answer is known in advance.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/intelligence/db.js';
import {
  POSITIVE_SIGNALS, SEARCH_GRID,
  outcomeBounds, parseComponents, buildDataset,
  rankValues, pearson, spearman,
  scoreRowWithWeights, evaluateWeights, proposeWeights, noiseBandFor,
  runCalibration, formatCalibrationReport,
  ABSOLUTE_MINIMUM_SAMPLE, effectiveMinimumSample,
  type Dataset, type DatasetRow, type PositiveSignal,
} from '../../src/intelligence/calibration.js';
import { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, type ScoreWeights } from '../../src/intelligence/weights.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

let dir: string;
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-'));
  db = openDb(path.join(dir, 'intel.db'));
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const ZERO_WEIGHTS: ScoreWeights = {
  searchDemand: 0, rankingOpportunity: 0, indexation: 0,
  historicalTraffic: 0, historicalLeads: 0, geographic: 0,
  platformSuitability: 0, recencyPenalty: 0.3,
};

function signals(partial: Partial<Record<PositiveSignal, number | null>>): Record<PositiveSignal, number | null> {
  const out = {} as Record<PositiveSignal, number | null>;
  for (const k of POSITIVE_SIGNALS) out[k] = partial[k] ?? null;
  return out;
}

function row(i: number, sig: Partial<Record<PositiveSignal, number | null>>, outcome: number, score?: number): DatasetRow {
  return {
    scoreId: i,
    reportUrl: `https://kenresearch.com/r-${i}`,
    scoredAt: `2026-01-01T00:00:00.000Z`,
    score: score ?? 0,
    weightsVersion: 'test',
    signals: signals(sig),
    recencyMultiplier: 1,
    outcome,
  };
}

function dataset(rows: DatasetRow[], outcome: 'sessions' | 'leads' = 'sessions'): Dataset {
  return {
    rows,
    scores: rows.map(r => r.score),
    outcomes: rows.map(r => r.outcome),
    n: rows.length,
    outcome,
    windowDays: 30,
    immatureExcluded: 0,
  };
}

/** Deterministic pseudo-random in [0,1). A seeded LCG, never Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function insertScore(reportUrl: string, scoredAt: string, score: number, sig: Partial<Record<PositiveSignal, number | null>>, recency = 1): void {
  const components = POSITIVE_SIGNALS.map(k => {
    const raw = sig[k] ?? null;
    return { signal: k, raw, weight: 0.1, contribution: 0, missing: raw === null };
  });
  db.prepare(
    `INSERT INTO opportunity_scores (report_url, scored_at, score, components, weights_version, shadow)
     VALUES (?, ?, ?, ?, 'test', 1)`
  ).run(reportUrl, scoredAt, score, JSON.stringify({ components, coverage: 1, recencyMultiplier: recency }));
}

function insertSessions(url: string, date: string, sessions: number): void {
  db.prepare(
    `INSERT INTO url_performance (url, source, metric_date, metric_scope, dimension_value, sessions, collected_at)
     VALUES (?, 'ga4', ?, 'url', NULL, ?, '2026-01-01T00:00:00.000Z')`
  ).run(url, date, sessions);
}

function insertLead(id: string, reportUrl: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO leads (external_id, source_system, created_at, report_url, collected_at)
     VALUES (?, 'pipedrive', ?, ?, '2026-01-01T00:00:00.000Z')`
  ).run(id, createdAt, reportUrl);
}

// ── ranking ──────────────────────────────────────────────────────────────────

describe('rankValues', () => {
  test('ranks ascending from 1', () => {
    assert.deepEqual(rankValues([10, 30, 20]), [1, 3, 2]);
  });

  test('tied values share their AVERAGE rank', () => {
    // two values tied at the bottom -> ranks 1 and 2 average to 1.5
    assert.deepEqual(rankValues([5, 5, 9]), [1.5, 1.5, 3]);
    // three-way tie in the middle -> ranks 2,3,4 average to 3
    assert.deepEqual(rankValues([1, 7, 7, 7, 9]), [1, 3, 3, 3, 5]);
  });

  test('all values tied gives every row the same mid rank', () => {
    assert.deepEqual(rankValues([4, 4, 4, 4]), [2.5, 2.5, 2.5, 2.5]);
  });

  test('average ranks always sum to n(n+1)/2, ties or not', () => {
    const vals = [0, 0, 0, 3, 3, 7, 9, 9, 9, 9];
    const sum = rankValues(vals).reduce((a, b) => a + b, 0);
    assert.equal(sum, (vals.length * (vals.length + 1)) / 2);
  });

  test('empty and single-element inputs do not throw', () => {
    assert.deepEqual(rankValues([]), []);
    assert.deepEqual(rankValues([42]), [1]);
  });
});

describe('correlation', () => {
  test('spearman of a perfectly ordered pair is 1', () => {
    assert.equal(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1);
  });

  test('spearman is RANK based, so a non-linear monotone pair still scores 1', () => {
    // Pearson would be well below 1 here; Spearman must be exactly 1.
    const x = [1, 2, 3, 4, 5];
    const y = [1, 4, 9, 1000, 1_000_000];
    assert.equal(spearman(x, y), 1);
    assert.ok(pearson(x, y) < 0.95, 'pearson should disagree — that is the point');
  });

  test('a perfectly inverted pair is -1', () => {
    assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  });

  test('ties are handled without NaN and without inventing order', () => {
    assert.equal(spearman([1, 1, 2, 2], [5, 5, 9, 9]), 1);
    assert.equal(spearman([1, 1, 2, 2], [9, 9, 5, 5]), -1);
    const partial = spearman([1, 1, 2, 2], [1, 2, 3, 4]);
    assert.ok(Number.isFinite(partial) && partial > 0 && partial < 1);
  });

  test('zero variance on either side yields 0, never NaN', () => {
    assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), 0);
    assert.equal(spearman([1, 2, 3, 4], [7, 7, 7, 7]), 0);
    assert.equal(spearman([2, 2], [2, 2]), 0);
  });

  test('mismatched lengths or n<2 return 0 rather than guessing', () => {
    assert.equal(spearman([1, 2, 3], [1, 2]), 0);
    assert.equal(spearman([1], [1]), 0);
    assert.equal(spearman([], []), 0);
  });
});

// ── evaluateWeights on datasets with known answers ──────────────────────────

describe('evaluateWeights', () => {
  test('a signal that perfectly predicts the outcome scores ~1', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(i, { historicalLeads: i / 49 }, i * 3));
    const w: ScoreWeights = { ...ZERO_WEIGHTS, historicalLeads: 1 };
    assert.equal(evaluateWeights(dataset(rows), w), 1);
  });

  test('a deliberately inverted signal scores ~-1', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row(i, { historicalLeads: 1 - i / 49 }, i * 3));
    const w: ScoreWeights = { ...ZERO_WEIGHTS, historicalLeads: 1 };
    assert.equal(evaluateWeights(dataset(rows), w), -1);
  });

  test('a pure-noise signal scores ~0', () => {
    const rnd = lcg(20261116);
    const rows = Array.from({ length: 500 }, (_, i) =>
      row(i, { historicalLeads: rnd() }, i));
    const w: ScoreWeights = { ...ZERO_WEIGHTS, historicalLeads: 1 };
    const r = evaluateWeights(dataset(rows), w);
    assert.ok(Math.abs(r) < 0.12, `noise correlated at ${r}`);
  });

  test('with no weights argument it grades the scores AS RECORDED', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, {}, i, i / 20));
    assert.equal(evaluateWeights(dataset(rows)), 1);
    const flipped = Array.from({ length: 20 }, (_, i) => row(i, {}, i, 1 - i / 20));
    assert.equal(evaluateWeights(dataset(flipped)), -1);
  });

  test('a dataset of fewer than two rows is 0, not an error', () => {
    assert.equal(evaluateWeights(dataset([])), 0);
    assert.equal(evaluateWeights(dataset([row(0, { indexation: 1 }, 5)])), 0);
  });
});

describe('scoreRowWithWeights', () => {
  test('missing signals are dropped and the rest renormalised', () => {
    // Only indexation is known, so whatever its weight, the score is its value.
    const r = row(1, { indexation: 0.4 }, 0);
    assert.ok(Math.abs(scoreRowWithWeights(r, DEFAULT_WEIGHTS) - 0.4) < 1e-9);
  });

  test('an all-missing row scores 0 rather than throwing', () => {
    assert.equal(scoreRowWithWeights(row(1, {}, 0), DEFAULT_WEIGHTS), 0);
  });

  test('the recorded recency multiplier is applied and held fixed', () => {
    const r = { ...row(1, { indexation: 1 }, 0), recencyMultiplier: 0.5 };
    assert.ok(Math.abs(scoreRowWithWeights(r, DEFAULT_WEIGHTS) - 0.5) < 1e-9);
  });

  test('weights genuinely change the ordering between two rows', () => {
    const a = row(1, { searchDemand: 0.9, historicalLeads: 0.1 }, 0);
    const b = row(2, { searchDemand: 0.1, historicalLeads: 0.9 }, 0);
    const demandHeavy: ScoreWeights = { ...ZERO_WEIGHTS, searchDemand: 1, historicalLeads: 0.01 };
    const leadHeavy: ScoreWeights = { ...ZERO_WEIGHTS, searchDemand: 0.01, historicalLeads: 1 };
    assert.ok(scoreRowWithWeights(a, demandHeavy) > scoreRowWithWeights(b, demandHeavy));
    assert.ok(scoreRowWithWeights(b, leadHeavy) > scoreRowWithWeights(a, leadHeavy));
  });
});

// ── the lookahead guard ──────────────────────────────────────────────────────

describe('outcomeBounds', () => {
  test('the date boundary is the score day itself, compared strictly', () => {
    const b = outcomeBounds('2026-03-10T14:30:00.000Z', 30);
    assert.equal(b.afterDate, '2026-03-10');
    assert.equal(b.untilDate, '2026-04-09');
    assert.equal(b.afterIso, '2026-03-10T14:30:00.000Z');
  });

  test('the window end moves with windowDays', () => {
    assert.equal(outcomeBounds('2026-03-10T00:00:00.000Z', 7).untilDate, '2026-03-17');
    assert.equal(outcomeBounds('2026-03-10T00:00:00.000Z', 1).untilDate, '2026-03-11');
  });
});

describe('buildDataset lookahead guard', () => {
  const URL = 'https://kenresearch.com/report-a';
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  test('sessions BEFORE the score are never counted, sessions after are', () => {
    insertScore(URL, '2026-03-10T12:00:00.000Z', 0.5, { historicalLeads: 0.5 });
    insertSessions(URL, '2026-03-01', 1000);  // before  -> excluded
    insertSessions(URL, '2026-03-09', 500);   // before  -> excluded
    insertSessions(URL, '2026-03-10', 250);   // same day as the score -> excluded
    insertSessions(URL, '2026-03-11', 7);     // after   -> counted
    insertSessions(URL, '2026-04-08', 3);     // after, in window -> counted
    insertSessions(URL, '2026-04-20', 999);   // after window end -> excluded

    const d = buildDataset({ db, windowDays: 30, outcome: 'sessions', now: NOW });
    assert.equal(d.n, 1);
    assert.equal(d.outcomes[0], 10, 'only the two post-score in-window days count');
  });

  test('leads before the score timestamp are excluded to the hour', () => {
    insertScore(URL, '2026-03-10T12:00:00.000Z', 0.5, { historicalLeads: 0.5 });
    insertLead('l1', URL, '2026-03-10T11:59:59.000Z'); // one second early -> excluded
    insertLead('l2', URL, '2026-03-10T12:00:01.000Z'); // one second late  -> counted
    insertLead('l3', URL, '2026-03-20T00:00:00.000Z'); // counted
    insertLead('l4', URL, '2026-05-01T00:00:00.000Z'); // past the window  -> excluded

    const d = buildDataset({ db, windowDays: 30, outcome: 'leads', now: NOW });
    assert.equal(d.n, 1);
    assert.equal(d.outcomes[0], 2);
  });

  test('another report\'s outcomes are not borrowed', () => {
    insertScore(URL, '2026-03-10T12:00:00.000Z', 0.5, { historicalLeads: 0.5 });
    insertSessions('https://kenresearch.com/report-b', '2026-03-15', 5000);
    const d = buildDataset({ db, windowDays: 30, outcome: 'sessions', now: NOW });
    assert.equal(d.outcomes[0], 0);
  });

  test('scores whose window has not closed yet are excluded and counted', () => {
    insertScore(URL, '2026-03-10T12:00:00.000Z', 0.5, { historicalLeads: 0.5 }); // mature
    insertScore(URL, '2026-05-25T12:00:00.000Z', 0.6, { historicalLeads: 0.6 }); // immature at NOW
    const d = buildDataset({ db, windowDays: 30, outcome: 'sessions', now: NOW });
    assert.equal(d.n, 1);
    assert.equal(d.immatureExcluded, 1);
  });

  test('includeImmature keeps them, for anyone who explicitly asks', () => {
    insertScore(URL, '2026-05-25T12:00:00.000Z', 0.6, { historicalLeads: 0.6 });
    const d = buildDataset({ db, windowDays: 30, outcome: 'sessions', now: NOW, includeImmature: true });
    assert.equal(d.n, 1);
    assert.equal(d.immatureExcluded, 0);
  });

  test('scores, outcomes and rows stay aligned index for index', () => {
    for (let i = 0; i < 5; i++) {
      const u = `https://kenresearch.com/r${i}`;
      insertScore(u, '2026-03-10T12:00:00.000Z', i / 10, { historicalLeads: i / 10 });
      insertSessions(u, '2026-03-15', i * 11);
    }
    const d = buildDataset({ db, windowDays: 30, now: NOW });
    assert.equal(d.n, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(d.scores[i], d.rows[i].score);
      assert.equal(d.outcomes[i], d.rows[i].outcome);
      assert.equal(d.outcomes[i], Number(d.rows[i].reportUrl.slice(-1)) * 11);
    }
  });

  test('filters by weights_version and since', () => {
    insertScore(URL, '2026-02-01T00:00:00.000Z', 0.1, {});
    insertScore(URL, '2026-03-10T00:00:00.000Z', 0.2, {});
    assert.equal(buildDataset({ db, now: NOW, since: '2026-03-01T00:00:00.000Z' }).n, 1);
    assert.equal(buildDataset({ db, now: NOW, weightsVersion: 'test' }).n, 2);
    assert.equal(buildDataset({ db, now: NOW, weightsVersion: 'nope' }).n, 0);
  });

  test('empty store yields an empty dataset, not a throw', () => {
    const d = buildDataset({ db, now: NOW });
    assert.equal(d.n, 0);
    assert.deepEqual(d.scores, []);
  });
});

describe('parseComponents', () => {
  test('round-trips raw signals and the recency multiplier', () => {
    insertScore('https://kenresearch.com/x', '2026-03-10T00:00:00.000Z', 0.4,
      { searchDemand: 0.8, indexation: 0.25 }, 0.7);
    const stored = db.prepare('SELECT components FROM opportunity_scores').get() as any;
    const p = parseComponents(String(stored.components));
    assert.equal(p.signals.searchDemand, 0.8);
    assert.equal(p.signals.indexation, 0.25);
    assert.equal(p.signals.historicalLeads, null, 'missing must stay null, not become 0');
    assert.equal(p.recencyMultiplier, 0.7);
  });

  test('a corrupt blob degrades to all-missing instead of throwing', () => {
    const p = parseComponents('{not json');
    for (const k of POSITIVE_SIGNALS) assert.equal(p.signals[k], null);
    assert.equal(p.recencyMultiplier, 1);
  });
});

// ── proposal ─────────────────────────────────────────────────────────────────

/**
 * 120 rows where historicalLeads perfectly predicts the outcome and
 * searchDemand is pure noise. The baseline puts almost all its weight on the
 * noise, so the right answer is known in advance: move weight onto
 * historicalLeads, and correlation should climb to ~1.
 */
function misweightedDataset(n = 120): Dataset {
  const rnd = lcg(31337);
  const rows = Array.from({ length: n }, (_, i) =>
    row(i, { historicalLeads: i / (n - 1), searchDemand: rnd() }, i * 2));
  return dataset(rows);
}

const BAD_BASELINE: ScoreWeights = {
  ...ZERO_WEIGHTS, searchDemand: 0.9, historicalLeads: 0.02,
};

/**
 * The same shape, but the dominant signal points the WRONG WAY: the baseline
 * orders reality backwards, so `before` is -1 and the report must warn.
 */
function invertedDataset(n = 120): Dataset {
  const rnd = lcg(4242);
  const rows = Array.from({ length: n }, (_, i) =>
    row(i, { historicalLeads: 1 - i / (n - 1), geographic: rnd() }, i * 2));
  return dataset(rows);
}

const INVERTED_BASELINE: ScoreWeights = {
  ...ZERO_WEIGHTS, historicalLeads: 0.9, geographic: 0.02,
};

describe('proposeWeights safety', () => {
  test('refuses below the minimum sample and says so plainly', () => {
    const d = dataset(Array.from({ length: 10 }, (_, i) => row(i, { historicalLeads: i / 9 }, i)));
    const r = proposeWeights(db, { dataset: d });
    assert.equal(r.status, 'insufficient_data');
    assert.equal(r.sampleSize, 10);
    assert.equal(r.minimumSample, DEFAULT_THRESHOLDS.calibrationMinimumSample);
    assert.equal(r.minimumSample, 100);
    assert.match(r.message, /Insufficient data/);
    assert.deepEqual(r.weightsAfter, r.weightsBefore, 'no weight may move on thin evidence');
  });

  test('a refusal writes no calibration_runs row at all', () => {
    const d = dataset(Array.from({ length: 99 }, (_, i) => row(i, { historicalLeads: i / 98 }, i)));
    const r = proposeWeights(db, { dataset: d });
    assert.equal(r.status, 'insufficient_data');
    const c = db.prepare('SELECT COUNT(*) AS c FROM calibration_runs').get() as any;
    assert.equal(Number(c.c), 0);
  });

  test('exactly at the minimum it proceeds', () => {
    const d = misweightedDataset(100);
    const r = proposeWeights(db, { dataset: d, baseline: BAD_BASELINE, persist: false });
    assert.equal(r.status, 'ok');
    assert.equal(r.sampleSize, 100);
  });

  test('NEVER applies: persisted with applied = 0, and the result says so', () => {
    const r = proposeWeights(db, { dataset: misweightedDataset(), baseline: BAD_BASELINE, passes: 6 });
    assert.equal(r.applied, false);
    const saved = db.prepare('SELECT applied, sample_size, weights_after FROM calibration_runs').get() as any;
    assert.equal(Number(saved.applied), 0);
    assert.equal(Number(saved.sample_size), 120);
    assert.ok(JSON.parse(String(saved.weights_after)).historicalLeads > 0);
  });

  test('a caller cannot configure the refusal away', () => {
    // Two rows, engineered so the baseline orders them backwards and one grid
    // step flips Spearman from -1 to +1. Before the floor existed this came
    // back as status "ok" with improvement 2 and a full weight table — a
    // confident recommendation from two observations.
    const tiny = dataset([
      row(0, { searchDemand: 1, historicalLeads: 0 }, 1),
      row(1, { searchDemand: 0, historicalLeads: 1 }, 100),
    ]);
    const nearlyTied: ScoreWeights = {
      ...DEFAULT_WEIGHTS,
      searchDemand: 0.30, rankingOpportunity: 0.10, indexation: 0.10,
      historicalTraffic: 0.10, historicalLeads: 0.25, geographic: 0.10,
      platformSuitability: 0.05,
    };
    const r = proposeWeights(db, {
      dataset: tiny,
      thresholds: { ...DEFAULT_THRESHOLDS, calibrationMinimumSample: 2 },
      baseline: nearlyTied, passes: 6, persist: false,
    });
    assert.equal(r.status, 'insufficient_data');
    assert.equal(r.minimumSample, ABSOLUTE_MINIMUM_SAMPLE);
    assert.equal(r.candidatesEvaluated, 0);
    assert.deepEqual(r.weightsAfter, r.weightsBefore);
  });

  test('the enforced minimum is the configured one, never below the floor', () => {
    assert.equal(effectiveMinimumSample({ ...DEFAULT_THRESHOLDS, calibrationMinimumSample: 0 }), ABSOLUTE_MINIMUM_SAMPLE);
    assert.equal(effectiveMinimumSample({ ...DEFAULT_THRESHOLDS, calibrationMinimumSample: 5 }), ABSOLUTE_MINIMUM_SAMPLE);
    assert.equal(effectiveMinimumSample({ ...DEFAULT_THRESHOLDS, calibrationMinimumSample: 500 }), 500);
    assert.equal(effectiveMinimumSample({ ...DEFAULT_THRESHOLDS, calibrationMinimumSample: NaN }), ABSOLUTE_MINIMUM_SAMPLE);
    assert.ok(ABSOLUTE_MINIMUM_SAMPLE <= DEFAULT_THRESHOLDS.calibrationMinimumSample);
  });

  test('does not mutate DEFAULT_WEIGHTS', () => {
    const snapshot = JSON.stringify(DEFAULT_WEIGHTS);
    proposeWeights(db, { dataset: misweightedDataset(), baseline: BAD_BASELINE, passes: 6, persist: false });
    assert.equal(JSON.stringify(DEFAULT_WEIGHTS), snapshot);
  });
});

describe('proposeWeights search', () => {
  test('finds the signal that actually predicts the outcome', () => {
    const r = proposeWeights(db, {
      dataset: misweightedDataset(), baseline: BAD_BASELINE, passes: 6, persist: false,
    });
    assert.equal(r.status, 'ok');
    assert.ok(Math.abs(r.before) < 0.3, `a noise-dominated baseline should barely correlate, got ${r.before}`);
    assert.ok(r.after > 0.9, `the fixed signal should order almost perfectly, got ${r.after}`);
    assert.ok(r.improvement > r.noiseBand);
    assert.equal(r.withinNoise, false);
    assert.ok(
      r.weightsAfter.historicalLeads > r.weightsAfter.searchDemand,
      'weight should have swung onto the predictive signal',
    );
  });

  test('is deterministic — two identical runs agree exactly', () => {
    const opts = { baseline: BAD_BASELINE, passes: 6, persist: false } as const;
    const a = proposeWeights(db, { dataset: misweightedDataset(), ...opts });
    const b = proposeWeights(db, { dataset: misweightedDataset(), ...opts });
    assert.deepEqual(a.weightsAfter, b.weightsAfter);
    assert.equal(a.after, b.after);
    assert.equal(a.candidatesEvaluated, b.candidatesEvaluated);
  });

  test('the search is bounded by passes and the fixed grid', () => {
    const perPass = POSITIVE_SIGNALS.length * (SEARCH_GRID.length - 1);
    const r = proposeWeights(db, {
      dataset: misweightedDataset(), baseline: BAD_BASELINE, passes: 3, persist: false,
    });
    assert.ok(r.candidatesEvaluated > 0);
    assert.ok(r.candidatesEvaluated <= perPass * 3);
  });

  test('never makes things worse — after is always >= before', () => {
    const already = dataset(Array.from({ length: 150 }, (_, i) =>
      row(i, { historicalLeads: i / 149 }, i)));
    const good: ScoreWeights = { ...ZERO_WEIGHTS, historicalLeads: 1 };
    const r = proposeWeights(db, { dataset: already, baseline: good, persist: false });
    assert.ok(r.after >= r.before);
    assert.ok(r.improvement >= 0);
  });

  test('an unimprovable dataset is reported as noise, not as a win', () => {
    const rnd = lcg(7);
    const noise = dataset(Array.from({ length: 300 }, (_, i) =>
      row(i, { historicalLeads: rnd(), searchDemand: rnd() }, Math.floor(rnd() * 100))));
    const r = proposeWeights(db, { dataset: noise, persist: false });
    assert.equal(r.status, 'ok');
    assert.ok(Math.abs(r.before) < 0.2);
    const text = formatCalibrationReport(r);
    if (r.withinNoise) assert.match(text, /no meaningful improvement/);
  });

  test('outcome kind and window are carried through to the result', () => {
    const d = { ...misweightedDataset(), outcome: 'leads' as const, windowDays: 14 };
    const r = proposeWeights(db, { dataset: d, baseline: BAD_BASELINE, persist: false });
    assert.equal(r.outcome, 'leads');
    assert.equal(r.windowDays, 14);
  });
});

describe('noiseBandFor', () => {
  test('shrinks as the sample grows but never below 0.05', () => {
    assert.ok(noiseBandFor(10) > noiseBandFor(100));
    assert.ok(noiseBandFor(100) > noiseBandFor(1000));
    assert.equal(noiseBandFor(1_000_000), 0.05);
    // Spearman spans [-1, 1], so an improvement can be as large as 2. Below
    // n=3 the band has to cover that whole range or it suppresses nothing.
    assert.equal(noiseBandFor(2), 2);
  });
});

describe('runCalibration flag gate', () => {
  test('is a no-op with the feature flag off (the default)', () => {
    delete process.env.FEATURE_INTELLIGENCE;
    delete process.env.FEATURE_OPPORTUNITY_SCORING;
    assert.equal(runCalibration(db), null);
    const c = db.prepare('SELECT COUNT(*) AS c FROM calibration_runs').get() as any;
    assert.equal(Number(c.c), 0);
  });

  test('runs when both the master switch and its own flag are on', () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_OPPORTUNITY_SCORING = '1';
    try {
      const r = runCalibration(db, { dataset: misweightedDataset(), baseline: BAD_BASELINE, persist: false });
      assert.ok(r);
      assert.equal(r!.status, 'ok');
    } finally {
      delete process.env.FEATURE_INTELLIGENCE;
      delete process.env.FEATURE_OPPORTUNITY_SCORING;
    }
  });
});

// ── reporting ────────────────────────────────────────────────────────────────

describe('formatCalibrationReport', () => {
  test('always shows the sample size', () => {
    const thin = proposeWeights(db, { dataset: dataset([row(0, {}, 1), row(1, {}, 2)]) });
    assert.match(formatCalibrationReport(thin), /Sample size\s+: 2 paired observation/);

    const full = proposeWeights(db, { dataset: misweightedDataset(), baseline: BAD_BASELINE, passes: 6, persist: false });
    assert.match(formatCalibrationReport(full), /Sample size\s+: 120 paired observation/);
  });

  test('an insufficient-data report proposes nothing and says to keep collecting', () => {
    const r = proposeWeights(db, { dataset: dataset([row(0, {}, 1), row(1, {}, 2)]) });
    const text = formatCalibrationReport(r);
    assert.match(text, /insufficient data/i);
    assert.match(text, /Keep collecting/);
    assert.doesNotMatch(text, /better-ordering weight set/);
  });

  test('a real improvement lists the per-signal before and after', () => {
    const r = proposeWeights(db, { dataset: misweightedDataset(), baseline: BAD_BASELINE, passes: 6, persist: false });
    const text = formatCalibrationReport(r);
    assert.match(text, /better-ordering weight set/);
    for (const k of POSITIVE_SIGNALS) assert.ok(text.includes(k), `missing ${k}`);
    assert.match(text, /Applied: NO/);
    assert.match(text, /bump/i);
  });

  test('is honest when the improvement is inside the noise band', () => {
    const r = proposeWeights(db, { dataset: misweightedDataset(), baseline: BAD_BASELINE, passes: 6, persist: false });
    const pretend = { ...r, improvement: 0.01, after: r.before + 0.01, withinNoise: true };
    const text = formatCalibrationReport(pretend);
    assert.match(text, /no meaningful improvement/);
    assert.match(text, /cannot tell yet/);
  });

  test('warns loudly when the live weights order worse than chance', () => {
    const r = proposeWeights(db, { dataset: invertedDataset(), baseline: INVERTED_BASELINE, passes: 6, persist: false });
    assert.ok(r.before < -0.99, `expected a near-perfectly backwards baseline, got ${r.before}`);
    assert.ok(r.after > r.before);
    assert.match(formatCalibrationReport(r), /correlate NEGATIVELY/);
  });

  test('mentions excluded immature scores when there are any', () => {
    const r = proposeWeights(db, {
      dataset: { ...misweightedDataset(), immatureExcluded: 4 },
      baseline: BAD_BASELINE, passes: 6, persist: false,
    });
    assert.match(formatCalibrationReport(r), /Excluded\s+: 4 score/);
  });
});

// ── end to end, from the store ───────────────────────────────────────────────

describe('end to end against a temp database', () => {
  test('scores in, dataset out, proposal persisted unapplied', () => {
    const NOW = new Date('2026-06-01T00:00:00.000Z');
    const rnd = lcg(5150);
    for (let i = 0; i < 120; i++) {
      const u = `https://kenresearch.com/report-${i}`;
      const lead = i / 119;
      insertScore(u, '2026-03-10T12:00:00.000Z', 1 - lead, { historicalLeads: lead, searchDemand: rnd() });
      insertSessions(u, '2026-03-15', i);          // outcome, after the score
      insertSessions(u, '2026-03-01', 10_000 - i); // pre-score decoy, must be ignored
    }

    const d = buildDataset({ db, windowDays: 30, outcome: 'sessions', now: NOW });
    assert.equal(d.n, 120);
    assert.equal(d.outcomes[0], 0);
    assert.equal(d.outcomes[119], 119, 'decoy pre-score sessions leaked in');

    // The scores as recorded run backwards to reality.
    assert.equal(evaluateWeights(d), -1);

    const r = proposeWeights(db, { dataset: d, baseline: BAD_BASELINE, passes: 6 });
    assert.equal(r.status, 'ok');
    assert.ok(r.after > 0.9);
    assert.equal(r.applied, false);
    assert.ok(r.calibrationRunId && r.calibrationRunId > 0);

    const saved = db.prepare('SELECT applied, correlation FROM calibration_runs WHERE id = ?')
      .get(r.calibrationRunId) as any;
    assert.equal(Number(saved.applied), 0);
    assert.equal(JSON.parse(String(saved.correlation)).metric, 'spearman');
  });
});
