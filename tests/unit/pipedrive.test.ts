/**
 * Pipedrive lead collector.
 *
 * Pure except where a temp-file database is explicitly opened. NEVER touches
 * the real Pipedrive API: every network call is an injected fake.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/intelligence/db.js';
import {
  parseFieldMap,
  inferAttribution,
  transformDeals,
  readPagination,
  moneyToMinor,
  minorExponent,
  toIsoUtc,
  canonicalReportUrl,
  upsertLeads,
  redact,
  collectPipedrive,
  humanSetupInstructions,
  type FieldMap,
} from '../../src/intelligence/collectors/pipedrive.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const HASH_LANDING = '9b2c1f0a7d3e4f5061728394a5b6c7d8e9f00112';
const HASH_SOURCE = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';

const MAP: FieldMap = { landing_url: HASH_LANDING, utm_source: HASH_SOURCE };

const DEAL_MAPPED = {
  id: 101,
  title: 'India Fintech Market enquiry',
  value: 1250.5,
  currency: 'usd',
  status: 'open',
  stage_id: 3,
  stage_name: 'Qualified',
  add_time: '2026-10-02 08:14:22',
  [HASH_LANDING]: 'https://www.kenresearch.com/industry-reports/india-fintech?utm_source=medium&utm_campaign=oct',
  [HASH_SOURCE]: 'medium',
};

/** Same account, but nobody filled the custom fields in. */
const DEAL_BARE = {
  id: 102,
  title: 'Enquiry',
  value: 0,
  currency: 'INR',
  status: 'won',
  add_time: '2026-10-03 11:00:00',
};

// ── parseFieldMap ────────────────────────────────────────────────────────────

describe('parseFieldMap', () => {
  test('parses the documented shape', () => {
    assert.deepEqual(
      parseFieldMap(`{"landing_url":"${HASH_LANDING}","utm_source":"${HASH_SOURCE}"}`),
      { landing_url: HASH_LANDING, utm_source: HASH_SOURCE },
    );
  });
  test('empty / undefined / whitespace give an empty map', () => {
    assert.deepEqual(parseFieldMap(undefined), {});
    assert.deepEqual(parseFieldMap(''), {});
    assert.deepEqual(parseFieldMap('   '), {});
    assert.deepEqual(parseFieldMap(null), {});
  });
  test('malformed JSON degrades to an empty map instead of throwing', () => {
    assert.deepEqual(parseFieldMap('{landing_url: oops'), {});
    assert.deepEqual(parseFieldMap('"a string"'), {});
    assert.deepEqual(parseFieldMap('[1,2]'), {});
  });
  test('ignores unknown and non-string keys', () => {
    assert.deepEqual(parseFieldMap('{"landing_url":"x","nonsense":"y","utm_source":42}'), { landing_url: 'x' });
  });
});

// ── money ────────────────────────────────────────────────────────────────────

describe('money handling', () => {
  test('two-decimal currencies convert to integer minor units', () => {
    assert.equal(moneyToMinor(1250.5, 'USD'), 125050);
    assert.equal(moneyToMinor(0, 'INR'), 0);
    assert.equal(moneyToMinor(19.99, 'EUR'), 1999);
  });
  test('zero-decimal currencies are not multiplied', () => {
    assert.equal(minorExponent('JPY'), 0);
    assert.equal(moneyToMinor(5000, 'JPY'), 5000);
  });
  test('three-decimal currencies use 1000', () => {
    assert.equal(minorExponent('KWD'), 3);
    assert.equal(moneyToMinor(2.5, 'KWD'), 2500);
  });
  test('unknown or missing currency assumes two decimals', () => {
    assert.equal(minorExponent('ZZZ'), 2);
    assert.equal(minorExponent(null), 2);
    assert.equal(moneyToMinor(1.23, null), 123);
  });
  test('numeric strings are accepted, junk gives null', () => {
    assert.equal(moneyToMinor('10.25', 'USD'), 1025);
    assert.equal(moneyToMinor(null, 'USD'), null);
    assert.equal(moneyToMinor('abc', 'USD'), null);
    assert.equal(moneyToMinor(undefined, 'USD'), null);
  });
  test('an empty value field is null, never a zero-value deal', () => {
    assert.equal(moneyToMinor('', 'USD'), null);
    assert.equal(moneyToMinor('   ', 'USD'), null);
    const [row] = transformDeals({ data: [{ id: 60, value: '', add_time: '2026-01-01 00:00:00' }] }, {});
    assert.equal(row.value_minor, null);
  });
  test('float drift is rounded away, never stored as a float', () => {
    const v = moneyToMinor(0.1 + 0.2, 'USD');
    assert.equal(v, 30);
    assert.equal(Number.isInteger(v), true);
  });
});

// ── timestamps ───────────────────────────────────────────────────────────────

describe('toIsoUtc', () => {
  test("Pipedrive's space-separated UTC format", () => {
    assert.equal(toIsoUtc('2026-10-02 08:14:22'), '2026-10-02T08:14:22.000Z');
  });
  test('date-only and already-ISO input', () => {
    assert.equal(toIsoUtc('2026-10-02'), '2026-10-02T00:00:00.000Z');
    assert.equal(toIsoUtc('2026-10-02T08:14:22.000Z'), '2026-10-02T08:14:22.000Z');
  });
  test('unparseable input returns null rather than inventing a time', () => {
    assert.equal(toIsoUtc(''), null);
    assert.equal(toIsoUtc(null), null);
    assert.equal(toIsoUtc('not a date'), null);
    assert.equal(toIsoUtc(12345), null);
  });
});

// ── inferAttribution ─────────────────────────────────────────────────────────

describe('inferAttribution — mapped fields win', () => {
  test('uses the configured hash keys', () => {
    const a = inferAttribution(DEAL_MAPPED, MAP);
    assert.equal(a.utm_source, 'medium');
    assert.match(a.landing_url!, /^https:\/\/www\.kenresearch\.com\/industry-reports\/india-fintech\?/);
    assert.equal(a.report_url, 'https://www.kenresearch.com/industry-reports/india-fintech');
    assert.equal(a.utm_campaign, 'oct'); // scanned off the mapped URL
    assert.equal(a.method, 'mixed');
  });
  test('a mapped utm_source overrides what the URL says', () => {
    const deal = { ...DEAL_MAPPED, [HASH_SOURCE]: 'linkedin' };
    assert.equal(inferAttribution(deal, MAP).utm_source, 'linkedin');
  });
  test('field map pointing at absent fields falls through to scanning', () => {
    const a = inferAttribution(DEAL_MAPPED, { landing_url: 'nope', utm_source: 'alsonope' });
    assert.equal(a.utm_source, 'medium');
    assert.equal(a.method, 'scan');
  });
  test('v2-style {value:...} custom field objects are unwrapped', () => {
    const deal = { id: 1, custom_fields: { [HASH_LANDING]: { value: 'https://x.test/a?utm_source=hackmd' } } };
    const a = inferAttribution(deal, { landing_url: HASH_LANDING });
    assert.equal(a.landing_url, 'https://x.test/a?utm_source=hackmd');
    assert.equal(a.utm_source, 'hackmd');
  });
});

describe('inferAttribution — scanning fallback', () => {
  test('a deal with no URL and no source anywhere yields nulls, not a throw', () => {
    const a = inferAttribution(DEAL_BARE, MAP);
    assert.deepEqual(a, {
      landing_url: null, report_url: null, utm_source: null, utm_campaign: null, method: 'none',
    });
  });
  test('handles null / non-object deals', () => {
    assert.equal(inferAttribution(null, MAP).method, 'none');
    assert.equal(inferAttribution('deal' as any, MAP).method, 'none');
    assert.equal(inferAttribution({ id: 9 }, {}).method, 'none');
  });
  test('a URL buried in a free-text note is found and trimmed', () => {
    const deal = { id: 5, notes: 'they came from https://medium.com/@ken/post-1?utm_source=medium.' };
    const a = inferAttribution(deal, {});
    assert.equal(a.landing_url, 'https://medium.com/@ken/post-1?utm_source=medium');
    assert.equal(a.utm_source, 'medium');
    assert.equal(a.method, 'scan');
  });
  test('among multiple candidate URLs the utm-tagged one wins, not the first', () => {
    const deal = {
      id: 6,
      org_site: 'https://acme.example.com/about',
      signature: 'https://linkedin.com/in/someone',
      referrer: 'https://www.kenresearch.com/report/x?utm_source=devto&utm_campaign=q4',
    };
    const a = inferAttribution(deal, {});
    assert.equal(a.landing_url, 'https://www.kenresearch.com/report/x?utm_source=devto&utm_campaign=q4');
    assert.equal(a.utm_source, 'devto');
    assert.equal(a.utm_campaign, 'q4');
    assert.equal(a.report_url, 'https://www.kenresearch.com/report/x');
  });
  test('report_url is picked from a kenresearch URL even when landing is elsewhere', () => {
    const deal = {
      id: 7,
      referrer: 'https://news.example.com/a?utm_source=facebook',
      interest: 'https://www.kenresearch.com/industry-reports/uae-logistics/',
    };
    const a = inferAttribution(deal, {});
    assert.equal(a.landing_url, 'https://news.example.com/a?utm_source=facebook');
    assert.equal(a.report_url, 'https://www.kenresearch.com/industry-reports/uae-logistics');
  });
  test('with no utm params a known source word elsewhere on the deal is used', () => {
    const deal = { id: 8, website: 'https://acme.example.com/', source_channel: 'LinkedIn' };
    const a = inferAttribution(deal, {});
    assert.equal(a.landing_url, 'https://acme.example.com/');
    assert.equal(a.utm_source, 'linkedin');
  });
  test('an unrecognised word is not mistaken for a utm_source', () => {
    const deal = { id: 9, title: 'Referral from a conference booth', website: 'https://acme.example.com/' };
    assert.equal(inferAttribution(deal, {}).utm_source, null);
  });
  test('attribution is deterministic across repeated calls', () => {
    const deal = { id: 10, a: 'https://one.test/x', b: 'https://two.test/y?utm_source=coda' };
    assert.deepEqual(inferAttribution(deal, {}), inferAttribution(deal, {}));
  });
});

describe('canonicalReportUrl', () => {
  test('strips query, fragment and a trailing slash', () => {
    assert.equal(canonicalReportUrl('https://a.test/p/?utm_source=x#top'), 'https://a.test/p');
  });
  test('garbage returns null', () => {
    assert.equal(canonicalReportUrl('not-a-url'), null);
  });
});

// ── transformDeals ───────────────────────────────────────────────────────────

describe('transformDeals', () => {
  const body = {
    success: true,
    data: [DEAL_MAPPED, DEAL_BARE],
    additional_data: { pagination: { start: 0, limit: 100, more_items_in_collection: true, next_start: 100 } },
  };

  test('maps the happy path completely', () => {
    const [row] = transformDeals(body, MAP);
    assert.equal(row.external_id, '101');
    assert.equal(row.source_system, 'pipedrive');
    assert.equal(row.created_at, '2026-10-02T08:14:22.000Z');
    assert.equal(row.utm_source, 'medium');
    assert.equal(row.report_url, 'https://www.kenresearch.com/industry-reports/india-fintech');
    assert.equal(row.stage, 'Qualified');
    assert.equal(row.status, 'open');
    assert.equal(row.value_minor, 125050);
    assert.equal(row.currency, 'USD'); // normalised upper-case
  });

  test('a deal with no custom fields still produces a usable row', () => {
    const row = transformDeals(body, MAP)[1];
    assert.equal(row.external_id, '102');
    assert.equal(row.landing_url, null);
    assert.equal(row.utm_source, null);
    assert.equal(row.value_minor, 0);
    assert.equal(row.attribution_method, 'none');
  });

  test('falls back to stage_id when stage_name is absent', () => {
    const [row] = transformDeals({ data: [{ id: 1, stage_id: 7, add_time: '2026-01-01 00:00:00' }] }, {});
    assert.equal(row.stage, '7');
  });

  test('tolerates {data:null}, a bare array, and junk entries', () => {
    assert.deepEqual(transformDeals({ success: true, data: null }, MAP), []);
    assert.deepEqual(transformDeals(null, MAP), []);
    assert.deepEqual(transformDeals({}, MAP), []);
    assert.equal(transformDeals([DEAL_BARE], MAP).length, 1);
    assert.equal(transformDeals({ data: [null, 'x', { noId: true }, DEAL_BARE] }, MAP).length, 1);
  });

  test('deals without an id are dropped — there is no key to upsert on', () => {
    assert.equal(transformDeals({ data: [{ add_time: '2026-01-01 00:00:00' }] }, MAP).length, 0);
  });

  test('falls back to update_time when add_time is missing', () => {
    const [row] = transformDeals({ data: [{ id: 3, update_time: '2026-02-02 09:00:00' }] }, {});
    assert.equal(row.created_at, '2026-02-02T09:00:00.000Z');
  });
});

describe('readPagination', () => {
  test('reads the flag and next_start', () => {
    assert.deepEqual(
      readPagination({ additional_data: { pagination: { more_items_in_collection: true, next_start: 100 } } }),
      { more: true, nextStart: 100 },
    );
  });
  test('missing block means no more pages', () => {
    assert.deepEqual(readPagination({}), { more: false, nextStart: null });
    assert.deepEqual(readPagination(null), { more: false, nextStart: null });
  });
});

describe('redact', () => {
  test('never lets a token survive into a message', () => {
    assert.equal(redact('failed with tok_SECRET123 attached', 'tok_SECRET123'), 'failed with *** attached');
    assert.match(redact('GET /deals?api_token=tok_SECRET123'), /api_token=\*\*\*/);
  });
});

// ── database behaviour ───────────────────────────────────────────────────────

describe('persistence and collectPipedrive', () => {
  let dir: string;
  let db: any;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipedrive-test-'));
    db = openDb(path.join(dir, 'intel.db'));
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  const rowsOf = () => db.prepare('SELECT * FROM leads ORDER BY external_id').all() as any[];
  const runsOf = () => db.prepare('SELECT * FROM collection_runs ORDER BY id').all() as any[];

  test('upsert is idempotent on (source_system, external_id)', () => {
    const rows = transformDeals({ data: [DEAL_MAPPED, DEAL_BARE] }, MAP);
    upsertLeads(db, rows, '2026-11-16T00:00:00.000Z');
    upsertLeads(db, rows, '2026-11-17T00:00:00.000Z');
    const stored = rowsOf();
    assert.equal(stored.length, 2);
    assert.equal(stored[0].collected_at, '2026-11-17T00:00:00.000Z');
  });

  test('a re-run updates mutable fields but never erases known attribution', () => {
    upsertLeads(db, transformDeals({ data: [DEAL_MAPPED] }, MAP));
    // Second run: field map lost, deal now won.
    upsertLeads(db, transformDeals({ data: [{ ...DEAL_MAPPED, [HASH_LANDING]: '', [HASH_SOURCE]: '', status: 'won' }] }, {}));
    const [row] = rowsOf();
    assert.equal(row.status, 'won');
    assert.equal(row.utm_source, 'medium', 'attribution must survive a run with worse data');
  });

  test('rows with an unparseable created_at are skipped, not written as NULL', () => {
    const n = upsertLeads(db, transformDeals({ data: [{ id: 50, add_time: 'garbage' }] }, {}));
    assert.equal(n, 0);
    assert.equal(rowsOf().length, 0);
  });

  test('flag off => no-op: no run row, no leads, no fetch', async () => {
    delete process.env.FEATURE_INTELLIGENCE;
    delete process.env.FEATURE_PIPEDRIVE_COLLECTION;
    let called = false;
    const res = await collectPipedrive({ db, fetchImpl: async () => { called = true; return {} as any; } });
    assert.equal(res.skipped, true);
    assert.equal(res.status, 'skipped');
    assert.equal(called, false);
    assert.equal(runsOf().length, 0);
    assert.equal(rowsOf().length, 0);
  });

  test('missing token => clear message + failed run, no crash', async () => {
    delete process.env.PIPEDRIVE_API_TOKEN;
    const res = await collectPipedrive({ db, force: true, token: '', fetchImpl: async () => { throw new Error('should not fetch'); } });
    assert.equal(res.ok, false);
    assert.equal(res.status, 'failed');
    assert.match(res.error!, /PIPEDRIVE_API_TOKEN/);
    const [run] = runsOf();
    assert.equal(run.status, 'failed');
    assert.equal(run.collector, 'pipedrive');
  });

  test('paginates until more_items_in_collection is false and writes every page', async () => {
    const pages = [
      {
        success: true,
        data: [DEAL_MAPPED],
        additional_data: { pagination: { more_items_in_collection: true, next_start: 1 } },
      },
      {
        success: true,
        data: [DEAL_BARE],
        additional_data: { pagination: { more_items_in_collection: false } },
      },
    ];
    const urls: string[] = [];
    const res = await collectPipedrive({
      db, force: true, token: 'tok_SECRET123', pageLimit: 1,
      fieldMapJson: JSON.stringify(MAP),
      fetchImpl: async (url: string, init: any) => {
        urls.push(url);
        assert.equal(init.headers['x-api-token'], 'tok_SECRET123');
        return { ok: true, status: 200, json: async () => pages[urls.length - 1] };
      },
    });
    assert.equal(res.status, 'ok');
    assert.equal(res.rows, 2);
    assert.equal(res.pages, 2);
    assert.equal(urls.length, 2);
    assert.match(urls[1], /start=1/);
    assert.ok(urls.every(u => !u.includes('tok_SECRET123')), 'token must never appear in a URL');
    assert.equal(rowsOf().length, 2);
  });

  test('`since` filters older deals and stops paging once a page is all older', async () => {
    const res = await collectPipedrive({
      db, force: true, token: 't0ken-value', since: '2026-10-03',
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({
          success: true,
          data: [DEAL_MAPPED], // 2026-10-02, older than `since`
          additional_data: { pagination: { more_items_in_collection: true, next_start: 100 } },
        }),
      }),
    });
    assert.equal(res.status, 'ok');
    assert.equal(res.rows, 0);
    assert.equal(res.pages, 1, 'must stop rather than walking the whole CRM');
  });

  test('an HTTP error on the first page => failed run, nothing lost silently', async () => {
    const res = await collectPipedrive({
      db, force: true, token: 'tok_SECRET123',
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    assert.equal(res.status, 'failed');
    assert.match(res.error!, /401/);
    assert.equal(runsOf()[0].status, 'failed');
  });

  test('an error on page 2 keeps page 1 and records a PARTIAL run', async () => {
    let n = 0;
    const res = await collectPipedrive({
      db, force: true, token: 'tok_SECRET123', fieldMapJson: JSON.stringify(MAP),
      fetchImpl: async () => {
        n++;
        if (n === 1) {
          return {
            ok: true, status: 200,
            json: async () => ({
              success: true, data: [DEAL_MAPPED],
              additional_data: { pagination: { more_items_in_collection: true, next_start: 100 } },
            }),
          };
        }
        throw new Error('socket hang up while calling api_token=tok_SECRET123');
      },
    });
    assert.equal(res.status, 'partial');
    assert.equal(res.rows, 1);
    assert.equal(rowsOf().length, 1);
    const run = runsOf()[0];
    assert.equal(run.status, 'partial');
    assert.equal(run.rows_written, 1);
    assert.ok(!run.error.includes('tok_SECRET123'), 'the token must never reach the run log');
  });

  test("Pipedrive's success:false body is treated as a failure, not as zero deals", async () => {
    const res = await collectPipedrive({
      db, force: true, token: 'tok_SECRET123',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'invalid token' }) }),
    });
    assert.equal(res.status, 'failed');
    assert.match(res.error!, /invalid token/);
  });

  test('re-running the whole collector for the same window does not duplicate', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [DEAL_MAPPED, DEAL_BARE], additional_data: {} }),
    });
    await collectPipedrive({ db, force: true, token: 'tok', fetchImpl: fetchImpl as any });
    await collectPipedrive({ db, force: true, token: 'tok', fetchImpl: fetchImpl as any });
    assert.equal(rowsOf().length, 2);
    assert.equal(runsOf().length, 2);
    assert.ok(runsOf().every((r: any) => r.status === 'ok'));
  });

  test('the master flag alone is not enough to enable collection', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    delete process.env.FEATURE_PIPEDRIVE_COLLECTION;
    const res = await collectPipedrive({ db, fetchImpl: async () => ({} as any) });
    assert.equal(res.skipped, true);
  });

  test('both flags on => it actually runs', async () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_PIPEDRIVE_COLLECTION = '1';
    const res = await collectPipedrive({
      db, token: 'tok',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [DEAL_BARE] }) }),
    });
    assert.equal(res.skipped, false);
    assert.equal(res.status, 'ok');
    assert.equal(res.rows, 1);
  });
});

describe('operator documentation', () => {
  test('tells a human exactly what to supply and how to find the hash keys', () => {
    const doc = humanSetupInstructions();
    assert.match(doc, /PIPEDRIVE_API_TOKEN/);
    assert.match(doc, /PIPEDRIVE_FIELD_MAP/);
    assert.match(doc, /dealFields/);
    assert.match(doc, /FEATURE_PIPEDRIVE_COLLECTION/);
  });
});
