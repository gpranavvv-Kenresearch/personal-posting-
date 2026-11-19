/**
 * Indexation detection: URL normalisation, the pure classifier, and the
 * collector's persistence/skip behaviour.
 *
 * Pure: no network, no SERP provider, no real database. Every provider
 * response is a fixture; every db is a throwaway temp file.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../src/intelligence/db.js';
import {
  normaliseUrl,
  classifyIndexation,
  buildSiteQuery,
  checkIndexation,
  recordCheck,
  lastCheck,
  isRecentlyChecked,
  type SerpSearcher,
} from '../../src/intelligence/indexation.js';

const TARGET = 'https://medium.com/@kenresearch/india-ev-market-2026-abc123';

const tempDirs: string[] = [];
function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idxtest-'));
  tempDirs.push(dir);
  return openDb(path.join(dir, 'intelligence.db'));
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
});

function withFlags<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
    }
  }
}

const ON = { FEATURE_INTELLIGENCE: '1', FEATURE_INDEXATION_CHECKS: '1' };
const OFF = { FEATURE_INTELLIGENCE: undefined, FEATURE_INDEXATION_CHECKS: undefined };

const hit = (link: string) => ({ link, title: 't', snippet: 's', position: 1 });

// ── normaliseUrl ─────────────────────────────────────────────────────────────

describe('normaliseUrl', () => {
  test('strips scheme, www and trailing slash', () => {
    const want = 'medium.com/@ken/post';
    assert.equal(normaliseUrl('https://medium.com/@ken/post'), want);
    assert.equal(normaliseUrl('http://www.medium.com/@ken/post/'), want);
    assert.equal(normaliseUrl('MEDIUM.COM/@ken/post'), want);
    assert.equal(normaliseUrl('https://Medium.com/@ken/post#section'), want);
  });

  test('strips utm and other tracking params but keeps real ones', () => {
    assert.equal(
      normaliseUrl('https://hackmd.io/x?utm_source=medium&utm_campaign=q4&gclid=1&fbclid=2'),
      'hackmd.io/x',
    );
    assert.equal(normaliseUrl('https://hackmd.io/x?id=7&utm_medium=social'), 'hackmd.io/x?id=7');
  });

  test('param order does not change identity', () => {
    assert.equal(normaliseUrl('https://a.com/p?b=2&a=1'), normaliseUrl('https://a.com/p?a=1&b=2'));
  });

  test('collapses the root path and duplicate slashes', () => {
    assert.equal(normaliseUrl('https://www.medium.com/'), 'medium.com');
    assert.equal(normaliseUrl('https://medium.com//a//b'), 'medium.com/a/b');
  });

  test('bare host without a scheme still normalises', () => {
    assert.equal(normaliseUrl('medium.com/@ken/post/'), 'medium.com/@ken/post');
  });

  test('empty and garbage input degrade instead of throwing', () => {
    assert.equal(normaliseUrl(''), '');
    assert.equal(normaliseUrl('   '), '');
    assert.equal(normaliseUrl('not a url'), 'not a url');
    assert.doesNotThrow(() => normaliseUrl('ht!tp:///'));
  });

  test('different paths on the same host stay different', () => {
    assert.notEqual(normaliseUrl('https://medium.com/@ken/a'), normaliseUrl('https://medium.com/@ken/b'));
  });
});

describe('buildSiteQuery', () => {
  test('builds a site: query from the normalised url', () => {
    assert.equal(buildSiteQuery('https://www.medium.com/@ken/post/?utm_source=x'), 'site:medium.com/@ken/post');
  });
  test('returns empty for unusable input', () => {
    assert.equal(buildSiteQuery(''), '');
  });
});

// ── classifyIndexation: the whole decision table ─────────────────────────────

describe('classifyIndexation — indexed', () => {
  test('exact url hit => indexed, high confidence', () => {
    const c = classifyIndexation({ organic_results: [hit(TARGET)] }, TARGET);
    assert.equal(c.status, 'indexed');
    assert.ok(c.confidence >= 0.9, `confidence ${c.confidence}`);
    assert.equal(c.rawHitCount, 1);
    assert.match(c.evidence, /exact url/i);
  });

  test('hit differing only by utm / www / trailing slash still counts', () => {
    const c = classifyIndexation(
      { organic_results: [hit('http://www.medium.com/@kenresearch/india-ev-market-2026-abc123/?utm_source=x')] },
      TARGET,
    );
    assert.equal(c.status, 'indexed');
  });

  test('exact url found among several results', () => {
    const c = classifyIndexation(
      { organic_results: [hit('https://medium.com/@kenresearch/other'), hit(TARGET), hit('https://x.com/a')] },
      TARGET,
    );
    assert.equal(c.status, 'indexed');
    assert.equal(c.rawHitCount, 3);
  });
});

describe('classifyIndexation — not_indexed (moderate confidence only)', () => {
  test('clean zero-result from a healthy provider => not_indexed, never 1.0', () => {
    const c = classifyIndexation({ organic_results: [] }, TARGET);
    assert.equal(c.status, 'not_indexed');
    assert.ok(c.confidence > 0 && c.confidence < 1, `confidence ${c.confidence} must be moderate`);
    assert.equal(c.rawHitCount, 0);
  });

  test('NEAR MISS: a different url on the same domain must NOT count as indexed', () => {
    const c = classifyIndexation(
      { organic_results: [hit('https://medium.com/@kenresearch/a-completely-different-post-999')] },
      TARGET,
    );
    assert.equal(c.status, 'not_indexed');
    assert.ok(c.confidence < 1);
    assert.equal(c.rawHitCount, 1);
    assert.match(c.evidence, /same domain/i);
  });

  test('near miss on a path prefix of the target is not a match', () => {
    const c = classifyIndexation(
      { organic_results: [hit('https://medium.com/@kenresearch/india-ev-market-2026')] },
      TARGET,
    );
    assert.equal(c.status, 'not_indexed');
  });

  test('results on entirely different domains => not_indexed', () => {
    const c = classifyIndexation({ organic_results: [hit('https://hackmd.io/zzz')] }, TARGET);
    assert.equal(c.status, 'not_indexed');
    assert.equal(c.rawHitCount, 1);
  });

  test('no not_indexed verdict ever reaches confidence 1.0', () => {
    for (const body of [
      { organic_results: [] },
      { organic_results: [hit('https://medium.com/@kenresearch/zzz')] },
      { organic_results: [hit('https://other.com/zzz')] },
    ]) {
      const c = classifyIndexation(body, TARGET);
      assert.equal(c.status, 'not_indexed');
      assert.ok(c.confidence < 1, 'site: is evidence, not proof');
    }
  });
});

describe('classifyIndexation — unknown is first class', () => {
  const cases: Array<[string, unknown]> = [
    ['null body', null],
    ['undefined body', undefined],
    ['empty string body', ''],
    ['garbled html body', '<html><body>Our systems have detected unusual traffic</body></html>'],
    ['non-json string body', 'totally not json'],
    ['array body', [1, 2, 3]],
    ['number body', 42],
    ['serpstack error flag', { error: true }],
    ['provider error message', { error: 'Rate limit exceeded' }],
    ['captcha field', { captcha: 'solve this captcha' }],
    ['thrown provider error', new Error('All SERP providers exhausted')],
    ['missing organic_results', { search_metadata: { status: 'Success' } }],
    ['organic_results not an array', { organic_results: 'nope' }],
    // Results came back but none carried a url: nothing to compare against, so
    // the target's absence cannot be asserted.
    ['results with no usable links', { organic_results: [{ title: 't' }, { title: 'u', link: '' }] }],
    ['results that are not objects', { organic_results: [null, 'x', 7] }],
  ];

  for (const [name, body] of cases) {
    test(`${name} => unknown, never not_indexed`, () => {
      const c = classifyIndexation(body, TARGET);
      assert.equal(c.status, 'unknown', `${name} produced ${c.status}`);
      assert.equal(c.confidence, 0);
      assert.equal(c.rawHitCount, null);
      assert.ok(c.evidence.length > 0);
    });
  }

  test('empty target url => unknown, not a crash', () => {
    const c = classifyIndexation({ organic_results: [] }, '');
    assert.equal(c.status, 'unknown');
  });

  test('evidence never leaks a key-looking token', () => {
    const c = classifyIndexation(new Error('SerpAPI error 401: api_key=abcdef0123456789abcdef0123456789'), TARGET);
    assert.equal(c.status, 'unknown');
    assert.ok(!c.evidence.includes('abcdef0123456789abcdef0123456789'), c.evidence);
  });
});

// ── persistence helpers ──────────────────────────────────────────────────────

describe('persistence', () => {
  test('recordCheck stores the normalised url and round-trips', () => {
    const db = tempDb();
    recordCheck(db, 'https://www.medium.com/@ken/post/?utm_source=x', 'medium', 'serpapi',
      { status: 'indexed', confidence: 0.95, evidence: 'e', rawHitCount: 2 });
    const row = db.prepare('SELECT * FROM indexation_checks').get() as any;
    assert.equal(row.url, 'medium.com/@ken/post');
    assert.equal(row.platform, 'medium');
    assert.equal(row.provider, 'serpapi');
    assert.equal(row.status, 'indexed');
    assert.equal(row.raw_hit_count, 2);
    assert.equal(lastCheck(db, 'http://medium.com/@ken/post')!.status, 'indexed');
    db.close();
  });

  test('unknown stores a null hit count', () => {
    const db = tempDb();
    recordCheck(db, TARGET, null, null, { status: 'unknown', confidence: 0, evidence: 'e', rawHitCount: null });
    const row = db.prepare('SELECT raw_hit_count FROM indexation_checks').get() as any;
    assert.equal(row.raw_hit_count, null);
    db.close();
  });

  test('recordCheck is idempotent on (url, checked_at)', () => {
    const db = tempDb();
    const at = '2026-01-01T00:00:00.000Z';
    const c = { status: 'indexed' as const, confidence: 0.95, evidence: 'e', rawHitCount: 1 };
    recordCheck(db, TARGET, 'medium', 'serpapi', c, at);
    recordCheck(db, TARGET, 'medium', 'serpapi', c, at);
    recordCheck(db, `${TARGET}/`, 'medium', 'serpapi', c, at);   // same normalised url
    assert.equal((db.prepare('SELECT COUNT(*) c FROM indexation_checks').get() as any).c, 1);
    // A genuinely later check is still a new row: this is a history table.
    recordCheck(db, TARGET, 'medium', 'serpapi', c, '2026-01-08T00:00:00.000Z');
    assert.equal((db.prepare('SELECT COUNT(*) c FROM indexation_checks').get() as any).c, 2);
    db.close();
  });

  test('isRecentlyChecked honours the window', () => {
    const db = tempDb();
    const eightDaysAgo = new Date(Date.now() - 8 * 86400_000).toISOString();
    recordCheck(db, TARGET, null, 'serpapi',
      { status: 'not_indexed', confidence: 0.6, evidence: 'e', rawHitCount: 0 }, eightDaysAgo);
    assert.equal(isRecentlyChecked(db, TARGET, 7), false);
    assert.equal(isRecentlyChecked(db, TARGET, 30), true);
    db.close();
  });
});

// ── collector ────────────────────────────────────────────────────────────────

function fakeSearcher(body: unknown, provider = 'serpapi'): SerpSearcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (q: string) => { calls.push(q); return { response: body, provider }; }) as any;
  fn.calls = calls;
  return fn;
}

describe('checkIndexation', () => {
  test('is a no-op when the flag is off — nothing written', async () => {
    const db = tempDb();
    const s = fakeSearcher({ organic_results: [hit(TARGET)] });
    const out = await withFlags(OFF, () => checkIndexation({ db, urls: [TARGET], searcher: s, delayMs: 0 }));
    assert.equal(out.enabled, false);
    assert.equal(s.calls.length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM indexation_checks').get() as any).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM collection_runs').get() as any).c, 0);
    db.close();
  });

  test('master switch alone is not enough', async () => {
    const db = tempDb();
    const s = fakeSearcher({ organic_results: [] });
    const out = await withFlags({ FEATURE_INTELLIGENCE: '1', FEATURE_INDEXATION_CHECKS: undefined },
      () => checkIndexation({ db, urls: [TARGET], searcher: s, delayMs: 0 }));
    assert.equal(out.enabled, false);
    db.close();
  });

  test('writes a row and an ok run when the url is indexed', async () => {
    const db = tempDb();
    const s = fakeSearcher({ organic_results: [hit(TARGET)] });
    const out = await withFlags(ON, () =>
      checkIndexation({ db, urls: [{ url: TARGET, platform: 'medium' }], searcher: s, delayMs: 0 }));
    assert.equal(out.indexed, 1);
    assert.equal(out.checked, 1);
    assert.deepEqual(s.calls, ['site:medium.com/@kenresearch/india-ev-market-2026-abc123']);
    const row = db.prepare('SELECT * FROM indexation_checks').get() as any;
    assert.equal(row.status, 'indexed');
    assert.equal(row.provider, 'serpapi');
    assert.equal(row.platform, 'medium');
    const run = db.prepare('SELECT * FROM collection_runs WHERE id = ?').get(out.runId) as any;
    assert.equal(run.collector, 'indexation');
    assert.equal(run.status, 'ok');
    assert.equal(run.rows_written, 1);
    db.close();
  });

  test('a throwing provider records unknown and a failed run, not a crash', async () => {
    const db = tempDb();
    const s = (async () => { throw new Error('All SERP providers exhausted'); }) as SerpSearcher;
    const out = await withFlags(ON, () => checkIndexation({ db, urls: [TARGET], searcher: s, delayMs: 0 }));
    assert.equal(out.unknown, 1);
    assert.equal(out.notIndexed, 0);
    const row = db.prepare('SELECT * FROM indexation_checks').get() as any;
    assert.equal(row.status, 'unknown');
    const run = db.prepare('SELECT status FROM collection_runs WHERE id = ?').get(out.runId) as any;
    assert.equal(run.status, 'failed');
    db.close();
  });

  test('one bad url does not abort the batch (partial run)', async () => {
    const db = tempDb();
    const other = 'https://hackmd.io/abc';
    let n = 0;
    const s: SerpSearcher = async () => {
      n++;
      if (n === 1) throw new Error('timeout');
      return { response: { organic_results: [hit(other)] }, provider: 'zenserp' };
    };
    const out = await withFlags(ON, () => checkIndexation({ db, urls: [TARGET, other], searcher: s, delayMs: 0 }));
    assert.equal(out.checked, 2);
    assert.equal(out.unknown, 1);
    assert.equal(out.indexed, 1);
    const run = db.prepare('SELECT status FROM collection_runs WHERE id = ?').get(out.runId) as any;
    assert.equal(run.status, 'partial');
    db.close();
  });

  test('skips urls checked within the window, re-checks older ones', async () => {
    const db = tempDb();
    recordCheck(db, TARGET, 'medium', 'serpapi',
      { status: 'not_indexed', confidence: 0.6, evidence: 'e', rawHitCount: 0 });
    const s = fakeSearcher({ organic_results: [hit(TARGET)] });
    let out = await withFlags(ON, () => checkIndexation({ db, urls: [TARGET], searcher: s, delayMs: 0 }));
    assert.equal(out.skippedRecent, 1);
    assert.equal(s.calls.length, 0);

    out = await withFlags(ON, () => checkIndexation({ db, urls: [TARGET], searcher: s, delayMs: 0, maxAgeDays: 0 }));
    assert.equal(out.checked, 1);
    assert.equal(s.calls.length, 1);
    db.close();
  });

  test('duplicate urls in one batch are only queried once', async () => {
    const db = tempDb();
    const s = fakeSearcher({ organic_results: [] });
    const out = await withFlags(ON, () => checkIndexation({
      db, urls: [TARGET, `${TARGET}/`, `${TARGET}?utm_source=x`], searcher: s, delayMs: 0,
    }));
    assert.equal(out.checked, 1);
    assert.equal(s.calls.length, 1);
    db.close();
  });

  test('limit caps the number of provider calls', async () => {
    const db = tempDb();
    const s = fakeSearcher({ organic_results: [] });
    const urls = ['a', 'b', 'c', 'd'].map(x => `https://hackmd.io/${x}`);
    const out = await withFlags(ON, () => checkIndexation({ db, urls, searcher: s, delayMs: 0, limit: 2 }));
    assert.equal(out.checked, 2);
    assert.equal(s.calls.length, 2);
    db.close();
  });

  test('empty and blank urls are ignored', async () => {
    const db = tempDb();
    const s = fakeSearcher({ organic_results: [] });
    const out = await withFlags(ON, () => checkIndexation({ db, urls: ['', '   '], searcher: s, delayMs: 0 }));
    assert.equal(out.checked, 0);
    assert.equal(s.calls.length, 0);
    db.close();
  });
});
