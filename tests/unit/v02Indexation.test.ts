import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/intelligence/db.js';
import { importV02Indexation } from '../../src/intelligence/collectors/v02Indexation.js';

function makeV02(dir: string): string {
  const p = path.join(dir, 'state.db');
  const v = new DatabaseSync(p);
  v.exec(`CREATE TABLE urls (url TEXT, canonical_url TEXT, html_state TEXT, html_indexed TEXT,
          html_last_check TEXT, verified_on TEXT, html_cov TEXT)`);
  const ins = v.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,?)');
  ins.run('https://www.kenresearch.com/a-market', null, 'INDEXED', '2026-11-12', '2026-11-12', null, null);
  ins.run('https://www.kenresearch.com/industry-reports/b-market', null, 'STALLED', null, '2026-11-13', null, 'Crawled - currently not indexed');
  ins.run('https://www.kenresearch.com/c-market', null, null, null, null, null, null);
  v.close();
  return p;
}

describe('importV02Indexation', () => {
  test('maps verdicts, matches by slug, skips uninspected, and never modifies the V0.2 file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v02-'));
    const v02 = makeV02(dir);
    const before = fs.readFileSync(v02);
    const db = openDb(path.join(dir, 'intel.db'));
    const ins = db.prepare(`INSERT INTO published_posts (report_url, platform, published_url, posted_at, created_at) VALUES (?, 'hackmd', ?, '2026-11-01', '2026-11-01')`);
    ins.run('https://www.kenresearch.com/a-market', 'https://hackmd.io/a');
    ins.run('https://www.kenresearch.com/b-market', 'https://hackmd.io/b'); // matched via slug
    ins.run('https://www.kenresearch.com/c-market', 'https://hackmd.io/c'); // never inspected
    ins.run('https://www.kenresearch.com/d-market', 'https://hackmd.io/d'); // not in V0.2 at all
    const r = importV02Indexation(db, v02);
    assert.deepEqual(r.recorded, { indexed: 1, not_indexed: 1 });
    assert.equal(r.matched, 3);
    assert.equal(r.skipped, 2);
    assert.ok(before.equals(fs.readFileSync(v02)), 'V0.2 state.db must be byte-for-byte unchanged');
  });
});
