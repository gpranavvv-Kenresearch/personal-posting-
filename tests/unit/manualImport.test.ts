/**
 * Tests for src/intelligence/collectors/manualImport.ts — the no-credentials
 * GA4/GSC CSV import path.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type DB } from '../../src/intelligence/db.js';
import {
  parseCsv, normaliseExportUrl, parseManualExport, writeManualImportRows, importManualExportFile,
} from '../../src/intelligence/collectors/manualImport.js';

describe('parseCsv', () => {
  test('splits plain rows', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
  });

  test('handles quoted fields with embedded commas and escaped quotes', () => {
    assert.deepEqual(
      parseCsv('Page,Title\n/foo,"Market, ""Overview"" 2026"'),
      [['Page', 'Title'], ['/foo', 'Market, "Overview" 2026']],
    );
  });

  test('drops blank lines', () => {
    assert.deepEqual(parseCsv('a,b\n\n1,2\n'), [['a', 'b'], ['1', '2']]);
  });
});

describe('normaliseExportUrl', () => {
  test('leaves an absolute URL untouched', () => {
    assert.equal(
      normaliseExportUrl('https://www.kenresearch.com/industry-reports/r-1?utm_source=x'),
      'https://www.kenresearch.com/industry-reports/r-1?utm_source=x',
    );
  });
  test('prefixes a bare path with the domain', () => {
    assert.equal(normaliseExportUrl('/industry-reports/r-1'), 'https://www.kenresearch.com/industry-reports/r-1');
  });
  test('prefixes a path with no leading slash too', () => {
    assert.equal(normaliseExportUrl('industry-reports/r-1'), 'https://www.kenresearch.com/industry-reports/r-1');
  });
});

describe('parseManualExport', () => {
  test('skips the "# ---" comment preamble GA4 puts above the header, and the Grand total row', () => {
    const csv = [
      '# ----------------------------------------',
      '# Ken Research - GA4',
      '# Pages and screens-Free form 4',
      '# 20260820-20261117',
      '# ----------------------------------------',
      '',
      'Page path and screen class,Sessions,Engaged sessions',
      ',667073,285127,Grand total',
      '/africa-cashew-market,11,2',
    ].join('\n');
    const res = parseManualExport(csv, { source: 'ga4-manual', metricDate: '2026-11-17' }) as any;
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].url, 'https://www.kenresearch.com/africa-cashew-market');
    assert.equal(res.rows[0].sessions, 11);
    assert.equal(res.rows[0].engaged_sessions, 2);
  });

  test('parses a GSC-style "Pages" export', () => {
    const csv = [
      'Top pages,Clicks,Impressions,CTR,Position',
      '/industry-reports/india-hospital-market,12,500,2.4%,8.1',
      '/industry-reports/brazil-ev-market,3,100,3.0%,15.2',
    ].join('\n');
    const res = parseManualExport(csv, { source: 'gsc-manual', metricDate: '2026-11-16' }) as any;
    assert.equal(res.rows.length, 2);
    assert.equal(res.rows[0].url, 'https://www.kenresearch.com/industry-reports/india-hospital-market');
    assert.equal(res.rows[0].clicks, 12);
    assert.equal(res.rows[0].impressions, 500);
    assert.equal(res.rows[0].ctr, 2.4);
    assert.equal(res.rows[0].position, 8.1);
    assert.equal(res.rows[0].source, 'gsc-manual');
    assert.equal(res.rows[0].metric_date, '2026-11-16');
    assert.equal(res.skippedReasons.length, 0);
  });

  test('parses a GA4-style landing-page export', () => {
    const csv = [
      'Landing page,Sessions,Engaged sessions,Active users',
      '/industry-reports/india-hospital-market,240,180,210',
    ].join('\n');
    const res = parseManualExport(csv, { source: 'ga4-manual', metricDate: '2026-11-16' }) as any;
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].sessions, 240);
    assert.equal(res.rows[0].engaged_sessions, 180);
    assert.equal(res.rows[0].users, 210);
    assert.equal(res.rows[0].clicks, null);
  });

  test('reports a clear reason when no URL column is recognised', () => {
    const res = parseManualExport('Foo,Bar\n1,2', { source: 'gsc-manual', metricDate: '2026-11-16' }) as any;
    assert.equal(res.rows.length, 0);
    assert.ok(res.skippedReasons[0].includes('No recognisable URL'));
  });

  test('skips rows with an empty URL and a duplicate URL, keeping the first', () => {
    const csv = [
      'Page,Clicks',
      ',5',
      '/a,1',
      '/a,2',
    ].join('\n');
    const res = parseManualExport(csv, { source: 'gsc-manual', metricDate: '2026-11-16' }) as any;
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].clicks, 1);
    assert.equal(res.rowsSkipped, 2);
  });

  test('rejects a malformed date rather than silently writing one', () => {
    assert.throws(() => parseManualExport('Page,Clicks\n/a,1', { source: 'gsc-manual', metricDate: '16-11-2026' }));
  });

  test('tolerant number parsing: commas, percent signs, N/A, blanks', () => {
    const csv = [
      'Page,Clicks,Impressions,CTR',
      '/a,"1,234",N/A,5.5%',
      '/b,,500,',
    ].join('\n');
    const res = parseManualExport(csv, { source: 'gsc-manual', metricDate: '2026-11-16' }) as any;
    assert.equal(res.rows[0].clicks, 1234);
    assert.equal(res.rows[0].impressions, null);
    assert.equal(res.rows[0].ctr, 5.5);
    assert.equal(res.rows[1].clicks, null);
    assert.equal(res.rows[1].impressions, 500);
  });
});

describe('writeManualImportRows / importManualExportFile — database round trip', () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-import-test-'));
    db = openDb(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes rows into url_performance and they are idempotent on re-import', () => {
    const file = path.join(dir, 'export.csv');
    fs.writeFileSync(file, [
      'Top pages,Clicks,Impressions,Position',
      '/industry-reports/foo,10,200,5.0',
    ].join('\n'));

    const first = importManualExportFile(db, file, { source: 'gsc-manual', metricDate: '2026-11-16' });
    assert.equal(first.rowsWritten, 1);

    const countAfterFirst = (db.prepare('SELECT COUNT(*) AS n FROM url_performance').get() as any).n;
    assert.equal(countAfterFirst, 1);

    // Re-import the SAME file/date: must update, not duplicate.
    const second = importManualExportFile(db, file, { source: 'gsc-manual', metricDate: '2026-11-16' });
    assert.equal(second.rowsWritten, 1);
    const countAfterSecond = (db.prepare('SELECT COUNT(*) AS n FROM url_performance').get() as any).n;
    assert.equal(countAfterSecond, 1, 'same (url, source, date) must UPDATE, not duplicate');

    const row = db.prepare('SELECT * FROM url_performance WHERE source = ?').get('gsc-manual') as any;
    assert.equal(row.clicks, 10);
    assert.equal(row.impressions, 200);
    assert.equal(row.position, 5.0);
  });

  test('a GA4 import and a GSC import for the same URL/date coexist as separate rows', () => {
    const gaFile = path.join(dir, 'ga4.csv');
    fs.writeFileSync(gaFile, 'Landing page,Sessions\n/industry-reports/foo,100'.split('\n').join('\n'));
    const gscFile = path.join(dir, 'gsc.csv');
    fs.writeFileSync(gscFile, 'Page,Clicks\n/industry-reports/foo,10'.split('\n').join('\n'));

    importManualExportFile(db, gaFile, { source: 'ga4-manual', metricDate: '2026-11-16' });
    importManualExportFile(db, gscFile, { source: 'gsc-manual', metricDate: '2026-11-16' });

    const n = (db.prepare('SELECT COUNT(*) AS n FROM url_performance').get() as any).n;
    assert.equal(n, 2, 'different source = different row, even for the same url/date');
  });
});
