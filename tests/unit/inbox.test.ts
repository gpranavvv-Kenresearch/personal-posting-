/**
 * Tests for src/intelligence/collectors/inbox.ts — scanning a drop folder
 * for GA4/GSC exports and importing them automatically.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type DB } from '../../src/intelligence/db.js';
import { scanAndImportInbox } from '../../src/intelligence/collectors/inbox.js';

describe('scanAndImportInbox', () => {
  let dir: string;
  let db: DB;
  let inboxDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'));
    db = openDb(path.join(dir, 'test.db'));
    inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeCsv(name: string, lines: string[]): void {
    fs.writeFileSync(path.join(inboxDir, name), lines.join('\n'));
  }

  test('returns empty, not an error, when the inbox folder does not exist yet', () => {
    const result = scanAndImportInbox({ db, inboxDir: path.join(dir, 'nope') });
    assert.deepEqual(result, { files: [], imported: 0, skipped: 0 });
  });

  test('imports a well-named GA4 export and moves it to the imported folder', () => {
    writeCsv('ga4-2026-11-17.csv', [
      'Page path and screen class,Sessions',
      '/industry-reports/foo,42',
    ]);

    const result = scanAndImportInbox({ db, inboxDir });
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.files[0]!.outcome, 'imported');
    assert.equal(result.files[0]!.rowsWritten, 1);

    assert.equal(fs.existsSync(path.join(inboxDir, 'ga4-2026-11-17.csv')), false);
    assert.equal(fs.existsSync(path.join(dir, 'imported', 'ga4-2026-11-17.csv')), true);

    const row = db.prepare('SELECT source FROM url_performance LIMIT 1').get() as any;
    assert.equal(row.source, 'ga4-manual');
  });

  test('imports a well-named GSC export, detected case-insensitively', () => {
    writeCsv('GSC_pages_2026-11-17 (3).csv', [
      'Top pages,Clicks',
      '/industry-reports/bar,7',
    ]);
    const result = scanAndImportInbox({ db, inboxDir });
    assert.equal(result.imported, 1);
    const row = db.prepare('SELECT source FROM url_performance LIMIT 1').get() as any;
    assert.equal(row.source, 'gsc-manual');
  });

  test('skips a file with no date, and leaves it in place', () => {
    writeCsv('ga4-export.csv', ['Page,Sessions', '/a,1']);
    const result = scanAndImportInbox({ db, inboxDir });
    assert.equal(result.skipped, 1);
    assert.match(result.files[0]!.reason!, /no YYYY-MM-DD date/);
    assert.equal(fs.existsSync(path.join(inboxDir, 'ga4-export.csv')), true);
  });

  test('skips a file with no recognisable source, and leaves it in place', () => {
    writeCsv('export-2026-11-17.csv', ['Page,Sessions', '/a,1']);
    const result = scanAndImportInbox({ db, inboxDir });
    assert.equal(result.skipped, 1);
    assert.match(result.files[0]!.reason!, /no "ga4"\/"gsc"/);
  });

  test('ignores non-csv files entirely', () => {
    fs.writeFileSync(path.join(inboxDir, 'notes.txt'), 'hello');
    const result = scanAndImportInbox({ db, inboxDir });
    assert.deepEqual(result, { files: [], imported: 0, skipped: 0 });
  });

  test('processes multiple files independently', () => {
    writeCsv('ga4-2026-11-16.csv', ['Page,Sessions', '/a,1']);
    writeCsv('gsc-2026-11-17.csv', ['Top pages,Clicks', '/b,2']);
    const result = scanAndImportInbox({ db, inboxDir });
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);
  });
});
