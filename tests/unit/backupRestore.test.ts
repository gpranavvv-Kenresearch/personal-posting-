/**
 * Backup and restore. Operates ONLY inside os.tmpdir(); real runtime state is
 * never read, copied or modified.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { backupState, collectStateFiles } from '../../src/tools/backupState.js';
import { restoreState, ledgerDateOf, istToday } from '../../src/tools/restoreState.js';

let root: string;

function write(rel: string, data: unknown) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function read(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ken-m0-'));
  write('.sessions/slot-ledger.json', { date: istToday(), slots: { '10:30': 'done' } });
  write('.sessions/batch-counters.json', { fb: 3, li: 1 });
  write('logs/error-kb.json', { entries: [] });
  // A Chrome profile directory that must NOT be swept into the backup.
  fs.mkdirSync(path.join(root, '.sessions', 'twitter-profile'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sessions', 'twitter-profile', 'Cookies'), 'binary-ish');
  // Credentials that must NOT be backed up.
  fs.mkdirSync(path.join(root, '.accounts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.accounts', 'google-service-account.json'),
    '{"private_key":"SECRET"}',
  );
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('backup scope', () => {
  test('captures top-level .sessions json and log state', () => {
    const files = collectStateFiles(root);
    assert.ok(files.includes('.sessions/slot-ledger.json'));
    assert.ok(files.includes('.sessions/batch-counters.json'));
    assert.ok(files.includes('logs/error-kb.json'));
  });

  test('never descends into Chrome profile directories', () => {
    const files = collectStateFiles(root);
    assert.ok(!files.some(f => f.includes('twitter-profile')));
  });

  test('never includes credentials', () => {
    const { manifest } = backupState({ root });
    assert.ok(!manifest.entries.some(e => e.relPath.includes('.accounts')));
  });
});

describe('round trip', () => {
  test('backup then mutate then restore reproduces the original', () => {
    const { backupDir } = backupState({ root });
    const before = read('.sessions/batch-counters.json');

    write('.sessions/batch-counters.json', { fb: 999, li: 999 });
    assert.notDeepEqual(read('.sessions/batch-counters.json'), before);

    const res = restoreState({ root, backupDir, apply: true });
    assert.ok(res.ok, res.errors.join('; '));
    assert.ok(res.applied);
    assert.deepEqual(read('.sessions/batch-counters.json'), before);
  });

  test('a dry run writes nothing', () => {
    const { backupDir } = backupState({ root });
    write('.sessions/batch-counters.json', { fb: 999 });
    const res = restoreState({ root, backupDir });
    assert.ok(res.ok);
    assert.equal(res.applied, false);
    assert.deepEqual(read('.sessions/batch-counters.json'), { fb: 999 });
  });

  test('previous state is snapshotted to .pre-restore before overwriting', () => {
    const { backupDir } = backupState({ root });
    write('.sessions/batch-counters.json', { fb: 999 });
    const res = restoreState({ root, backupDir, apply: true });
    const snap = path.join(res.preRestoreDir!, '.sessions', 'batch-counters.json');
    assert.ok(fs.existsSync(snap));
    assert.deepEqual(JSON.parse(fs.readFileSync(snap, 'utf-8')), { fb: 999 });
  });
});

describe('validation happens before any write', () => {
  test('a corrupted file aborts the whole restore', () => {
    const { backupDir } = backupState({ root });
    fs.writeFileSync(
      path.join(backupDir, '.sessions', 'batch-counters.json'),
      '{"fb":1234}',
    );
    const liveLedger = read('.sessions/slot-ledger.json');

    const res = restoreState({ root, backupDir, apply: true });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /Checksum mismatch/);
    assert.equal(res.filesWritten.length, 0);
    assert.deepEqual(read('.sessions/slot-ledger.json'), liveLedger);
  });

  test('invalid JSON in a backup aborts', () => {
    const { backupDir } = backupState({ root });
    const target = path.join(backupDir, '.sessions', 'batch-counters.json');
    const bad = Buffer.from('{not json', 'utf-8');
    fs.writeFileSync(target, bad);

    // Re-point the manifest hash so the JSON check is what trips, not the hash.
    const mPath = path.join(backupDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
    for (const e of m.entries) {
      if (e.relPath.endsWith('batch-counters.json')) {
        e.sha256 = crypto.createHash('sha256').update(bad).digest('hex');
      }
    }
    fs.writeFileSync(mPath, JSON.stringify(m));

    const res = restoreState({ root, backupDir, apply: true });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /not valid JSON/);
    assert.equal(res.filesWritten.length, 0);
  });

  test('a missing manifest is rejected', () => {
    const { backupDir } = backupState({ root });
    fs.rmSync(path.join(backupDir, 'manifest.json'));
    const res = restoreState({ root, backupDir, apply: true });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /No manifest/);
  });
});

describe('stale-ledger guard', () => {
  test('refuses a ledger from another day without force', () => {
    write('.sessions/slot-ledger.json', { date: '2020-01-01', slots: {} });
    const { backupDir } = backupState({ root });
    const res = restoreState({ root, backupDir, apply: true, today: '2026-11-13' });
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /dated 2020-01-01/);
    assert.equal(res.filesWritten.length, 0);
  });

  test('force allows it but records a warning', () => {
    write('.sessions/slot-ledger.json', { date: '2020-01-01', slots: {} });
    const { backupDir } = backupState({ root });
    const res = restoreState({
      root, backupDir, apply: true, force: true, today: '2026-11-13',
    });
    assert.ok(res.ok, res.errors.join('; '));
    assert.match(res.warnings.join(' '), /force/);
  });

  test('same-day ledger restores without complaint', () => {
    write('.sessions/slot-ledger.json', { date: '2026-11-13', slots: {} });
    const { backupDir } = backupState({ root });
    const res = restoreState({ root, backupDir, apply: true, today: '2026-11-13' });
    assert.ok(res.ok, res.errors.join('; '));
  });

  test('ledgerDateOf reads the common shapes', () => {
    assert.equal(ledgerDateOf({ date: '2026-11-13' }), '2026-11-13');
    assert.equal(ledgerDateOf({ '2026-11-13': { a: 1 } }), '2026-11-13');
    assert.equal(ledgerDateOf({ nothing: true }), null);
  });
});
