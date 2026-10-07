import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectMajorRules } from './lib/detector.mjs';
import { redactSecrets } from './lib/security.mjs';
import { appendGuardianEvents } from './lib/google-sheet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const privateConfigFile = path.join(here, 'observer.config.json');
const queueFile = path.join(here, 'observer-data', 'outbox.json');
const sheetQueueFile = path.join(here, 'observer-data', 'sheet-outbox.json');
const stateFile = path.join(here, 'observer-data', 'state.json');
const emittedFile = path.join(here, 'observer-data', 'emitted.json');

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

async function loadConfig() {
  const file = await readJson(privateConfigFile, {});
  return {
    controlUrl: String(process.env.AI_GUARDIAN_CONTROL_URL || file.controlUrl || '').replace(/\/$/, ''),
    sharedSecret: String(process.env.AI_GUARDIAN_SHARED_SECRET || file.sharedSecret || ''),
    sourceName: String(process.env.AI_GUARDIAN_SOURCE_NAME || file.sourceName || 'posting-laptop'),
    pollSeconds: Math.max(30, Number(process.env.AI_GUARDIAN_POLL_SECONDS || file.pollSeconds || 60)),
    sheetReporting: file.sheetReporting === true,
    spreadsheetId: String(file.spreadsheetId || ''),
    sheetTab: String(file.sheetTab || 'AI Guardian'),
  };
}

async function runtimeSnapshot() {
  const heartbeat = await readJson(path.join(projectRoot, '.sessions', 'heartbeat.json'));
  const counters = await readJson(path.join(projectRoot, '.sessions', 'batch-counters.json'));
  const ledger = await readJson(path.join(projectRoot, '.sessions', 'slot-ledger.json'));
  return { heartbeat, counters, ledger };
}

async function recentLogEvents() {
  const candidates = ['logs/runtime.log', 'logs/errors.json'];
  const patterns = [
    { regex: /rate.?limit|\b429\b/i, type: 'rate_limit', title: 'API rate limit detected' },
    { regex: /logged.?out|login required|session expired|unauthorized|\b401\b/i, type: 'session_or_login', title: 'Login or session failure detected' },
    { regex: /page.*does not exist|against.*guideline|restrict.*access|account.*block/i, type: 'platform_access_restricted', title: 'Platform access restriction detected' },
    { regex: /timeout|timed out|target closed/i, type: 'browser_timeout', title: 'Browser timeout or closed target detected' },
  ];
  const state = await readJson(stateFile, { logHashes: [] });
  const known = new Set(state.logHashes || []);
  const nextHashes = [];
  const events = [];
  for (const relative of candidates) {
    try {
      const text = redactSecrets(await fs.readFile(path.join(projectRoot, relative), 'utf8'));
      for (const line of text.split(/\r?\n/).slice(-500)) {
        if (!line.trim()) continue;
        const hash = crypto.createHash('sha256').update(`${relative}:${line}`).digest('hex');
        nextHashes.push(hash);
        if (known.has(hash)) continue;
        const match = patterns.find(item => item.regex.test(line));
        if (match) events.push({
          type: match.type, severity: 'warning', title: match.title,
          summary: line.slice(0, 1200), fingerprint: `${match.type}:${line.slice(0, 160)}`,
          evidence: { log: relative, excerpt: line.slice(0, 1200) },
        });
      }
    } catch { /* optional log */ }
  }
  await writeJsonAtomic(stateFile, { logHashes: nextHashes.slice(-2000), checkedAt: new Date().toISOString() });
  return events;
}

async function enqueue(events, sourceName) {
  if (!events.length) return [];
  const queue = await readJson(queueFile, []);
  const emitted = await readJson(emittedFile, {});
  const observedAt = new Date().toISOString();
  const accepted = [];
  for (const event of events) {
    const fingerprint = event.fingerprint || `${event.type}:${event.title}`;
    const last = emitted[fingerprint] ? new Date(emitted[fingerprint]).getTime() : 0;
    if (Date.now() - last < 30 * 60 * 1000) continue;
    const normalized = { ...event, fingerprint, source: sourceName, observedAt };
    queue.push(normalized);
    accepted.push(normalized);
    emitted[fingerprint] = observedAt;
  }
  await writeJsonAtomic(queueFile, queue.slice(-5000));
  await writeJsonAtomic(emittedFile, emitted);
  return accepted;
}

async function flush(config) {
  const queue = await readJson(queueFile, []);
  if (!queue.length || !config.controlUrl || !config.sharedSecret) return { sent: 0, pending: queue.length };
  const batch = queue.slice(0, 200);
  const response = await fetch(`${config.controlUrl}/api/observer/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.sharedSecret}` },
    body: JSON.stringify({ events: batch }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Control center returned HTTP ${response.status}`);
  await writeJsonAtomic(queueFile, queue.slice(batch.length));
  return { sent: batch.length, pending: queue.length - batch.length };
}

async function flushSheet(config) {
  if (!config.sheetReporting) return { appended: 0, skipped: true };
  const queue = await readJson(sheetQueueFile, []);
  if (!queue.length) return { appended: 0 };
  const batch = queue.slice(0, 100);
  const result = await appendGuardianEvents(batch, config, projectRoot);
  await writeJsonAtomic(sheetQueueFile, queue.slice(batch.length));
  return result;
}

export async function observeOnce(now = new Date()) {
  const config = await loadConfig();
  const snapshot = await runtimeSnapshot();
  const events = [...detectMajorRules(snapshot, now), ...await recentLogEvents()];
  const accepted = await enqueue(events, config.sourceName);
  if (config.sheetReporting && accepted.length) {
    const pendingSheet = await readJson(sheetQueueFile, []);
    await writeJsonAtomic(sheetQueueFile, [...pendingSheet, ...accepted].slice(-5000));
  }
  let sheet;
  try { sheet = await flushSheet(config); } catch (error) { sheet = { appended: 0, error: error.message }; }
  let delivery;
  try { delivery = await flush(config); } catch (error) { delivery = { sent: 0, error: error.message }; }
  return { observedAt: now.toISOString(), detected: events.length, newlyQueued: accepted.length, sheet, delivery };
}

async function main() {
  const once = process.argv.includes('--once');
  const config = await loadConfig();
  do {
    const result = await observeOnce();
    console.log(JSON.stringify(result));
    if (once) break;
    await new Promise(resolve => setTimeout(resolve, config.pollSeconds * 1000));
  } while (true);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
