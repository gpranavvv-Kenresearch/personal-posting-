/**
 * db.ts — the intelligence store.
 *
 * Uses Node's BUILT-IN `node:sqlite` (Node 22.5+). This is deliberate: it
 * needs no new dependency and no native compile step, which removes the whole
 * better-sqlite3 build-toolchain risk on Windows.
 *
 * Location follows the same cwd rule as every other piece of runtime state,
 * so a development run (cwd = dev-sandbox) gets its own database and can never
 * touch production's. Override with INTELLIGENCE_DB_PATH.
 *
 * Safety (blueprint modification #5):
 *   - schema_migrations records what has been applied; migrations are
 *     append-only and run in a transaction.
 *   - backup() produces a consistent copy; restore() refuses a backup whose
 *     schema version is newer than this code understands.
 */

import path from 'path';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, LATEST_VERSION, type Migration } from './schema.js';

export type DB = DatabaseSync;

export function dbPath(): string {
  const override = (process.env.INTELLIGENCE_DB_PATH ?? '').trim();
  if (override) return path.resolve(override);
  return path.resolve('data', 'intelligence.db');
}

let cached: DatabaseSync | null = null;

export function openDb(file: string = dbPath()): DatabaseSync {
  if (cached && file === dbPath()) return cached;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  if (file === dbPath()) cached = db;
  return db;
}

export function closeDb(): void {
  if (cached) { cached.close(); cached = null; }
}

// ── Migrations ───────────────────────────────────────────────────────────────

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `);
}

export function currentVersion(db: DatabaseSync): number {
  ensureMigrationTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any;
  return (row?.v as number) ?? 0;
}

export function appliedVersions(db: DatabaseSync): number[] {
  ensureMigrationTable(db);
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as any[])
    .map(r => r.version as number);
}

/** Apply every migration not yet applied. Safe to call repeatedly. */
export function migrate(db: DatabaseSync, upTo: number = LATEST_VERSION): number {
  ensureMigrationTable(db);
  const done = new Set(appliedVersions(db));
  let applied = 0;

  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version > upTo || done.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
      applied++;
    } catch (err: any) {
      db.exec('ROLLBACK');
      throw new Error(`[db] Migration ${m.version} (${m.name}) failed, rolled back: ${err.message}`);
    }
  }
  return applied;
}

/**
 * Roll back to `targetVersion`, newest first. Refuses if any migration in the
 * range has no `down` — a partial rollback is worse than none.
 */
export function rollbackTo(db: DatabaseSync, targetVersion: number): number {
  ensureMigrationTable(db);
  const toUndo = [...MIGRATIONS]
    .filter(m => m.version > targetVersion && appliedVersions(db).includes(m.version))
    .sort((a, b) => b.version - a.version);

  const missing = toUndo.filter(m => !m.down);
  if (missing.length) {
    throw new Error(
      `[db] Cannot roll back to ${targetVersion}: migration(s) ` +
      `${missing.map(m => m.version).join(', ')} have no "down". Restore from a backup instead.`
    );
  }

  let undone = 0;
  for (const m of toUndo) {
    db.exec('BEGIN');
    try {
      db.exec(m.down!);
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(m.version);
      db.exec('COMMIT');
      undone++;
    } catch (err: any) {
      db.exec('ROLLBACK');
      throw new Error(`[db] Rollback of migration ${m.version} failed: ${err.message}`);
    }
  }
  return undone;
}

// ── Backup / restore ─────────────────────────────────────────────────────────

/** Consistent on-disk copy, using SQLite's own VACUUM INTO. */
export function backupDb(db: DatabaseSync, destFile: string): string {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (fs.existsSync(destFile)) fs.rmSync(destFile);
  db.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`);
  return destFile;
}

/**
 * Restore a database file over the live one.
 *
 * Refuses a backup whose schema version is NEWER than this code knows about:
 * running old code against a newer schema silently misreads data.
 */
export function restoreDb(backupFile: string, targetFile: string = dbPath()): void {
  if (!fs.existsSync(backupFile)) throw new Error(`[db] Backup not found: ${backupFile}`);

  const probe = new DatabaseSync(backupFile);
  let version = 0;
  try {
    const row = probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any;
    version = (row?.v as number) ?? 0;
  } catch {
    throw new Error(`[db] ${backupFile} has no schema_migrations table — not an intelligence database.`);
  } finally {
    probe.close();
  }

  if (version > LATEST_VERSION) {
    throw new Error(
      `[db] Backup is at schema version ${version} but this code understands up to ` +
      `${LATEST_VERSION}. Refusing to restore — upgrade the code first.`
    );
  }

  closeDb();
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  if (fs.existsSync(targetFile)) {
    fs.copyFileSync(targetFile, `${targetFile}.pre-restore`);
  }
  fs.copyFileSync(backupFile, targetFile);
  for (const suffix of ['-wal', '-shm']) {
    const f = `${targetFile}${suffix}`;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
}

// ── Small helpers used across the intelligence modules ───────────────────────

export function nowIso(): string { return new Date().toISOString(); }

export function isoDate(d: Date = new Date()): string { return d.toISOString().slice(0, 10); }

export function daysAgo(n: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Run `fn` inside a transaction, rolling back on throw. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Record the start of a collector run; returns its id. */
export function startRun(db: DatabaseSync, collector: string, windowStart?: string, windowEnd?: string): number {
  const r = db.prepare(
    `INSERT INTO collection_runs (collector, started_at, window_start, window_end, status)
     VALUES (?, ?, ?, ?, 'running')`
  ).run(collector, nowIso(), windowStart ?? null, windowEnd ?? null);
  return Number(r.lastInsertRowid);
}

export function finishRun(
  db: DatabaseSync,
  id: number,
  status: 'ok' | 'partial' | 'failed',
  rowsWritten = 0,
  error?: string,
): void {
  db.prepare(
    `UPDATE collection_runs SET finished_at = ?, status = ?, rows_written = ?, error = ? WHERE id = ?`
  ).run(nowIso(), status, rowsWritten, error ?? null, id);
}
