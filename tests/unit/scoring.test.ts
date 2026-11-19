/**
 * Opportunity scoring. Pure maths plus a temp-file database — no network,
 * no spreadsheet, no live data.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  clamp01, logNormalise, rankingOpportunityFrom, indexationSignal,
  recencyMultiplier, computeScore, gatherSignals, saveScore,
  type SignalSet,
} from '../../src/intelligence/scoring.js';
import { DEFAULT_WEIGHTS, normaliseWeights, positiveWeightSum } from '../../src/intelligence/weights.js';
import { openDb } from '../../src/intelligence/db.js';

const FULL: SignalSet = {
  searchDemand: 0.8,
  rankingOpportunity: 0.9,
  indexation: 1,
  historicalTraffic: 0.5,
  historicalLeads: 0.7,
  geographic: 0.5,
  platformSuitability: 0.5,
  daysSinceLastPromotion: null,
};

describe('normalisation helpers', () => {
  test('clamp01 bounds and rejects NaN/Infinity', () => {
    assert.equal(clamp01(-5), 0);
    assert.equal(clamp01(5), 1);
    assert.equal(clamp01(0.5), 0.5);
    assert.equal(clamp01(NaN), 0);
    assert.equal(clamp01(Infinity), 1);
  });

  test('logNormalise is 0 at zero and 1 at the ceiling', () => {
    assert.equal(logNormalise(0, 1000), 0);
    assert.equal(logNormalise(-10, 1000), 0);
    assert.equal(logNormalise(1000, 1000), 1);
  });

  test('logNormalise rewards early growth more than late growth', () => {
    const early = logNormalise(100, 10000) - logNormalise(0, 10000);
    const late = logNormalise(10000, 10000) - logNormalise(9900, 10000);
    assert.ok(early > late, 'log curve must compress the top end');
  });
});

describe('ranking opportunity', () => {
  test('unknown position stays missing, never zero', () => {
    assert.equal(rankingOpportunityFrom(null), null);
    assert.equal(rankingOpportunityFrom(0), null);
  });

  test('mid-page ranks score highest — that is where the upside is', () => {
    const atTop = rankingOpportunityFrom(2)!;
    const mid = rankingOpportunityFrom(20)!;
    const deep = rankingOpportunityFrom(150)!;
    assert.ok(mid > atTop, 'rank 20 should beat rank 2 for opportunity');
    assert.ok(mid > deep, 'rank 20 should beat rank 150');
  });
});

describe('indexation signal preserves the tri-state', () => {
  test('indexed is high, not_indexed is low', () => {
    assert.ok(indexationSignal('indexed', 1)! > 0.9);
    assert.ok(indexationSignal('not_indexed', 1)! < 0.1);
  });

  test('unknown is MISSING, not zero', () => {
    assert.equal(indexationSignal('unknown'), null);
    assert.equal(indexationSignal(null), null);
    assert.equal(indexationSignal(undefined), null);
  });

  test('low confidence pulls both verdicts toward the middle', () => {
    assert.ok(Math.abs(indexationSignal('indexed', 0.1)! - 0.5) < 0.1);
  });
});

describe('recency', () => {
  test('never promoted is unpenalised', () => {
    assert.equal(recencyMultiplier(null, DEFAULT_WEIGHTS), 1);
  });
  test('old promotion is unpenalised', () => {
    assert.equal(recencyMultiplier(90, DEFAULT_WEIGHTS), 1);
  });
  test('just promoted is penalised but never zeroed', () => {
    const m = recencyMultiplier(0, DEFAULT_WEIGHTS);
    assert.ok(m < 1, 'should be penalised');
    assert.ok(m > 0, 'must never be zero — a strong report can still win');
  });
  test('penalty eases as days pass', () => {
    assert.ok(recencyMultiplier(25, DEFAULT_WEIGHTS) > recencyMultiplier(1, DEFAULT_WEIGHTS));
  });
});

describe('score composition', () => {
  test('all signals present gives full coverage', () => {
    const r = computeScore('https://kenresearch.com/a', FULL);
    assert.ok(r.coverage > 0.99, `coverage was ${r.coverage}`);
    assert.ok(r.score > 0 && r.score <= 1);
  });

  test('a missing signal is excluded, NOT treated as zero', () => {
    const withAll = computeScore('u', FULL).score;
    const withMissing = computeScore('u', { ...FULL, historicalLeads: null }).score;
    const withZero = computeScore('u', { ...FULL, historicalLeads: 0 }).score;

    assert.ok(withMissing > withZero,
      'missing data must not be punished like a measured zero');
    assert.ok(Math.abs(withMissing - withAll) < 0.2,
      'dropping one signal should renormalise, not collapse the score');
  });

  test('coverage falls when signals are missing', () => {
    const r = computeScore('u', {
      ...FULL, searchDemand: null, historicalTraffic: null, historicalLeads: null,
    });
    assert.ok(r.coverage < 0.7, `coverage should drop, was ${r.coverage}`);
  });

  test('no signals at all scores zero with zero coverage, and does not crash', () => {
    const r = computeScore('u', {
      searchDemand: null, rankingOpportunity: null, indexation: null,
      historicalTraffic: null, historicalLeads: null, geographic: null,
      platformSuitability: null, daysSinceLastPromotion: null,
    });
    assert.equal(r.score, 0);
    assert.equal(r.coverage, 0);
    assert.match(r.explanation, /no signals available/);
  });

  test('every component is reported so a score can be explained', () => {
    const r = computeScore('u', FULL);
    assert.equal(r.components.length, 7);
    for (const c of r.components) {
      assert.ok(typeof c.weight === 'number');
      assert.ok(typeof c.contribution === 'number');
    }
  });

  test('leads outweigh traffic under the default weights', () => {
    const leadsOnly = computeScore('u', {
      ...FULL, historicalTraffic: 0, historicalLeads: 1,
    }).score;
    const trafficOnly = computeScore('u', {
      ...FULL, historicalTraffic: 1, historicalLeads: 0,
    }).score;
    assert.ok(leadsOnly > trafficOnly, 'leads are the outcome that matters');
  });

  test('score is bounded to 0..1 even with absurd inputs', () => {
    const r = computeScore('u', { ...FULL, searchDemand: 99, historicalLeads: -99 });
    assert.ok(r.score >= 0 && r.score <= 1);
  });

  test('the weights version is recorded on every score', () => {
    assert.match(computeScore('u', FULL).weightsVersion, /uncalibrated/);
  });
});

describe('weights', () => {
  test('defaults are normalisable to exactly 1', () => {
    assert.ok(Math.abs(positiveWeightSum(normaliseWeights(DEFAULT_WEIGHTS)) - 1) < 1e-9);
  });
  test('normalising preserves relative ordering', () => {
    const n = normaliseWeights(DEFAULT_WEIGHTS);
    assert.ok(n.historicalLeads > n.historicalTraffic);
    assert.ok(n.searchDemand > n.geographic);
  });
});

describe('gathering signals from the store', () => {
  let dir: string, db: any;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-score-'));
    db = openDb(path.join(dir, 'x.db'));
  });
  afterEach(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

  test('an empty store yields all-missing signals, not zeros', () => {
    const s = gatherSignals({ db, reportUrl: 'https://kenresearch.com/none' });
    assert.equal(s.searchDemand, null);
    assert.equal(s.historicalTraffic, null);
    assert.equal(s.historicalLeads, null, 'no lead data at all means unknown, not zero leads');
    assert.equal(s.indexation, null);
  });

  test('GSC rows produce demand and ranking signals', () => {
    db.prepare(`INSERT INTO url_performance
      (url, source, metric_date, metric_scope, impressions, clicks, position, collected_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run('https://kenresearch.com/a', 'gsc', '2026-11-10', 'url', 5000, 50, 18.5, '2026-11-11T00:00:00Z');

    const s = gatherSignals({ db, reportUrl: 'https://kenresearch.com/a' });
    assert.ok(s.searchDemand !== null && s.searchDemand > 0);
    assert.ok(s.rankingOpportunity !== null && s.rankingOpportunity > 0.9,
      'rank 18 is prime opportunity territory');
  });

  test('once ANY lead exists, zero leads for a report becomes a real measurement', () => {
    db.prepare(`INSERT INTO leads (external_id, source_system, created_at, report_url, collected_at)
      VALUES (?,?,?,?,?)`)
      .run('deal-1', 'pipedrive', '2026-11-10T00:00:00Z', 'https://kenresearch.com/other', '2026-11-11T00:00:00Z');

    const s = gatherSignals({ db, reportUrl: 'https://kenresearch.com/a' });
    assert.notEqual(s.historicalLeads, null, 'lead data exists, so 0 leads is informative');
    assert.equal(s.historicalLeads, 0);
  });

  test('unknown indexation stays missing', () => {
    db.prepare(`INSERT INTO indexation_checks (url, checked_at, status, confidence)
      VALUES (?,?,?,?)`)
      .run('https://kenresearch.com/a', '2026-11-15T00:00:00Z', 'unknown', 0.5);
    assert.equal(gatherSignals({ db, reportUrl: 'https://kenresearch.com/a' }).indexation, null);
  });

  test('scores persist with their breakdown', () => {
    const r = computeScore('https://kenresearch.com/a', FULL);
    const id = saveScore(db, r, true);
    assert.ok(id > 0);
    const row: any = db.prepare('SELECT * FROM opportunity_scores WHERE id = ?').get(id);
    assert.equal(row.report_url, 'https://kenresearch.com/a');
    assert.equal(row.shadow, 1);
    assert.ok(JSON.parse(row.components).components.length === 7);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Interlink limits are SAFETY controls. A limit that cannot be parsed must
// never read as "no limit" — that is how a per-run cap silently disappears.
// ═════════════════════════════════════════════════════════════════════════════

test('sanitiseInterlinkLimits rejects junk and falls back to the default', async () => {
  const { sanitiseInterlinkLimits, DEFAULT_INTERLINK_LIMITS } =
    await import('../../src/intelligence/weights.js');
  for (const junk of ['none', '10', NaN, Infinity, -Infinity, null, undefined, {}, [], true]) {
    const l = sanitiseInterlinkLimits({ maxLinksAddedPerRun: junk }, () => {});
    assert.equal(l.maxLinksAddedPerRun, DEFAULT_INTERLINK_LIMITS.maxLinksAddedPerRun,
      `junk=${String(junk)}`);
  }
  // Every limit comes back finite whatever the input.
  const all = sanitiseInterlinkLimits({
    maxNewLinksPerSourcePage: 'x', maxLinksAddedPerRun: 'x',
    maxLinksPerDestinationPerWeek: 'x', minRelevanceToPropose: 'x',
    minParagraphWords: 'x', cooldownHours: 'x',
  }, () => {});
  for (const [k, v] of Object.entries(all)) {
    assert.ok(Number.isFinite(v), `${k} is not finite`);
  }
  assert.deepEqual(all, DEFAULT_INTERLINK_LIMITS);
});

test('sanitiseInterlinkLimits clamps out-of-range values and honours good ones', async () => {
  const { sanitiseInterlinkLimits } = await import('../../src/intelligence/weights.js');
  const warnings: string[] = [];
  const l = sanitiseInterlinkLimits({
    maxLinksAddedPerRun: 2.7,        // integer-only -> floored
    cooldownHours: -5,               // below range  -> clamped to 0
    minRelevanceToPropose: 9,        // above range  -> clamped to 1
    maxNewLinksPerSourcePage: 4,     // valid        -> kept
  }, (m) => warnings.push(m));
  assert.equal(l.maxLinksAddedPerRun, 2);
  assert.equal(l.cooldownHours, 0);
  assert.equal(l.minRelevanceToPropose, 1);
  assert.equal(l.maxNewLinksPerSourcePage, 4);
  assert.ok(warnings.length >= 2, 'out-of-range overrides must be reported, not silent');
});

test('a non-object INTERLINK_LIMITS_JSON yields the defaults, never a partial', async () => {
  const { loadInterlinkLimits, DEFAULT_INTERLINK_LIMITS } =
    await import('../../src/intelligence/weights.js');
  for (const raw of ['[]', 'null', '"nope"', '7', '{bad json', '']) {
    const l = loadInterlinkLimits({ INTERLINK_LIMITS_JSON: raw } as any);
    assert.deepEqual(l, DEFAULT_INTERLINK_LIMITS, `raw=${raw}`);
  }
});
