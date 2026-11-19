/**
 * GA4 collector — pure transforms, idempotent upserts, flag gating and
 * failure handling. No live Google API call is made anywhere in this file:
 * the collector is driven by a fake client and fixture JSON.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/intelligence/db.js';
import {
  parseGa4Date,
  parseMetric,
  normalisePropertyId,
  transformLandingPageReport,
  transformSourceReport,
  parseSourceDimension,
  upsertPerformanceRows,
  runPagedReport,
  runReportWithMetricFallback,
  isMetricRejection,
  METRIC_SETS,
  collectGa4,
  sessionsByPlatform,
  PROPERTY_SCOPE_URL,
  GA4_SCOPE,
  type Ga4Report,
  type Ga4Client,
} from '../../src/intelligence/collectors/ga4.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const METRIC_HEADERS = [
  { name: 'sessions' },
  { name: 'totalUsers' },
  { name: 'engagedSessions' },
  { name: 'conversions' },
];

function landingFixture(rows: Array<[string, string, string[]]>): Ga4Report {
  return {
    dimensionHeaders: [{ name: 'landingPagePlusQueryString' }, { name: 'date' }],
    metricHeaders: METRIC_HEADERS,
    rows: rows.map(([page, date, metrics]) => ({
      dimensionValues: [{ value: page }, { value: date }],
      metricValues: metrics.map(v => ({ value: v })),
    })),
    rowCount: rows.length,
  };
}

function sourceFixture(rows: Array<[string, string, string, string[]]>): Ga4Report {
  return {
    dimensionHeaders: [{ name: 'sessionSource' }, { name: 'sessionCampaign' }, { name: 'date' }],
    metricHeaders: METRIC_HEADERS,
    rows: rows.map(([src, camp, date, metrics]) => ({
      dimensionValues: [{ value: src }, { value: camp }, { value: date }],
      metricValues: metrics.map(v => ({ value: v })),
    })),
    rowCount: rows.length,
  };
}

// ── temp db ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let dbFile: string;
let db: ReturnType<typeof openDb>;

function freshDb() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga4-test-'));
  dbFile = path.join(tmpDir, 'intel.db');
  db = openDb(dbFile);
  return db;
}

function dropDb() {
  try { db?.close(); } catch { /* already closed */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── scalar parsers ──────────────────────────────────────────────────────────

describe('parseGa4Date', () => {
  test('converts GA4 YYYYMMDD to YYYY-MM-DD', () => {
    assert.equal(parseGa4Date('20251116'), '2025-11-16');
    assert.equal(parseGa4Date('20240101'), '2024-01-01');
  });
  test('passes through an already-normalised date', () => {
    assert.equal(parseGa4Date('2025-11-16'), '2025-11-16');
  });
  test('rejects junk, empties and out-of-range parts', () => {
    for (const bad of ['', '   ', undefined, null, '(other)', '202511', '2025111', 'abcdefgh', '20251316', '20251100']) {
      assert.equal(parseGa4Date(bad as any), '', `expected '' for ${String(bad)}`);
    }
  });
});

describe('parseMetric', () => {
  test('parses integers and rounds fractional conversions', () => {
    assert.equal(parseMetric('12'), 12);
    assert.equal(parseMetric('1.0'), 1);
    assert.equal(parseMetric('2.6'), 3);
  });
  test('missing, empty or non-numeric becomes 0 rather than NaN', () => {
    for (const bad of [undefined, null, '', '  ', 'n/a', 'NaN', '-5']) {
      assert.equal(parseMetric(bad as any), 0, `expected 0 for ${String(bad)}`);
    }
  });
});

describe('normalisePropertyId', () => {
  test('accepts both accepted forms', () => {
    assert.equal(normalisePropertyId('123456789'), 'properties/123456789');
    assert.equal(normalisePropertyId('properties/123456789'), 'properties/123456789');
    assert.equal(normalisePropertyId('  properties/42 '), 'properties/42');
  });
  test('rejects anything else', () => {
    for (const bad of [undefined, null, '', 'properties/', 'G-ABC123', 'properties/abc', 'UA-12345-1']) {
      assert.equal(normalisePropertyId(bad as any), null, `expected null for ${String(bad)}`);
    }
  });
});

// ── transforms ──────────────────────────────────────────────────────────────

describe('transformLandingPageReport', () => {
  test('maps a normal row onto url_performance shape', () => {
    const rows = transformLandingPageReport(
      landingFixture([['/report/india-ev-market', '20251116', ['10', '8', '6', '2']]]),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      url: '/report/india-ev-market',
      source: 'ga4',
      metric_date: '2025-11-16',
      metric_scope: 'url',
      dimension_value: '',
      sessions: 10,
      users: 8,
      engaged_sessions: 6,
      conversions: 2,
    });
  });

  test('empty / missing / null report yields no rows', () => {
    assert.deepEqual(transformLandingPageReport(landingFixture([])), []);
    assert.deepEqual(transformLandingPageReport({}), []);
    assert.deepEqual(transformLandingPageReport(null), []);
    assert.deepEqual(transformLandingPageReport(undefined), []);
    assert.deepEqual(transformLandingPageReport({ rows: [] }), []);
  });

  test('missing metric values default to 0 instead of NaN', () => {
    const resp: Ga4Report = {
      dimensionHeaders: [{ name: 'landingPagePlusQueryString' }, { name: 'date' }],
      metricHeaders: METRIC_HEADERS,
      rows: [{
        dimensionValues: [{ value: '/a' }, { value: '20251116' }],
        metricValues: [{ value: '5' }], // totalUsers/engagedSessions/conversions absent
      }],
      rowCount: 1,
    };
    const [row] = transformLandingPageReport(resp);
    assert.equal(row.sessions, 5);
    assert.equal(row.users, 0);
    assert.equal(row.engaged_sessions, 0);
    assert.equal(row.conversions, 0);
  });

  test("drops '(not set)' / '(other)' / blank landing pages — unattributable", () => {
    const rows = transformLandingPageReport(landingFixture([
      ['(not set)', '20251116', ['3', '3', '3', '0']],
      ['(other)', '20251116', ['4', '4', '4', '0']],
      ['', '20251116', ['5', '5', '5', '0']],
      ['/keepme', '20251116', ['6', '6', '6', '1']],
    ]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, '/keepme');
  });

  test('drops rows whose date will not parse', () => {
    const rows = transformLandingPageReport(landingFixture([
      ['/a', '(other)', ['3', '3', '3', '0']],
      ['/b', '20251116', ['3', '3', '3', '0']],
    ]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, '/b');
  });

  test('honours header ORDER rather than assuming column positions', () => {
    const resp: Ga4Report = {
      dimensionHeaders: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
      metricHeaders: [{ name: 'conversions' }, { name: 'sessions' }, { name: 'engagedSessions' }, { name: 'totalUsers' }],
      rows: [{
        dimensionValues: [{ value: '20251116' }, { value: '/swapped' }],
        metricValues: [{ value: '1' }, { value: '9' }, { value: '7' }, { value: '8' }],
      }],
      rowCount: 1,
    };
    const [row] = transformLandingPageReport(resp);
    assert.equal(row.url, '/swapped');
    assert.equal(row.metric_date, '2025-11-16');
    assert.equal(row.sessions, 9);
    assert.equal(row.users, 8);
    assert.equal(row.engaged_sessions, 7);
    assert.equal(row.conversions, 1);
  });
});

describe('transformSourceReport', () => {
  test('keys platform attribution as "<source>|<campaign>" under the sentinel url', () => {
    const rows = transformSourceReport(
      sourceFixture([['hackmd', 'automation', '20251116', ['12', '11', '9', '3']]]),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      url: PROPERTY_SCOPE_URL,
      source: 'ga4',
      metric_date: '2025-11-16',
      metric_scope: 'utm_source',
      dimension_value: 'hackmd|automation',
      sessions: 12,
      users: 11,
      engaged_sessions: 9,
      conversions: 3,
    });
  });

  test('lowercases to match utm.ts, which always emits lowercase utm values', () => {
    const [row] = transformSourceReport(sourceFixture([['HackMD', 'Automation', '20251116', ['1', '1', '1', '0']]]));
    assert.equal(row.dimension_value, 'hackmd|automation');
  });

  test("KEEPS '(not set)' and '(direct)' — unattributed traffic is a real answer", () => {
    const rows = transformSourceReport(sourceFixture([
      ['(direct)', '(not set)', '20251116', ['50', '45', '30', '1']],
      ['(not set)', '(not set)', '20251116', ['2', '2', '1', '0']],
    ]));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dimension_value, '(direct)|(not set)');
    assert.equal(rows[1].dimension_value, '(not set)|(not set)');
  });

  test('blank dimension values become "(not set)" so the natural key is stable', () => {
    const [row] = transformSourceReport(sourceFixture([['', '', '20251116', ['1', '1', '1', '0']]]));
    assert.equal(row.dimension_value, '(not set)|(not set)');
  });

  test('empty and null reports yield no rows', () => {
    assert.deepEqual(transformSourceReport(sourceFixture([])), []);
    assert.deepEqual(transformSourceReport(null), []);
    assert.deepEqual(transformSourceReport({ rows: [null as any] }), []);
  });

  test('parseSourceDimension round-trips, including a campaign containing "|"', () => {
    assert.deepEqual(parseSourceDimension('linkedin-pulse|automation'), { source: 'linkedin-pulse', campaign: 'automation' });
    assert.deepEqual(parseSourceDimension('x|a|b'), { source: 'x', campaign: 'a|b' });
    assert.deepEqual(parseSourceDimension('solo'), { source: 'solo', campaign: '' });
  });
});

// ── persistence ─────────────────────────────────────────────────────────────

describe('upsertPerformanceRows', () => {
  beforeEach(freshDb);
  afterEach(dropDb);

  test('re-running the same day UPDATES instead of duplicating', () => {
    const first = transformLandingPageReport(landingFixture([['/a', '20251116', ['10', '9', '8', '1']]]));
    upsertPerformanceRows(db, first, '2025-11-16T01:00:00.000Z');

    const second = transformLandingPageReport(landingFixture([['/a', '20251116', ['25', '20', '15', '4']]]));
    upsertPerformanceRows(db, second, '2025-11-16T09:00:00.000Z');

    const rows = db.prepare('SELECT * FROM url_performance').all() as any[];
    assert.equal(rows.length, 1, 'must not duplicate the natural key');
    assert.equal(rows[0].sessions, 25);
    assert.equal(rows[0].conversions, 4);
    assert.equal(rows[0].collected_at, '2025-11-16T09:00:00.000Z');
  });

  test('platform rows dedupe on (source|campaign, date) too', () => {
    const r = transformSourceReport(sourceFixture([['medium', 'automation', '20251116', ['3', '3', '2', '0']]]));
    upsertPerformanceRows(db, r);
    upsertPerformanceRows(db, r);
    const n = (db.prepare("SELECT COUNT(*) AS c FROM url_performance WHERE metric_scope='utm_source'").get() as any).c;
    assert.equal(n, 1);
  });

  test('different dates and scopes coexist', () => {
    upsertPerformanceRows(db, [
      ...transformLandingPageReport(landingFixture([['/a', '20251116', ['1', '1', '1', '0']], ['/a', '20251117', ['2', '2', '2', '0']]])),
      ...transformSourceReport(sourceFixture([['x', 'automation', '20251116', ['5', '5', '5', '0']]])),
    ]);
    const n = (db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any).c;
    assert.equal(n, 3);
  });

  test('empty input writes nothing and does not throw', () => {
    assert.equal(upsertPerformanceRows(db, []), 0);
  });
});

// ── paging ──────────────────────────────────────────────────────────────────

describe('runPagedReport', () => {
  test('follows limit/offset until rowCount is exhausted', async () => {
    const calls: any[] = [];
    const fake: Ga4Client = {
      properties: {
        async runReport({ requestBody }: any) {
          calls.push(requestBody);
          const offset = Number(requestBody.offset);
          const page = offset === 0
            ? landingFixture([['/a', '20251116', ['1', '1', '1', '0']], ['/b', '20251116', ['1', '1', '1', '0']]])
            : landingFixture([['/c', '20251116', ['1', '1', '1', '0']]]);
          return { data: { ...page, rowCount: 3 } };
        },
      },
    };
    const pages = await runPagedReport(fake, 'properties/1', ['landingPagePlusQueryString', 'date'], '2025-11-01', '2025-11-16', 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].offset, '0');
    assert.equal(calls[1].offset, '2');
    assert.equal(pages.flatMap(p => transformLandingPageReport(p)).length, 3);
  });

  test('stops immediately on an empty first page', async () => {
    let n = 0;
    const fake: Ga4Client = {
      properties: { async runReport() { n++; return { data: { rows: [], rowCount: 0 } }; } },
    };
    const pages = await runPagedReport(fake, 'properties/1', ['date'], '2025-11-01', '2025-11-16', 100);
    assert.equal(n, 1);
    assert.equal(pages.length, 1);
  });
});

// ── metric-name fallback (GA4 conversions → keyEvents rename) ───────────────

function keyEventsFixture(): Ga4Report {
  return {
    dimensionHeaders: [{ name: 'landingPagePlusQueryString' }, { name: 'date' }],
    metricHeaders: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
    rows: [{
      dimensionValues: [{ value: '/report/a' }, { value: '20251116' }],
      metricValues: [{ value: '10' }, { value: '9' }, { value: '8' }, { value: '4' }],
    }],
    rowCount: 1,
  };
}

describe('metric-name fallback', () => {
  test('METRIC_SETS degrades conversions → keyEvents → neither', () => {
    assert.deepEqual(METRIC_SETS[0].at(-1), 'conversions');
    assert.deepEqual(METRIC_SETS[1].at(-1), 'keyEvents');
    assert.deepEqual(METRIC_SETS[2], ['sessions', 'totalUsers', 'engagedSessions']);
  });

  test('isMetricRejection separates a bad metric name from a permission failure', () => {
    assert.equal(isMetricRejection(new Error('Field conversions is not a valid metric.')), true);
    assert.equal(isMetricRejection(new Error('400 INVALID_ARGUMENT')), true);
    assert.equal(isMetricRejection(new Error('403 caller does not have permission')), false);
    assert.equal(isMetricRejection(new Error('Quota exhausted for metric requests')), false);
    assert.equal(isMetricRejection(new Error('socket hang up')), false);
  });

  test('a rejected `conversions` metric retries with keyEvents instead of losing the report', async () => {
    const asked: string[][] = [];
    const fake: Ga4Client = {
      properties: {
        async runReport({ requestBody }: any) {
          const metrics = requestBody.metrics.map((m: any) => m.name);
          asked.push(metrics);
          if (metrics.includes('conversions')) throw new Error('Field conversions is not a valid metric.');
          return { data: keyEventsFixture() };
        },
      },
    };

    const pages = await runReportWithMetricFallback(
      fake, 'properties/1', ['landingPagePlusQueryString', 'date'], '2025-11-16', '2025-11-16', 100);

    assert.deepEqual(asked[0].at(-1), 'conversions');
    assert.deepEqual(asked[1].at(-1), 'keyEvents');
    const rows = pages.flatMap(p => transformLandingPageReport(p));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessions, 10);
    // keyEvents is read as conversions — the rename must not zero the metric.
    assert.equal(rows[0].conversions, 4);
  });

  test('sessions survive even when BOTH conversion metric names are rejected', async () => {
    let attempts = 0;
    const fake: Ga4Client = {
      properties: {
        async runReport({ requestBody }: any) {
          attempts++;
          const metrics = requestBody.metrics.map((m: any) => m.name);
          if (metrics.includes('conversions') || metrics.includes('keyEvents')) {
            throw new Error('400 INVALID_ARGUMENT: unsupported metric');
          }
          return {
            data: {
              dimensionHeaders: [{ name: 'landingPagePlusQueryString' }, { name: 'date' }],
              metricHeaders: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }],
              rows: [{
                dimensionValues: [{ value: '/report/a' }, { value: '20251116' }],
                metricValues: [{ value: '10' }, { value: '9' }, { value: '8' }],
              }],
              rowCount: 1,
            } as Ga4Report,
          };
        },
      },
    };

    const pages = await runReportWithMetricFallback(
      fake, 'properties/1', ['landingPagePlusQueryString', 'date'], '2025-11-16', '2025-11-16', 100);
    assert.equal(attempts, 3);
    const rows = pages.flatMap(p => transformLandingPageReport(p));
    assert.equal(rows[0].sessions, 10);
    assert.equal(rows[0].conversions, 0);
  });

  test('a 403 is NOT retried down the metric list — it would only burn quota', async () => {
    let attempts = 0;
    const fake: Ga4Client = {
      properties: {
        async runReport() {
          attempts++;
          throw new Error('403 User does not have sufficient permissions for this property.');
        },
      },
    };

    await assert.rejects(
      () => runReportWithMetricFallback(fake, 'properties/1', ['date'], '2025-11-16', '2025-11-16', 100),
      /403/,
    );
    assert.equal(attempts, 1);
  });
});

// ── collector ───────────────────────────────────────────────────────────────

const FLAG_KEYS = ['FEATURE_INTELLIGENCE', 'FEATURE_GA4_COLLECTION', 'GA4_PROPERTY_ID'];
let savedEnv: Record<string, string | undefined> = {};

function saveEnv() { savedEnv = Object.fromEntries(FLAG_KEYS.map(k => [k, process.env[k]])); }
function restoreEnv() {
  for (const k of FLAG_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
}

function okClient(): Ga4Client {
  return {
    properties: {
      async runReport({ requestBody }: any) {
        const dims = requestBody.dimensions.map((d: any) => d.name);
        if (dims[0] === 'landingPagePlusQueryString') {
          return { data: landingFixture([['/report/a', '20251116', ['10', '9', '8', '1']]]) };
        }
        return { data: sourceFixture([
          ['hackmd', 'automation', '20251116', ['7', '6', '5', '1']],
          ['medium', 'automation', '20251116', ['3', '3', '2', '0']],
        ]) };
      },
    },
  };
}

describe('collectGa4', () => {
  beforeEach(() => { saveEnv(); freshDb(); });
  afterEach(() => { restoreEnv(); dropDb(); });

  test('is a complete no-op when the flag is off — no run row, no data', async () => {
    delete process.env.FEATURE_INTELLIGENCE;
    delete process.env.FEATURE_GA4_COLLECTION;
    let called = false;
    const spy: Ga4Client = { properties: { async runReport() { called = true; return { data: {} }; } } };

    const res = await collectGa4({ db, client: spy, startDate: '2025-11-10', endDate: '2025-11-16' });
    assert.equal(res.status, 'skipped');
    assert.equal(called, false);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM collection_runs').get() as any).c, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any).c, 0);
  });

  test('master switch alone is not enough', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    delete process.env.FEATURE_GA4_COLLECTION;
    const res = await collectGa4({ db, client: okClient() });
    assert.equal(res.status, 'skipped');
  });

  test('missing GA4_PROPERTY_ID records a failed run with a clear message, never throws', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GA4_COLLECTION = '1';
    delete process.env.GA4_PROPERTY_ID;

    const res = await collectGa4({ db, client: okClient(), startDate: '2025-11-10', endDate: '2025-11-16' });
    assert.equal(res.status, 'failed');
    assert.equal(res.rowsWritten, 0);
    assert.match(res.errors[0], /GA4_PROPERTY_ID/);

    const run = db.prepare('SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1').get() as any;
    assert.equal(run.collector, 'ga4');
    assert.equal(run.status, 'failed');
    assert.ok(run.finished_at);
    assert.match(run.error, /GA4_PROPERTY_ID/);
  });

  test('malformed GA4_PROPERTY_ID is rejected the same way', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GA4_COLLECTION = '1';
    process.env.GA4_PROPERTY_ID = 'G-ABC123';
    const res = await collectGa4({ db, client: okClient() });
    assert.equal(res.status, 'failed');
  });

  test('happy path writes both report shapes and an ok run', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GA4_COLLECTION = '1';
    process.env.GA4_PROPERTY_ID = '123456789';

    const res = await collectGa4({ db, client: okClient(), startDate: '2025-11-16', endDate: '2025-11-16' });
    assert.equal(res.status, 'ok');
    assert.equal(res.landingPageRows, 1);
    assert.equal(res.sourceRows, 2);
    assert.equal(res.rowsWritten, 3);

    const run = db.prepare('SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1') .get() as any;
    assert.equal(run.status, 'ok');
    assert.equal(run.rows_written, 3);
    assert.equal(run.window_start, '2025-11-16');
    assert.equal(run.window_end, '2025-11-16');
    assert.equal(run.error, null);
  });

  test('re-running the same window is idempotent', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GA4_COLLECTION = '1';
    process.env.GA4_PROPERTY_ID = 'properties/123456789';

    await collectGa4({ db, client: okClient(), startDate: '2025-11-16', endDate: '2025-11-16' });
    await collectGa4({ db, client: okClient(), startDate: '2025-11-16', endDate: '2025-11-16' });

    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any).c, 3);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM collection_runs').get() as any).c, 2);
  });

  test('one failing report yields a partial run and KEEPS the other report rows', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GA4_COLLECTION = '1';
    process.env.GA4_PROPERTY_ID = '123456789';

    const halfBroken: Ga4Client = {
      properties: {
        async runReport({ requestBody }: any) {
          const dims = requestBody.dimensions.map((d: any) => d.name);
          if (dims[0] === 'sessionSource') throw new Error('403 insufficient permissions');
          return { data: landingFixture([['/report/a', '20251116', ['10', '9', '8', '1']]]) };
        },
      },
    };

    const res = await collectGa4({ db, client: halfBroken, startDate: '2025-11-16', endDate: '2025-11-16' });
    assert.equal(res.status, 'partial');
    assert.equal(res.landingPageRows, 1);
    assert.equal(res.sourceRows, 0);
    assert.match(res.errors.join(''), /source report failed/);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any).c, 1);
    assert.equal((db.prepare('SELECT status FROM collection_runs ORDER BY id DESC LIMIT 1').get() as any).status, 'partial');
  });

  test('both reports failing yields a failed run, not a throw', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GA4_COLLECTION = '1';
    process.env.GA4_PROPERTY_ID = '123456789';

    const broken: Ga4Client = { properties: { async runReport() { throw new Error('API disabled'); } } };
    const res = await collectGa4({ db, client: broken });
    assert.equal(res.status, 'failed');
    assert.equal(res.rowsWritten, 0);
    assert.equal(res.errors.length, 2);
  });

  test('sessionsByPlatform answers "which platform drives traffic"', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GA4_COLLECTION = '1';
    process.env.GA4_PROPERTY_ID = '123456789';

    await collectGa4({ db, client: okClient(), startDate: '2025-11-16', endDate: '2025-11-16' });
    const ranked = sessionsByPlatform(db, '2025-11-01', '2025-11-30');
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].platform, 'hackmd');
    assert.equal(ranked[0].campaign, 'automation');
    assert.equal(ranked[0].sessions, 7);
    assert.equal(ranked[1].platform, 'medium');
  });
});

describe('read-only scope', () => {
  test('the collector requests analytics.readonly and nothing wider', () => {
    assert.equal(GA4_SCOPE, 'https://www.googleapis.com/auth/analytics.readonly');
  });
});
