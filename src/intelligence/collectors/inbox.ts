/**
 * inbox.ts — auto-import GA4/GSC CSVs dropped in a folder.
 *
 * Built for the "runs on my own machine, I drop files in, it just updates"
 * workflow: export a CSV from the GA4/GSC website (see
 * docs/INTELLIGENCE-RUNBOOK.md) and drop it into the inbox folder. This
 * scans that folder, infers {source, date} from the filename, imports via
 * manualImport.ts, and moves the file into an "imported" folder so a
 * scheduled run never reprocesses it. (Reprocessing the same file would be
 * harmless too — importManualExportFile is idempotent by date — moving it
 * just keeps the inbox honest about what's left to look at.)
 *
 * Filename convention: must contain "ga4" or "gsc" (case-insensitive) AND a
 * YYYY-MM-DD date, e.g. "ga4-2026-11-17.csv" or
 * "GSC_pages_2026-11-17 (3).csv". A file missing either part is left exactly
 * where it is and reported as skipped with the reason — never guessed at.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db.js';
import { importManualExportFile, type ManualImportSource } from './manualImport.js';

export interface InboxOptions {
  db: DB;
  inboxDir: string;
  /** Defaults to a sibling "imported" folder next to inboxDir. */
  importedDir?: string;
  domain?: string;
}

export interface InboxFileResult {
  file: string;
  outcome: 'imported' | 'skipped';
  reason?: string;
  rowsParsed?: number;
  rowsWritten?: number;
}

export interface InboxResult {
  files: InboxFileResult[];
  imported: number;
  skipped: number;
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

function detectSource(name: string): ManualImportSource | null {
  const lower = name.toLowerCase();
  if (lower.includes('gsc') || lower.includes('search-console') || lower.includes('searchconsole')) return 'gsc-manual';
  if (lower.includes('ga4') || lower.includes('analytics')) return 'ga4-manual';
  return null;
}

export function scanAndImportInbox(opts: InboxOptions): InboxResult {
  const importedDir = opts.importedDir ?? path.join(path.dirname(opts.inboxDir), 'imported');
  const files: InboxFileResult[] = [];

  if (!fs.existsSync(opts.inboxDir)) {
    return { files, imported: 0, skipped: 0 };
  }

  const entries = fs.readdirSync(opts.inboxDir).filter(f => f.toLowerCase().endsWith('.csv'));
  for (const name of entries) {
    const full = path.join(opts.inboxDir, name);
    const dateMatch = name.match(DATE_RE);
    const source = detectSource(name);

    if (!source || !dateMatch) {
      files.push({
        file: name,
        outcome: 'skipped',
        reason: !source && !dateMatch
          ? 'filename has neither a recognisable source (ga4/gsc) nor a date (YYYY-MM-DD)'
          : !source
            ? 'filename has a date but no "ga4"/"gsc" in it — rename to e.g. "ga4-2026-11-17.csv"'
            : 'filename has a source but no YYYY-MM-DD date — rename to e.g. "ga4-2026-11-17.csv"',
      });
      continue;
    }

    let result;
    try {
      result = importManualExportFile(opts.db, full, {
        source,
        metricDate: dateMatch[1]!,
        ...(opts.domain ? { domain: opts.domain } : {}),
      });
    } catch (err: any) {
      files.push({ file: name, outcome: 'skipped', reason: `import failed: ${err?.message ?? String(err)}` });
      continue;
    }

    fs.mkdirSync(importedDir, { recursive: true });
    fs.renameSync(full, path.join(importedDir, name));
    files.push({
      file: name,
      outcome: 'imported',
      rowsParsed: result.rowsParsed,
      rowsWritten: result.rowsWritten,
    });
  }

  return {
    files,
    imported: files.filter(f => f.outcome === 'imported').length,
    skipped: files.filter(f => f.outcome === 'skipped').length,
  };
}
