import fs from 'fs';
import path from 'path';

const SEEN_FILE = path.resolve('.sessions/report-watcher-seen.json');

export interface SeenEntry {
  lastmod: string;
  type: string;
  firstSeenAt: string; // ISO timestamp — when this watcher first recorded the URL
}

export type SeenStore = Record<string, SeenEntry>;

export function isBootstrap(): boolean {
  return !fs.existsSync(SEEN_FILE);
}

export function loadSeenStore(): SeenStore {
  if (!fs.existsSync(SEEN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch {
    return {}; // corrupt file — treat as bootstrap rather than crash
  }
}

export function saveSeenStore(store: SeenStore): void {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(store, null, 2));
}
