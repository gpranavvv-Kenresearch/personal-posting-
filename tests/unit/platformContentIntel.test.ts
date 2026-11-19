/**
 * Platform intelligence and content intelligence. Temp-file database only.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, nowIso } from '../../src/intelligence/db.js';
import {
  indexationRate, computePlatformStats, recommend, persistPlatformStats,
  formatPlatformReport, matchPlatformsForReport, formatPlatformMatchReport,
} from '../../src/intelligence/platformIntelligence.js';
import {
  stripHtml, countWords, fleschReadingEase, extractFeatures, pearson,
  describeCorrelation, saveContentStats, correlateFeatures, refreshOutcomes,
} from '../../src/intelligence/contentIntelligence.js';
import { DEFAULT_THRESHOLDS } from '../../src/intelligence/weights.js';
import { normaliseUrl } from '../../src/intelligence/indexation.js';

let dir: string, db: any;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-pi-'));
  db = openDb(path.join(dir, 'x.db'));
});
afterEach(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

function addPost(platform: string, url: string, postedAt = '2026-11-01T00:00:00Z') {
  db.prepare(`INSERT INTO published_posts (report_url, platform, published_url, posted_at, created_at)
    VALUES (?,?,?,?,?)`).run('https://kenresearch.com/r', platform, url, postedAt, nowIso());
}
function addIndexation(url: string, status: string) {
  // indexation.ts stores the NORMALISED url — tests must store it the same way
  // or they would pass against a join that cannot work in production.
  db.prepare(`INSERT INTO indexation_checks (url, checked_at, status, confidence)
    VALUES (?,?,?,?)`).run(normaliseUrl(url), nowIso(), status, 0.8);
}

describe('indexation rate excludes unknowns', () => {
  test('unknowns do not count as failures', () => {
    // 5 indexed, 5 not indexed, 90 unknown -> 50%, NOT 5%.
    assert.equal(indexationRate(5, 5), 0.5);
  });
  test('no known results at all gives null, not zero', () => {
    assert.equal(indexationRate(0, 0), null);
  });
});

describe('platform recommendations', () => {
  const base = {
    platform: 'Medium', windowStart: '2026-08-01', windowEnd: '2026-11-01',
    posts: 100, postsIndexed: 80, postsNotIndexed: 20, postsUnknown: 0,
    sessions: 500, clicks: 0, impressions: 0, leads: 0,
    indexationRate: 0.8, sessionsPerPost: 5, leadsPerPost: 0, dataCoverage: 1,
  };

  test('a tiny sample is never judged', () => {
    const v = recommend({ ...base, posts: 3 });
    assert.equal(v.recommendation, 'insufficient-data');
    assert.equal(v.confidence, 'low');
  });

  test('no traffic AND no lead data means insufficient, not failure', () => {
    const v = recommend({ ...base, sessionsPerPost: null, leadsPerPost: null });
    assert.equal(v.recommendation, 'insufficient-data');
    assert.match(v.reasons.join(' '), /cannot assess/);
  });

  test('producing leads always means keep, whatever the traffic', () => {
    const v = recommend({ ...base, sessionsPerPost: 0.01, leads: 4, leadsPerPost: 0.04 });
    assert.equal(v.recommendation, 'keep');
    assert.equal(v.confidence, 'high');
  });

  test('poor traffic plus zero leads on a real sample suggests dropping', () => {
    const v = recommend({ ...base, sessionsPerPost: 0.05, leadsPerPost: 0 });
    assert.equal(v.recommendation, 'consider-dropping');
    assert.match(v.reasons.join(' '), /sessions\/post/);
  });

  test('healthy traffic means keep', () => {
    assert.equal(recommend(base).recommendation, 'keep');
  });

  test('low indexation with acceptable traffic flags investigation, not dropping', () => {
    const v = recommend({ ...base, indexationRate: 0.1, leadsPerPost: null });
    assert.equal(v.recommendation, 'investigate');
  });

  test('thin data lowers confidence even for a clear verdict', () => {
    const v = recommend({ ...base, sessionsPerPost: 0.01, leadsPerPost: 0, dataCoverage: 0.25 });
    assert.equal(v.recommendation, 'consider-dropping');
    assert.equal(v.confidence, 'medium', 'low coverage must not yield high confidence');
  });
});

describe('platform stats from the store', () => {
  test('counts posts and indexation per platform', () => {
    addPost('HackMD', 'https://hackmd.io/a');
    addPost('HackMD', 'https://hackmd.io/b');
    addIndexation('https://hackmd.io/a', 'indexed');
    addIndexation('https://hackmd.io/b', 'unknown');

    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const hackmd = stats.find(s => s.platform === 'HackMD')!;
    assert.equal(hackmd.posts, 2);
    assert.equal(hackmd.postsIndexed, 1);
    assert.equal(hackmd.postsUnknown, 1);
    assert.equal(hackmd.indexationRate, 1, 'one indexed, zero not-indexed, unknown excluded');
  });

  test('an empty store leaves every platform at zero posts and null ratios', () => {
    const stats = computePlatformStats({ db, windowDays: 90 });
    assert.ok(stats.length > 30, 'all registered platforms are reported');
    assert.ok(stats.every(s => s.posts === 0));
    assert.ok(stats.every(s => s.sessionsPerPost === null));
  });

  test('stats persist and re-persisting updates rather than duplicating', () => {
    const stats = computePlatformStats({ db, windowDays: 90, endDate: '2026-11-16' });
    persistPlatformStats(db, stats);
    persistPlatformStats(db, stats);
    const n: any = db.prepare('SELECT COUNT(*) c FROM platform_stats').get();
    assert.equal(n.c, stats.length, 'upsert must not duplicate');
  });

  test('the report renders and marks unmeasured values', () => {
    const stats = computePlatformStats({ db, windowDays: 90 });
    const text = formatPlatformReport(stats.map(s => recommend(s)));
    assert.match(text, /PLATFORM/);
    assert.match(text, /—/, 'unmeasured values shown as a dash');
  });
});

describe('content feature extraction', () => {
  test('strips html and scripts', () => {
    const out = stripHtml('<p>Hello <b>world</b></p><script>bad()</script>');
    assert.equal(out, 'Hello world');
  });

  test('counts words, headings, links and images from html', () => {
    const f = extractFeatures({
      html: '<h1>A</h1><h2>B</h2><p>one two three</p><a href="x">l</a><img src="y">',
      title: 'Top 5 Markets',
    });
    assert.equal(f.headingCount, 2);
    assert.equal(f.linkCount, 1);
    assert.equal(f.imageCount, 1);
    assert.ok(f.wordCount >= 5);
    assert.equal(f.hasNumberInTitle, true);
  });

  test('handles markdown as well as html', () => {
    const f = extractFeatures({ text: '# H\n\n## H2\n\n[link](http://a) ![img](http://b)', title: 'No digits' });
    assert.equal(f.headingCount, 2);
    assert.equal(f.linkCount, 1);
    assert.equal(f.imageCount, 1);
    assert.equal(f.hasNumberInTitle, false);
  });

  test('empty input does not crash', () => {
    const f = extractFeatures({});
    assert.equal(f.wordCount, 0);
    assert.equal(f.readability, 0);
  });

  test('simple prose reads easier than dense prose', () => {
    const easy = fleschReadingEase('The cat sat. The dog ran. It was fun.');
    const hard = fleschReadingEase('Notwithstanding the aforementioned considerations, the implementation necessitates comprehensive reconfiguration.');
    assert.ok(easy > hard, `expected ${easy} > ${hard}`);
  });
});

describe('correlation', () => {
  test('perfect positive correlation is 1', () => {
    const r = pearson([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    assert.ok(Math.abs(r! - 1) < 1e-9);
  });

  test('perfect negative correlation is -1', () => {
    const r = pearson([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert.ok(Math.abs(r! + 1) < 1e-9);
  });

  test('too few points returns null rather than a confident number', () => {
    assert.equal(pearson([1, 2, 3], [1, 2, 3]), null);
  });

  test('zero variance returns null instead of dividing by zero', () => {
    const flat = new Array(20).fill(5);
    assert.equal(pearson(flat, Array.from({ length: 20 }, (_, i) => i)), null);
  });

  test('descriptions carry the sample size', () => {
    assert.match(describeCorrelation(0.62, 40), /strong positive.*n=40/);
    assert.match(describeCorrelation(null, 4), /not enough data/);
  });
});

describe('content stats end to end', () => {
  test('features persist and outcomes backfill from performance data', () => {
    const url = 'https://medium.com/p/abc';
    saveContentStats(db, { url, platform: 'Medium', features: extractFeatures({ text: 'a b c d e', title: 'T' }) });

    db.prepare(`INSERT INTO url_performance (url, source, metric_date, metric_scope, sessions, clicks, collected_at)
      VALUES (?,?,?,?,?,?,?)`).run(url, 'ga4', new Date().toISOString().slice(0, 10), 'url', 120, 7, nowIso());

    assert.equal(refreshOutcomes(db), 1);
    const row: any = db.prepare('SELECT sessions_30d, clicks_30d FROM content_stats WHERE url = ?').get(url);
    assert.equal(row.sessions_30d, 120);
    assert.equal(row.clicks_30d, 7);
  });

  test('correlation over a thin table yields nulls, never fake certainty', () => {
    saveContentStats(db, { url: 'u1', features: extractFeatures({ text: 'a b', title: 'x' }) });
    const out = correlateFeatures(db, 10);
    assert.ok(out.every(c => c.r === null), 'n=1 must not produce a correlation');
  });
});

describe('GA4 attribution convention (regression)', () => {
  test('platform traffic is read using the convention ga4.ts actually writes', () => {
    // ga4.ts stores platform rows as metric_scope='utm_source' with
    // dimension_value='<source>|<campaign>'. Reading with metric_scope='source'
    // and an equality match silently returned 0 sessions for every platform.
    addPost('HackMD', 'https://hackmd.io/a');
    db.prepare(`INSERT INTO url_performance
      (url, source, metric_date, metric_scope, dimension_value, sessions, collected_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run('(property)', 'ga4', '2026-11-10', 'utm_source', 'hackmd|automation', 250, nowIso());

    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const hackmd = stats.find(s => s.platform === 'HackMD')!;
    assert.equal(hackmd.sessions, 250, 'sessions must be found despite the packed dimension');
    assert.ok(hackmd.sessionsPerPost !== null && hackmd.sessionsPerPost > 0);
  });

  test('a bare source value with no campaign suffix also matches', () => {
    addPost('Medium', 'https://medium.com/p/x');
    db.prepare(`INSERT INTO url_performance
      (url, source, metric_date, metric_scope, dimension_value, sessions, collected_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run('(property)', 'ga4', '2026-11-10', 'utm_source', 'medium', 40, nowIso());

    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    assert.equal(stats.find(s => s.platform === 'Medium')!.sessions, 40);
  });

  test('one platform does not absorb another whose name is a prefix', () => {
    addPost('LinkedIn', 'https://linkedin.com/p/x');
    db.prepare(`INSERT INTO url_performance
      (url, source, metric_date, metric_scope, dimension_value, sessions, collected_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run('(property)', 'ga4', '2026-11-10', 'utm_source', 'linkedin-pulse|automation', 99, nowIso());

    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    assert.equal(stats.find(s => s.platform === 'LinkedIn')!.sessions, 0,
      'linkedin must not absorb linkedin-pulse traffic');
    assert.equal(stats.find(s => s.platform === 'LinkedinPulse')!.sessions, 99);
  });
});

describe('URL normalisation across modules (regression)', () => {
  test('indexation recorded on a messy url is still found from the raw post url', () => {
    // published_posts keeps the raw url from the sheet, complete with utm and
    // www; indexation_checks keeps the normalised form. The reader must bridge
    // that gap, or indexation silently reads as zero for every platform.
    const raw = 'https://www.hackmd.io/abc123/?utm_source=hackmd&utm_medium=referral';
    addPost('HackMD', raw);
    addIndexation(raw, 'indexed');

    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const hackmd = stats.find(s => s.platform === 'HackMD')!;
    assert.equal(hackmd.postsIndexed, 1, 'raw vs normalised url must still match');
    assert.equal(hackmd.indexationRate, 1);
  });

  test('scoring finds indexation for a report url stored normalised', async () => {
    const { gatherSignals } = await import('../../src/intelligence/scoring.js');
    const reportUrl = 'https://www.kenresearch.com/report-x/?utm_source=x';
    db.prepare(`INSERT INTO indexation_checks (url, checked_at, status, confidence)
      VALUES (?,?,?,?)`).run(normaliseUrl(reportUrl), nowIso(), 'indexed', 0.9);

    const s = gatherSignals({ db, reportUrl });
    assert.notEqual(s.indexation, null, 'indexation must be found despite url form');
    assert.ok((s.indexation as number) > 0.9);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// matchPlatformsForReport — "which platform should THIS report go on?" This
// is the per-report question; computePlatformStats/recommend only answer the
// coarser "is this platform worth posting to at all".
// ═════════════════════════════════════════════════════════════════════════════
describe('matchPlatformsForReport', () => {
  const REPORT = 'https://www.kenresearch.com/report-match-test';

  function addPostFor(reportUrl: string, platform: string, publishedUrl: string, postedAt = '2026-11-01T00:00:00Z') {
    db.prepare(`INSERT INTO published_posts (report_url, platform, published_url, posted_at, created_at)
      VALUES (?,?,?,?,?)`).run(reportUrl, platform, publishedUrl, postedAt, nowIso());
  }
  function addPerf(url: string, sessions: number) {
    db.prepare(`INSERT INTO url_performance (url, source, metric_date, metric_scope, sessions, collected_at)
      VALUES (?,?,?,?,?,?)`).run(url, 'ga4', '2026-11-10', 'url', sessions, nowIso());
  }
  function addLeadFor(reportUrl: string, utmSource: string, n = 1) {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO leads (external_id, source_system, created_at, report_url, utm_source, collected_at)
        VALUES (?,?,?,?,?,?)`).run(`${utmSource}-${i}-${Math.random()}`, 'pipedrive', '2026-11-10T00:00:00Z', reportUrl, utmSource, nowIso());
    }
  }
  // Give a platform a real general track record so it clears
  // platformMinimumSample (20). computePlatformStats reads PLATFORM-WIDE
  // traffic from a single 'utm_source'-scoped row (the GA4 collector's own
  // storage convention — see collectors/ga4.ts), NOT from the per-URL 'url'
  // scope that addPerf below writes for direct, post-specific evidence.
  function givePlatformGeneralHistory(platform: string, utmSource: string, sessionsPerPost: number) {
    const postCount = 25;
    for (let i = 0; i < postCount; i++) {
      const url = `https://${platform.toLowerCase()}.example/${i}`;
      addPostFor('https://www.kenresearch.com/other-report', platform, url, '2026-10-01T00:00:00Z');
    }
    db.prepare(`INSERT INTO url_performance (url, source, metric_date, metric_scope, dimension_value, sessions, collected_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run('(property)', 'ga4', '2026-11-10', 'utm_source', `${utmSource}|automation`, sessionsPerPost * postCount, nowIso());
  }

  test('with no data anywhere, every platform is insufficient-data and suitability is null', () => {
    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const result = matchPlatformsForReport(db, REPORT, stats);
    assert.equal(result.suitability, null);
    assert.equal(result.bestUntried, null);
    assert.ok(result.ranked.every(r => r.fit === null && r.evidence === 'none'));
    assert.equal(result.coverage, 0);
  });

  test('a platform with a proven general track record, untried for this report, becomes the best recommendation', () => {
    givePlatformGeneralHistory('HackMD', 'hackmd', 8);
    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const result = matchPlatformsForReport(db, REPORT, stats);

    assert.ok(result.bestUntried !== null);
    assert.equal(result.bestUntried!.platform, 'HackMD');
    assert.equal(result.bestUntried!.tried, false);
    assert.equal(result.bestUntried!.evidence, 'general');
    assert.ok(result.suitability !== null && result.suitability > 0);
  });

  test('DIRECT evidence for this report beats the platform general average', () => {
    // HackMD's general record is modest...
    givePlatformGeneralHistory('HackMD', 'hackmd', 2);
    // ...but THIS report's own HackMD post did exceptionally well.
    const ownUrl = 'https://hackmd.io/this-report-post';
    addPostFor(REPORT, 'HackMD', ownUrl, '2026-11-05T00:00:00Z');
    addPerf(ownUrl, 500);
    addLeadFor(REPORT, 'hackmd', 3);

    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const result = matchPlatformsForReport(db, REPORT, stats);
    const hackmd = result.ranked.find(r => r.platform === 'HackMD')!;

    assert.equal(hackmd.tried, true);
    assert.equal(hackmd.evidence, 'direct');
    assert.equal(hackmd.sessionsPerPost, 500);
    assert.equal(hackmd.leadsPerPost, 3);
    // Already tried, so it can never be the "bestUntried" recommendation,
    // however well it did.
    assert.notEqual(result.bestUntried?.platform, 'HackMD');
  });

  test('a platform already tried for this report, with no own data yet, falls back to its general record and is never recommended as "untried"', () => {
    givePlatformGeneralHistory('Mataroa', 'mataroa', 4);
    addPostFor(REPORT, 'Mataroa', 'https://keninsight.mataroa.blog/this-one', '2026-11-05T00:00:00Z');
    // No url_performance / leads row for this report's own Mataroa post.

    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const result = matchPlatformsForReport(db, REPORT, stats);
    const mataroa = result.ranked.find(r => r.platform === 'Mataroa')!;

    assert.equal(mataroa.tried, true);
    assert.equal(mataroa.evidence, 'general');
    assert.notEqual(result.bestUntried?.platform, 'Mataroa', 'tried platforms are never the "untried" recommendation');
  });

  test('ranking is deterministic: higher fit first, ties broken by platform name', () => {
    givePlatformGeneralHistory('HackMD', 'hackmd', 10);
    givePlatformGeneralHistory('Mataroa', 'mataroa', 3);
    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const result = matchPlatformsForReport(db, REPORT, stats);

    const withFit = result.ranked.filter(r => r.fit !== null);
    for (let i = 1; i < withFit.length; i++) {
      assert.ok(withFit[i - 1]!.fit! >= withFit[i]!.fit!, 'must be sorted best-first');
    }
    const hackmdIdx = result.ranked.findIndex(r => r.platform === 'HackMD');
    const mataroaIdx = result.ranked.findIndex(r => r.platform === 'Mataroa');
    assert.ok(hackmdIdx < mataroaIdx, 'the platform with more sessions/post must rank first');
  });

  test('formatPlatformMatchReport never crashes on an empty/no-data result and says so plainly', () => {
    const stats = computePlatformStats({ db, windowDays: 365, endDate: '2026-11-16' });
    const result = matchPlatformsForReport(db, REPORT, stats);
    const text = formatPlatformMatchReport(result);
    assert.ok(text.includes('No untried platform'));
    assert.ok(text.includes('Advisory only'));
  });

  test('matchPlatformsForReport result wires correctly into scoring.ts platformSuitability when the flag is on', async () => {
    const { gatherSignals } = await import('../../src/intelligence/scoring.js');
    givePlatformGeneralHistory('HackMD', 'hackmd', 9);

    const before = process.env.FEATURE_PLATFORM_INTELLIGENCE;
    delete process.env.FEATURE_PLATFORM_INTELLIGENCE;
    try {
      assert.equal(gatherSignals({ db, reportUrl: REPORT }).platformSuitability, null,
        'off by default: flag unset means this signal stays missing');

      process.env.FEATURE_PLATFORM_INTELLIGENCE = '1';
      process.env.FEATURE_INTELLIGENCE = '1';
      const s = gatherSignals({ db, reportUrl: REPORT });
      assert.notEqual(s.platformSuitability, null, 'flag on + real data: the signal must actually fill in');
      assert.ok((s.platformSuitability as number) > 0 && (s.platformSuitability as number) <= 1);
    } finally {
      if (before === undefined) delete process.env.FEATURE_PLATFORM_INTELLIGENCE;
      else process.env.FEATURE_PLATFORM_INTELLIGENCE = before;
      delete process.env.FEATURE_INTELLIGENCE;
    }
  });
});
