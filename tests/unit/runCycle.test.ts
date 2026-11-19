/**
 * The scheduler-facing entry point.
 *
 * These tests exist to protect one property above all others: wiring this into
 * the live scheduler must be unable to harm posting. So they assert that with
 * flags off it does literally nothing, and that a failing stage is contained
 * rather than propagated.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runIntelligenceCycle, formatCycleResult } from '../../src/intelligence/runCycle.js';
import { openDb } from '../../src/intelligence/db.js';

const SAVED = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('FEATURE_')) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
});

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-cycle-'));
  return { dir, db: openDb(path.join(dir, 'x.db')) };
}

describe('disabled by default', () => {
  test('does nothing at all when FEATURE_INTELLIGENCE is unset', async () => {
    delete process.env.FEATURE_INTELLIGENCE;
    const r = await runIntelligenceCycle();
    assert.equal(r.enabled, false);
    assert.equal(r.stages.length, 0, 'no stage may even be attempted');
    assert.match(r.summary, /nothing was done/);
  });

  test('does not create a database when disabled', async () => {
    delete process.env.FEATURE_INTELLIGENCE;
    const probe = path.join(os.tmpdir(), `ken-should-not-exist-${process.pid}.db`);
    process.env.INTELLIGENCE_DB_PATH = probe;
    await runIntelligenceCycle();
    assert.equal(fs.existsSync(probe), false, 'a disabled cycle must not touch the disk');
    delete process.env.INTELLIGENCE_DB_PATH;
  });

  test('returns a result object rather than throwing', async () => {
    delete process.env.FEATURE_INTELLIGENCE;
    const r = await runIntelligenceCycle();
    assert.ok(r.startedAt && r.finishedAt);
    assert.ok(typeof r.summary === 'string');
  });
});

describe('enabled but every sub-feature off', () => {
  test('all stages are skipped with a stated reason, none error', async () => {
    process.env.FEATURE_INTELLIGENCE = 'true';
    const { dir, db } = tempDb();
    try {
      const r = await runIntelligenceCycle({ db });
      assert.equal(r.enabled, true);
      assert.ok(r.stages.length > 0, 'stages are enumerated');

      const errored = r.stages.filter(s => s.error);
      assert.deepEqual(errored, [], 'no stage may error merely from being disabled');

      // 'ingest-sheet' runs under the master flag; the rest need their own.
      const skipped = r.stages.filter(s => !s.ran);
      assert.ok(skipped.length >= r.stages.length - 1);
      for (const s of skipped) {
        assert.ok(s.skippedReason, `${s.stage} must say why it was skipped`);
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('failure containment', () => {
  test('a stage that throws is recorded, and the cycle still completes', async () => {
    process.env.FEATURE_INTELLIGENCE = 'true';
    process.env.FEATURE_OPPORTUNITY_SCORING = 'true';

    const { dir, db } = tempDb();
    try {
      // Break the table scoring reads so its stage throws.
      db.exec('DROP TABLE published_posts');

      const r = await runIntelligenceCycle({ db });
      // The cycle itself must not reject.
      assert.equal(r.enabled, true);

      const scoring = r.stages.find(s => s.stage === 'scoring')!;
      assert.ok(scoring.error, 'the broken stage should record an error');
      assert.equal(scoring.ran, false);

      // Later stages still ran or skipped normally — one failure must not abort.
      const after = r.stages.slice(r.stages.indexOf(scoring) + 1);
      assert.ok(after.length > 0, 'stages after a failure are still attempted');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unopenable database is reported, not thrown', async () => {
    process.env.FEATURE_INTELLIGENCE = 'true';
    // A path that cannot be created (a file used as a directory).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-bad-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    process.env.INTELLIGENCE_DB_PATH = path.join(blocker, 'nested', 'x.db');
    try {
      const r = await runIntelligenceCycle();
      assert.equal(r.stages.length, 0);
      assert.match(r.summary, /database|Could not open/i);
    } finally {
      delete process.env.INTELLIGENCE_DB_PATH;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shadow mode', () => {
  test('shadow mode is reported in the summary so it is never a surprise', async () => {
    process.env.FEATURE_INTELLIGENCE = 'true';
    process.env.FEATURE_SHADOW_MODE = 'true';
    const { dir, db } = tempDb();
    try {
      const r = await runIntelligenceCycle({ db });
      assert.match(r.summary, /SHADOW MODE/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('interlink application is blocked by shadow mode even with its flag on', async () => {
    process.env.FEATURE_INTELLIGENCE = 'true';
    process.env.FEATURE_INTERLINKING_APPLY = 'true';
    process.env.FEATURE_SHADOW_MODE = 'true';
    const { dir, db } = tempDb();
    try {
      const r = await runIntelligenceCycle({ db });
      const apply = r.stages.find(s => s.stage === 'interlink-apply')!;
      assert.ok(apply, 'the apply stage is present');
      assert.ok(
        !apply.ran || /shadow/i.test(apply.detail ?? ''),
        'shadow mode must prevent any external change',
      );
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reporting', () => {
  test('formats a readable multi-line report', async () => {
    delete process.env.FEATURE_INTELLIGENCE;
    const text = formatCycleResult(await runIntelligenceCycle());
    assert.match(text, /\[intelligence\]/);
  });
});
