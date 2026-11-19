/**
 * Google Search Console collector.
 * Pure: no network, no Google API, no live credentials. The API client is
 * faked and every database test runs against a throwaway temp file.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/intelligence/db.js';
import {
  transformSearchAnalyticsRows,
  upsertUrlPerformance,
  queryAllPages,
  dateRange,
  collectGsc,
  resolveCredentials,
  describeGscAccess,
  DEFAULT_LAG_DAYS,
  MAX_ROW_LIMIT,
  GSC_SCOPE,
  type GscApiResponse,
  type SearchAnalyticsClient,
} from '../../src/intelligence/collectors/gsc.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsc-test-'));
  tempDirs.push(dir);
  return openDb(path.join(dir, 'intelligence.db'));
}

afterEach(() => {
  delete process.env.FEATURE_INTELLIGENCE;
  delete process.env.FEATURE_GSC_COLLECTION;
});

const FIXTURE_PAGE: GscApiResponse = {
  responseAggregationType: 'byPage',
  rows: [
    {
      keys: ['https://www.kenresearch.com/industry-reports/india-ev-market'],
      clicks: 12,
      impressions: 480,
      ctr: 0.025,
      position: 8.4,
    },
    {
      keys: ['https://www.kenresearch.com/industry-reports/uae-logistics'],
      clicks: 0,
      impressions: 31,
      ctr: 0,
      position: 42.1,
    },
  ],
};

const FIXTURE_PAGE_QUERY: GscApiResponse = {
  responseAggregationType: 'byProperty',
  rows: [
    {
      keys: ['https://www.kenresearch.com/industry-reports/india-ev-market', 'india ev market size'],
      clicks: 9,
      impressions: 200,
      ctr: 0.045,
      position: 6.1,
    },
    {
      keys: ['https://www.kenresearch.com/industry-reports/india-ev-market', 'ev report india'],
      clicks: 3,
      impressions: 280,
      ctr: 0.0107,
      position: 11.2,
    },
  ],
};

function fakeClient(pages: GscApiResponse[]): SearchAnalyticsClient & { calls: any[] } {
  let i = 0;
  const calls: any[] = [];
  return {
    calls,
    searchanalytics: {
      async query(params: any) {
        calls.push(params);
        const data = pages[Math.min(i, pages.length - 1)];
        i++;
        return { data };
      },
    },
  } as any;
}

// ── transform ────────────────────────────────────────────────────────────────

describe('transformSearchAnalyticsRows', () => {
  test('maps page-dimension rows to url-scope rows', () => {
    const rows = transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10', ['page']);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      url: 'https://www.kenresearch.com/industry-reports/india-ev-market',
      source: 'gsc',
      metric_date: '2026-11-10',
      metric_scope: 'url',
      dimension_value: '',
      clicks: 12,
      impressions: 480,
      position: 8.4,
      ctr: 0.025,
    });
  });

  test('maps page+query rows to query-scope rows with the query in dimension_value', () => {
    const rows = transformSearchAnalyticsRows(FIXTURE_PAGE_QUERY, '2026-11-10', ['page', 'query']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].metric_scope, 'query');
    assert.equal(rows[0].dimension_value, 'india ev market size');
    assert.equal(rows[1].dimension_value, 'ev report india');
  });

  test('infers scope from key count when dimensions are not supplied', () => {
    assert.equal(transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10')[0].metric_scope, 'url');
    assert.equal(transformSearchAnalyticsRows(FIXTURE_PAGE_QUERY, '2026-11-10')[0].metric_scope, 'query');
  });

  test('url-scope dimension_value is an empty string, never null (SQLite UNIQUE)', () => {
    for (const r of transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10', ['page'])) {
      assert.equal(r.dimension_value, '');
      assert.notEqual(r.dimension_value, null);
    }
  });

  test('empty / missing / malformed responses yield no rows instead of throwing', () => {
    assert.deepEqual(transformSearchAnalyticsRows(null, '2026-11-10'), []);
    assert.deepEqual(transformSearchAnalyticsRows(undefined, '2026-11-10'), []);
    assert.deepEqual(transformSearchAnalyticsRows({}, '2026-11-10'), []);
    assert.deepEqual(transformSearchAnalyticsRows({ rows: [] }, '2026-11-10'), []);
  });

  test('drops rows with no usable page key', () => {
    const rows = transformSearchAnalyticsRows(
      { rows: [{ keys: [], clicks: 5 }, { clicks: 7 } as any, { keys: ['   '], clicks: 1 }] },
      '2026-11-10',
      ['page'],
    );
    assert.deepEqual(rows, []);
  });

  test('missing metrics default to 0 clicks/impressions and null position/ctr', () => {
    const rows = transformSearchAnalyticsRows(
      { rows: [{ keys: ['https://www.kenresearch.com/a'] }] },
      '2026-11-10',
      ['page'],
    );
    assert.equal(rows[0].clicks, 0);
    assert.equal(rows[0].impressions, 0);
    assert.equal(rows[0].position, null);
    assert.equal(rows[0].ctr, null);
  });

  test('de-duplicates repeated natural keys inside one response', () => {
    const dup = { rows: [...FIXTURE_PAGE.rows!, FIXTURE_PAGE.rows![0]] };
    assert.equal(transformSearchAnalyticsRows(dup, '2026-11-10', ['page']).length, 2);
  });

  test('rejects a metricDate that is not YYYY-MM-DD', () => {
    assert.throws(
      () => transformSearchAnalyticsRows(FIXTURE_PAGE, '10/11/2026'),
      /YYYY-MM-DD/,
    );
  });

  test('is pure — it does not mutate the input fixture', () => {
    const snapshot = JSON.stringify(FIXTURE_PAGE);
    transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10', ['page']);
    assert.equal(JSON.stringify(FIXTURE_PAGE), snapshot);
  });
});

// ── dateRange ────────────────────────────────────────────────────────────────

describe('dateRange', () => {
  test('is inclusive of both ends', () => {
    assert.deepEqual(dateRange('2026-11-08', '2026-11-10'), ['2026-11-08', '2026-11-09', '2026-11-10']);
  });
  test('single day', () => {
    assert.deepEqual(dateRange('2026-11-10', '2026-11-10'), ['2026-11-10']);
  });
  test('reversed range is empty, not infinite', () => {
    assert.deepEqual(dateRange('2026-11-10', '2026-11-08'), []);
  });
  test('crosses a month boundary', () => {
    assert.deepEqual(dateRange('2026-10-31', '2026-11-01'), ['2026-10-31', '2026-11-01']);
  });
});

// ── upsert / idempotency ─────────────────────────────────────────────────────

describe('upsertUrlPerformance', () => {
  test('writes rows into url_performance', () => {
    const db = tempDb();
    const rows = transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10', ['page']);
    assert.equal(upsertUrlPerformance(db, rows), 2);
    const n = db.prepare("SELECT COUNT(*) AS c FROM url_performance WHERE source='gsc'").get() as any;
    assert.equal(n.c, 2);
  });

  test('re-running the same day UPDATES rather than duplicating', () => {
    const db = tempDb();
    upsertUrlPerformance(db, transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10', ['page']));
    const updated: GscApiResponse = {
      rows: [{ ...FIXTURE_PAGE.rows![0], clicks: 99, impressions: 1000 }, FIXTURE_PAGE.rows![1]],
    };
    upsertUrlPerformance(db, transformSearchAnalyticsRows(updated, '2026-11-10', ['page']));

    const count = db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any;
    assert.equal(count.c, 2, 're-run must not duplicate');
    const row = db
      .prepare('SELECT clicks, impressions FROM url_performance WHERE url = ?')
      .get('https://www.kenresearch.com/industry-reports/india-ev-market') as any;
    assert.equal(row.clicks, 99);
    assert.equal(row.impressions, 1000);
  });

  test('url scope and query scope for the same url coexist', () => {
    const db = tempDb();
    upsertUrlPerformance(db, transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10', ['page']));
    upsertUrlPerformance(db, transformSearchAnalyticsRows(FIXTURE_PAGE_QUERY, '2026-11-10', ['page', 'query']));
    const c = db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any;
    assert.equal(c.c, 4);
  });

  test('different days are separate rows', () => {
    const db = tempDb();
    upsertUrlPerformance(db, transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-09', ['page']));
    upsertUrlPerformance(db, transformSearchAnalyticsRows(FIXTURE_PAGE, '2026-11-10', ['page']));
    const c = db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any;
    assert.equal(c.c, 4);
  });

  test('empty input writes nothing', () => {
    const db = tempDb();
    assert.equal(upsertUrlPerformance(db, []), 0);
  });
});

// ── paging ───────────────────────────────────────────────────────────────────

describe('queryAllPages', () => {
  test('stops after a short page', async () => {
    const client = fakeClient([FIXTURE_PAGE]);
    const rows = await queryAllPages(client, 'sc-domain:kenresearch.com', '2026-11-10', ['page'], 10);
    assert.equal(rows.length, 2);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].requestBody.startRow, 0);
    assert.equal(client.calls[0].requestBody.rowLimit, 10);
  });

  test('follows startRow until a short page arrives', async () => {
    const full: GscApiResponse = { rows: [FIXTURE_PAGE.rows![0], FIXTURE_PAGE.rows![1]] };
    const client = fakeClient([full, full, { rows: [FIXTURE_PAGE.rows![0]] }]);
    const rows = await queryAllPages(client, 'sc-domain:kenresearch.com', '2026-11-10', ['page'], 2);
    assert.equal(rows.length, 5);
    assert.deepEqual(client.calls.map((c) => c.requestBody.startRow), [0, 2, 4]);
  });

  test('clamps rowLimit to the API maximum', async () => {
    const client = fakeClient([{ rows: [] }]);
    await queryAllPages(client, 'sc-domain:kenresearch.com', '2026-11-10', ['page'], 999_999);
    assert.equal(client.calls[0].requestBody.rowLimit, MAX_ROW_LIMIT);
  });
});

// ── collectGsc ───────────────────────────────────────────────────────────────

describe('collectGsc', () => {
  test('is a complete no-op when the flag is off', async () => {
    const db = tempDb();
    const client = fakeClient([FIXTURE_PAGE]);
    const res = await collectGsc({ db, client, siteUrl: 'sc-domain:kenresearch.com', log: () => {} });
    assert.equal(res.status, 'skipped');
    assert.equal(res.rowsWritten, 0);
    const runs = db.prepare('SELECT COUNT(*) AS c FROM collection_runs').get() as any;
    assert.equal(runs.c, 0, 'disabled collector must not even open a run');
    assert.equal(client.calls.length, 0);
  });

  test('master switch alone does not enable it', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    const db = tempDb();
    const res = await collectGsc({ db, client: fakeClient([FIXTURE_PAGE]), siteUrl: 's', log: () => {} });
    assert.equal(res.status, 'skipped');
  });

  test('collects both dimension sets and records an ok run', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GSC_COLLECTION = '1';
    const db = tempDb();
    const client = fakeClient([FIXTURE_PAGE, FIXTURE_PAGE_QUERY]);
    const res = await collectGsc({
      db,
      client,
      siteUrl: 'sc-domain:kenresearch.com',
      startDate: '2026-11-10',
      endDate: '2026-11-10',
      log: () => {},
    });
    assert.equal(res.status, 'ok');
    assert.equal(res.rowsWritten, 4);
    const run = db.prepare('SELECT * FROM collection_runs WHERE id = ?').get(res.runId!) as any;
    assert.equal(run.collector, 'gsc');
    assert.equal(run.status, 'ok');
    assert.equal(run.rows_written, 4);
    assert.equal(run.window_start, '2026-11-10');
    assert.ok(run.finished_at);
  });

  test('re-running the same window is idempotent', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GSC_COLLECTION = '1';
    const db = tempDb();
    const args = {
      db,
      siteUrl: 'sc-domain:kenresearch.com',
      startDate: '2026-11-10',
      endDate: '2026-11-10',
      log: () => {},
    };
    await collectGsc({ ...args, client: fakeClient([FIXTURE_PAGE, FIXTURE_PAGE_QUERY]) });
    await collectGsc({ ...args, client: fakeClient([FIXTURE_PAGE, FIXTURE_PAGE_QUERY]) });
    const c = db.prepare('SELECT COUNT(*) AS c FROM url_performance').get() as any;
    assert.equal(c.c, 4);
  });

  test('missing siteUrl records a failed run and does not throw', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GSC_COLLECTION = '1';
    const prev = process.env.GSC_SITE_URL;
    delete process.env.GSC_SITE_URL;
    const db = tempDb();
    const res = await collectGsc({ db, client: fakeClient([FIXTURE_PAGE]), log: () => {} });
    if (prev !== undefined) process.env.GSC_SITE_URL = prev;
    assert.equal(res.status, 'failed');
    assert.match(res.reason!, /GSC_SITE_URL/);
    const run = db.prepare('SELECT status, error FROM collection_runs WHERE id = ?').get(res.runId!) as any;
    assert.equal(run.status, 'failed');
    assert.ok(run.error);
  });

  test('a 403 from the API records a failed run rather than crashing the caller', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GSC_COLLECTION = '1';
    const db = tempDb();
    const client: SearchAnalyticsClient = {
      searchanalytics: {
        async query() {
          throw new Error('User does not have sufficient permission for site');
        },
      },
    };
    const res = await collectGsc({
      db,
      client,
      siteUrl: 'sc-domain:kenresearch.com',
      startDate: '2026-11-10',
      endDate: '2026-11-10',
      log: () => {},
    });
    assert.equal(res.status, 'failed');
    assert.match(res.reason!, /sufficient permission/);
    const run = db.prepare('SELECT status FROM collection_runs WHERE id = ?').get(res.runId!) as any;
    assert.equal(run.status, 'failed');
  });

  test('one failing day in a wider window yields partial and keeps the good day', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GSC_COLLECTION = '1';
    const db = tempDb();
    const client: SearchAnalyticsClient = {
      searchanalytics: {
        async query(params: any) {
          if (params.requestBody.startDate === '2026-11-09') throw new Error('quota exceeded');
          return { data: FIXTURE_PAGE };
        },
      },
    };
    const res = await collectGsc({
      db,
      client,
      siteUrl: 'sc-domain:kenresearch.com',
      startDate: '2026-11-09',
      endDate: '2026-11-10',
      dimensionSets: [['page']],
      log: () => {},
    });
    assert.equal(res.status, 'partial');
    assert.equal(res.rowsWritten, 2);
    const run = db.prepare('SELECT status, rows_written FROM collection_runs WHERE id = ?').get(res.runId!) as any;
    assert.equal(run.status, 'partial');
    assert.equal(run.rows_written, 2);
  });

  test('defaults the window to end DEFAULT_LAG_DAYS ago (GSC data lag)', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_GSC_COLLECTION = '1';
    assert.equal(DEFAULT_LAG_DAYS, 3);
    const db = tempDb();
    const client = fakeClient([{ rows: [] }]);
    const res = await collectGsc({ db, client, siteUrl: 'sc-domain:kenresearch.com', log: () => {} });
    assert.equal(res.status, 'ok');
    const expected = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const run = db.prepare('SELECT window_start, window_end FROM collection_runs WHERE id = ?').get(res.runId!) as any;
    assert.equal(run.window_end, expected);
    assert.equal(run.window_start, expected);
  });
});

// ── credentials ──────────────────────────────────────────────────────────────

describe('credential resolution (no live call)', () => {
  test('uses the read-only webmasters scope', () => {
    assert.equal(GSC_SCOPE, 'https://www.googleapis.com/auth/webmasters.readonly');
  });

  test('reports a clear reason when the env JSON is unparseable', async () => {
    const res = await resolveCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: 'not json' } as any);
    assert.equal(res.credentials, undefined);
    assert.match(res.reason!, /not valid JSON/);
  });

  test('reports a clear reason when required fields are missing', async () => {
    const res = await resolveCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"a@b.com"}' } as any);
    assert.match(res.reason!, /client_email or private_key/);
  });

  test('resolves client_email from the env var without exposing the key', async () => {
    const json = JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: 'SECRET-KEY' });
    const res = await resolveCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: json } as any);
    assert.equal(res.clientEmail, 'bot@proj.iam.gserviceaccount.com');
    const msg = await describeGscAccess({ GOOGLE_SERVICE_ACCOUNT_JSON: json } as any);
    assert.match(msg, /bot@proj\.iam\.gserviceaccount\.com/);
    assert.ok(!msg.includes('SECRET-KEY'), 'must never print the private key');
  });
});
