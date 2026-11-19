/**
 * restoreState.ts — restore runtime state from a backup (Milestone 0).
 *
 * Safety properties, in order of importance:
 *
 *  1. VALIDATE EVERYTHING FIRST. The whole backup is verified — manifest
 *     parses, every file present, every SHA-256 matches, every payload is
 *     valid JSON — before a single byte is written. A restore therefore
 *     either happens completely or not at all.
 *  2. STALE-LEDGER GUARD. slot-ledger.json records which of today's posting
 *     slots already ran. Restoring one from a different day either re-runs
 *     slots that already posted (duplicate posts on live accounts) or marks
 *     unposted slots done (silent loss). Refused without --force.
 *  3. REVERSIBLE. Current state is snapshotted into .pre-restore/ before
 *     anything is overwritten, so a restore can itself be undone.
 *  4. DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
 */

import fs from 'fs';
import path from 'path';
import { sha256, type BackupManifest } from './backupState.js';

export interface RestoreOptions {
  root: string;
  backupDir: string;
  apply?: boolean;
  force?: boolean;
  /** Injectable for tests; defaults to today in Asia/Kolkata (scheduler tz). */
  today?: string;
  preRestoreDir?: string;
}

export interface RestoreResult {
  ok: boolean;
  applied: boolean;
  errors: string[];
  warnings: string[];
  filesValidated: number;
  filesWritten: string[];
  preRestoreDir?: string;
}

/** Today's date in the scheduler's timezone, as YYYY-MM-DD. */
export function istToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Best-effort extraction of the date a slot-ledger belongs to. */
export function ledgerDateOf(parsed: any): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  for (const key of ['date', 'day', 'ledgerDate']) {
    const v = parsed[key];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  const keys = Object.keys(parsed).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
  return keys.length === 1 ? keys[0] : null;
}

export function restoreState(opts: RestoreOptions): RestoreResult {
  const root = path.resolve(opts.root);
  const backupDir = path.resolve(opts.backupDir);
  const errors: string[] = [];
  const warnings: string[] = [];
  const result: RestoreResult = {
    ok: false, applied: false, errors, warnings, filesValidated: 0, filesWritten: [],
  };

  // ── Phase 1: validate the ENTIRE backup. No writes in this phase. ──────────
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    errors.push(`No manifest.json in ${backupDir} — not a valid backup.`);
    return result;
  }

  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err: any) {
    errors.push(`manifest.json is not valid JSON: ${err.message}`);
    return result;
  }
  if (!Array.isArray(manifest.entries)) {
    errors.push('manifest.json has no "entries" array.');
    return result;
  }

  const staged: { relPath: string; buf: Buffer }[] = [];

  for (const entry of manifest.entries) {
    const src = path.join(backupDir, entry.relPath);
    if (!fs.existsSync(src)) { errors.push(`Missing from backup: ${entry.relPath}`); continue; }

    const buf = fs.readFileSync(src);
    const actual = sha256(buf);
    if (actual !== entry.sha256) {
      errors.push(`Checksum mismatch for ${entry.relPath} (backup is corrupt or was edited).`);
      continue;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(buf.toString('utf-8'));
    } catch (err: any) {
      errors.push(`${entry.relPath} is not valid JSON: ${err.message}`);
      continue;
    }

    // Stale-ledger guard.
    if (path.posix.basename(entry.relPath) === 'slot-ledger.json') {
      const ledgerDate = ledgerDateOf(parsed);
      const today = opts.today ?? istToday();
      if (ledgerDate && ledgerDate !== today) {
        const msg =
          `slot-ledger.json is dated ${ledgerDate} but today is ${today}. ` +
          `Restoring it risks re-running slots that already posted, or marking ` +
          `unposted slots as done.`;
        if (opts.force) warnings.push(`${msg} Proceeding because --force was given.`);
        else errors.push(`${msg} Refusing without --force.`);
      } else if (!ledgerDate) {
        warnings.push('Could not determine slot-ledger.json\'s date; stale check skipped.');
      }
    }

    staged.push({ relPath: entry.relPath, buf });
    result.filesValidated++;
  }

  if (errors.length) return result;   // validation failed — nothing written
  result.ok = true;
  if (!opts.apply) return result;     // dry run

  // ── Phase 2: snapshot current state, then write. ───────────────────────────
  const preRestoreDir = path.resolve(
    opts.preRestoreDir ?? path.join(root, '.pre-restore', new Date().toISOString().replace(/[:.]/g, '-')),
  );
  for (const { relPath } of staged) {
    const live = path.join(root, relPath);
    if (!fs.existsSync(live)) continue;
    const dest = path.join(preRestoreDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(live, dest);
  }
  result.preRestoreDir = preRestoreDir;

  for (const { relPath, buf } of staged) {
    const dest = path.join(root, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    result.filesWritten.push(relPath);
  }
  result.applied = true;
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('restoreState.ts') || process.argv[1]?.endsWith('restoreState.js')) {
  const argv = process.argv.slice(2);
  const fromIdx = argv.indexOf('--from');
  if (fromIdx === -1 || !argv[fromIdx + 1]) {
    console.error('Usage: restoreState --from backups/<timestamp> [--apply] [--force]');
    process.exit(1);
  }
  const res = restoreState({
    root: process.cwd(),
    backupDir: argv[fromIdx + 1],
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
  });
  for (const w of res.warnings) console.warn(`⚠️  ${w}`);
  for (const e of res.errors) console.error(`❌ ${e}`);
  if (!res.ok) { console.error('\nRestore ABORTED. Nothing was written.'); process.exit(1); }
  if (!res.applied) console.log(`✅ Dry run OK: ${res.filesValidated} file(s) validated. Re-run with --apply to write.`);
  else {
    console.log(`✅ Restored ${res.filesWritten.length} file(s). Previous state: ${res.preRestoreDir}`);
  }
}
