/**
 * selectUrlsForIndexCheck — the budgeted, two-priority URL picker that lets
 * a fixed daily SERP budget cover a backlog many times larger than itself
 * (see docs/INTELLIGENCE-RUNBOOK.md, "Sizing the indexation check budget").
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type DB } from '../../src/intelligence/db.js';
import { recordCheck } from '../../src/intelligence/indexation.js';
import { selectUrlsForIndexCheck } from '../../src/intelligence/reporting.js';

const tempDirs: string[] = [];
function tempDb(): DB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporting-test-'));
  tempDirs.push(dir);
  return openDb(path.join(dir, 'intelligence.db'));
}
afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
});

function insertPost(db: DB, url: string, postedAt: string): void {
  db.prepare(
    `INSERT INTO published_posts (report_url, platform, published_url, posted_at, created_at)
     VALUES ('https://www.kenresearch.com/report', 'hackmd', ?, ?, ?)`,
  ).run(url, postedAt, postedAt);
}

describe('selectUrlsForIndexCheck', () => {
  test('returns nothing from an empty database', () => {
    const db = tempDb();
    assert.deepEqual(selectUrlsForIndexCheck(db, { newBudget: 5, backlogBudget: 5 }), []);
  });

  test('new-budget slots go to the most recently posted URLs', () => {
    const db = tempDb();
    insertPost(db, 'https://hackmd.io/old', '2020-01-01T00:00:00.000Z');
    insertPost(db, 'https://hackmd.io/new', new Date().toISOString());
    const picked = selectUrlsForIndexCheck(db, { newBudget: 1, backlogBudget: 0 });
    assert.deepEqual(picked.map(p => p.url), ['https://hackmd.io/new']);
  });

  test('backlog-budget slots prefer never-checked, then oldest-checked', () => {
    const db = tempDb();
    insertPost(db, 'https://hackmd.io/never-checked', '2020-01-01T00:00:00.000Z');
    insertPost(db, 'https://hackmd.io/checked-long-ago', '2020-01-01T00:00:00.000Z');
    insertPost(db, 'https://hackmd.io/checked-recently', '2020-01-01T00:00:00.000Z');

    recordCheck(db, 'https://hackmd.io/checked-long-ago', 'hackmd', 'serpapi',
      { status: 'indexed', confidence: 0.95, evidence: 'x', rawHitCount: 1 }, '2024-01-01T00:00:00.000Z');
    recordCheck(db, 'https://hackmd.io/checked-recently', 'hackmd', 'serpapi',
      { status: 'indexed', confidence: 0.95, evidence: 'x', rawHitCount: 1 }, '2026-11-10T00:00:00.000Z');

    const picked = selectUrlsForIndexCheck(db, { newBudget: 0, backlogBudget: 2 });
    assert.deepEqual(picked.map(p => p.url), [
      'https://hackmd.io/never-checked',
      'https://hackmd.io/checked-long-ago',
    ]);
  });

  test('a URL already claimed by the new-budget half is not double-counted in the backlog half', () => {
    const db = tempDb();
    const recent = new Date().toISOString();
    insertPost(db, 'https://hackmd.io/recent-and-unchecked', recent);
    insertPost(db, 'https://hackmd.io/other', '2020-01-01T00:00:00.000Z');

    const picked = selectUrlsForIndexCheck(db, { newBudget: 1, backlogBudget: 5, newWindowDays: 30 });
    const urls = picked.map(p => p.url);
    assert.equal(urls.filter(u => u === 'https://hackmd.io/recent-and-unchecked').length, 1);
    assert.ok(urls.includes('https://hackmd.io/other'));
  });

  test('matches indexation_checks rows keyed by the normalised url, not the raw one', () => {
    const db = tempDb();
    insertPost(db, 'https://www.hackmd.io/path/', '2020-01-01T00:00:00.000Z');
    // recordCheck stores the NORMALISED key (no scheme, no www, no trailing
    // slash) — this is what a real run would have written for that same url.
    recordCheck(db, 'https://www.hackmd.io/path/', 'hackmd', 'serpapi',
      { status: 'indexed', confidence: 0.95, evidence: 'x', rawHitCount: 1 }, '2026-11-01T00:00:00.000Z');
    insertPost(db, 'https://hackmd.io/never-checked', '2020-01-01T00:00:00.000Z');

    const picked = selectUrlsForIndexCheck(db, { newBudget: 0, backlogBudget: 1 });
    // If the join failed to normalise, the checked url would wrongly look
    // "never checked" and win the single backlog slot instead.
    assert.deepEqual(picked.map(p => p.url), ['https://hackmd.io/never-checked']);
  });
});
