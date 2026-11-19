/**
 * backupState.ts — back up critical runtime state (Milestone 0).
 *
 * Scope is deliberately narrow: the small JSON files that encode "what has
 * already happened". Losing these causes duplicate posts or silently skipped
 * slots, and none of them can be reconstructed.
 *
 * NOT backed up:
 *   - Chrome persistent profiles under .sessions/<platform>/ — large, and
 *     rebuildable by logging in again.
 *   - .accounts/ — credentials. They need separate, offline handling and must
 *     never be copied into a repository-adjacent folder.
 *
 * Every path is relative to an injectable `root`, so tests run entirely in a
 * temporary directory and never read or write real production state.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Files relative to root. Globs are not used; .sessions/*.json is expanded. */
export const LOG_STATE_FILES = [
  'logs/error-kb.json',
  'logs/.monitor-state.json',
] as const;

export interface BackupManifestEntry {
  relPath: string;
  sha256: string;
  bytes: number;
}

export interface BackupManifest {
  createdAt: string;
  root: string;
  fileCount: number;
  entries: BackupManifestEntry[];
}

export interface BackupResult {
  backupDir: string;
  manifest: BackupManifest;
  skipped: string[];
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Top-level .json files in .sessions/ (never recurses into Chrome profiles). */
export function listSessionStateFiles(root: string): string[] {
  const dir = path.join(root, '.sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.json'))
    .map(e => path.posix.join('.sessions', e.name))
    .sort();
}

export function collectStateFiles(root: string): string[] {
  return [...listSessionStateFiles(root), ...LOG_STATE_FILES];
}

export function backupState(opts: { root: string; backupsDir?: string; now?: Date }): BackupResult {
  const root = path.resolve(opts.root);
  const backupsRoot = path.resolve(opts.backupsDir ?? path.join(root, 'backups'));
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupsRoot, stamp);

  const entries: BackupManifestEntry[] = [];
  const skipped: string[] = [];

  for (const rel of collectStateFiles(root)) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) { skipped.push(rel); continue; }
    const buf = fs.readFileSync(src);
    const dest = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    entries.push({ relPath: rel, sha256: sha256(buf), bytes: buf.length });
  }

  const manifest: BackupManifest = {
    createdAt: (opts.now ?? new Date()).toISOString(),
    root,
    fileCount: entries.length,
    entries,
  };
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return { backupDir, manifest, skipped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('backupState.ts') || process.argv[1]?.endsWith('backupState.js')) {
  const result = backupState({ root: process.cwd() });
  console.log(`Backed up ${result.manifest.fileCount} file(s) -> ${result.backupDir}`);
  for (const e of result.manifest.entries) console.log(`   ${e.relPath} (${e.bytes} bytes)`);
  if (result.skipped.length) console.log(`   skipped (absent): ${result.skipped.join(', ')}`);
}
