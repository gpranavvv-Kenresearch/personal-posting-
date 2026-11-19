/**
 * Tests for src/intelligence/dashboard.ts — the static HTML tracker page.
 *
 * Scope: buildDashboardData never throws on an empty database, flags are
 * respected (sections say "off", not crash, when a feature is disabled),
 * and renderDashboardHtml always produces a renderable page. No test here
 * checks pixel layout — the dataviz skill's job is the spec, this just
 * guards against a broken template string shipping silently.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type DB } from '../../src/intelligence/db.js';
import { buildDashboardData, renderDashboardHtml, writeDashboard } from '../../src/intelligence/dashboard.js';

describe('dashboard', () => {
  let dir: string;
  let db: DB;
  let savedFlags: Record<string, string | undefined>;

  const FLAG_NAMES = [
    'FEATURE_INTELLIGENCE', 'FEATURE_PLATFORM_INTELLIGENCE',
    'FEATURE_OPPORTUNITY_SCORING', 'FEATURE_CONTENT_INTELLIGENCE',
  ];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
    db = openDb(path.join(dir, 'test.db'));
    savedFlags = {};
    for (const f of FLAG_NAMES) { savedFlags[f] = process.env[f]; delete process.env[f]; }
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of FLAG_NAMES) {
      if (savedFlags[f] === undefined) delete process.env[f];
      else process.env[f] = savedFlags[f];
    }
  });

  test('builds and renders on a completely empty database with every flag off', () => {
    const inboxDir = path.join(dir, 'inbox');
    const data = buildDashboardData({ db, inboxDir, generatedAt: '2026-11-17T00:00:00.000Z' });
    assert.equal(data.trackedReports, 0);
    assert.equal(data.platforms.length, 0);
    assert.equal(data.scores.length, 0);
    assert.equal(data.bestNextMove, null);
    assert.equal(data.pendingApprovals, 0);

    const html = renderDashboardHtml(data);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /Distribution Tracker/);
    assert.match(html, /FEATURE_PLATFORM_INTELLIGENCE is off/);
    assert.match(html, /FEATURE_OPPORTUNITY_SCORING is off/);
  });

  test('picks up a dropped GA4 export and reflects it in the inbox summary', () => {
    const inboxDir = path.join(dir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'ga4-2026-11-17.csv'), [
      'Page path and screen class,Sessions',
      '/industry-reports/foo,10',
    ].join('\n'));

    const data = buildDashboardData({ db, inboxDir });
    assert.equal(data.inbox.imported, 1);
    const html = renderDashboardHtml(data);
    assert.match(html, /ga4-2026-11-17\.csv/);
    assert.match(html, /IMPORTED/);
  });

  test('never includes raw secrets, only masked credential status', () => {
    process.env.PIPEDRIVE_API_TOKEN = 'super-secret-token-value';
    const data = buildDashboardData({ db, inboxDir: path.join(dir, 'inbox') });
    const html = renderDashboardHtml(data);
    assert.equal(html.includes('super-secret-token-value'), false);
    delete process.env.PIPEDRIVE_API_TOKEN;
  });

  test('escapes HTML in a hostile report URL rather than injecting it', () => {
    process.env.FEATURE_INTELLIGENCE = '1';
    process.env.FEATURE_OPPORTUNITY_SCORING = '1';
    const hostileUrl = 'https://www.kenresearch.com/<script>alert(1)</script>';
    db.prepare(
      `INSERT INTO published_posts (report_url, platform, published_url, posted_at, created_at)
       VALUES (?, 'hackmd', 'https://hackmd.io/x', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`,
    ).run(hostileUrl);

    const data = buildDashboardData({ db, inboxDir: path.join(dir, 'inbox') });
    const html = renderDashboardHtml(data);
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.match(html, /&lt;script&gt;/);
  });

  test('writeDashboard creates the output directory and a readable file', () => {
    const data = buildDashboardData({ db, inboxDir: path.join(dir, 'inbox') });
    const outFile = path.join(dir, 'nested', 'out', 'dashboard.html');
    writeDashboard(data, outFile);
    assert.equal(fs.existsSync(outFile), true);
    assert.match(fs.readFileSync(outFile, 'utf8'), /Distribution Tracker/);
  });
});
