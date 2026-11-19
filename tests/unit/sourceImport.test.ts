import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../src/intelligence/db.js';
import { canonicalSource, looksLikeSourceExport, importSourceExport } from '../../src/intelligence/collectors/sourceImport.js';

describe('canonicalSource', () => {
  test('folds case, trailing slash, domains and aliases onto the platform utm source', () => {
    assert.equal(canonicalSource('Blogger'), 'blogger');
    assert.equal(canonicalSource('medium.com'), 'medium');
    assert.equal(canonicalSource('linkedin/'), 'linkedin');
    assert.equal(canonicalSource('l.facebook.com'), 'facebook');
    assert.equal(canonicalSource('Twitter'), 'x');
    assert.equal(canonicalSource('SEOutm_medium=SEOutm_campaign=Naman'), 'seo');
  });
  test('linkedin.com is plain LinkedIn, explicit linkedin-pulse stays Pulse', () => {
    assert.equal(canonicalSource('linkedin.com'), 'linkedin');
    assert.equal(canonicalSource('linkedin-pulse'), 'linkedin-pulse');
  });
});

describe('importSourceExport', () => {
  const csv = [
    '# ---', '# Ken Research - GA4', '# ---', '',
    'Session source,Sessions,Engaged sessions',
    ',100,50,Grand total',
    'Blogger,10,5', 'blogger,5,2', '(direct),80,40',
  ].join('\n');
  test('is detected, and sums case variants into one row per platform', () => {
    assert.equal(looksLikeSourceExport(csv), true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-import-'));
    const db = openDb(path.join(dir, 'i.db'));
    const r = importSourceExport(db, csv, '2026-11-17');
    assert.equal(r.matchedPlatforms['blogger'], 15);
    assert.equal(r.unmatchedSessions, 80);
    const row = db.prepare(`SELECT sessions FROM url_performance WHERE metric_scope='utm_source' AND dimension_value='blogger'`).get() as any;
    assert.equal(row.sessions, 15);
  });
  test('a page-level export is not mistaken for a source export', () => {
    assert.equal(looksLikeSourceExport('Page path and screen class,Sessions\n/a,1'), false);
  });
});
