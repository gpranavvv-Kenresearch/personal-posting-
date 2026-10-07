import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { eventFile, incidentFile } from './config.mjs';

let mutationQueue = Promise.resolve();

function serializeMutation(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => {});
  return result;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

export async function appendObserverEvents(events) {
  const accepted = [];
  for (const input of events) {
    const event = {
      id: input.id || crypto.randomUUID(),
      observedAt: input.observedAt || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      source: String(input.source || 'posting-laptop').slice(0, 100),
      type: String(input.type || 'runtime').slice(0, 100),
      severity: ['info', 'warning', 'major', 'critical'].includes(input.severity) ? input.severity : 'warning',
      title: String(input.title || 'Observer event').slice(0, 300),
      summary: String(input.summary || '').slice(0, 5000),
      evidence: input.evidence && typeof input.evidence === 'object' ? input.evidence : {},
      fingerprint: String(input.fingerprint || '').slice(0, 300),
    };
    await fs.appendFile(eventFile, `${JSON.stringify(event)}\n`);
    accepted.push(event);
  }
  return accepted;
}

export async function upsertIncidents(events) {
  return serializeMutation(async () => {
    const incidents = await readJson(incidentFile, []);
    for (const event of events.filter(item => ['warning', 'major', 'critical'].includes(item.severity))) {
      const fingerprint = event.fingerprint || `${event.type}:${event.title}`;
      const open = incidents.find(item => item.fingerprint === fingerprint && item.status === 'open');
      if (open) {
        open.lastSeenAt = event.observedAt;
        open.occurrences += 1;
        open.latestEvidence = event.evidence;
        open.summary = event.summary;
        if (['major', 'critical'].includes(event.severity)) open.severity = event.severity;
      } else {
        incidents.unshift({
          id: `INC-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8)}`,
          fingerprint,
          title: event.title,
          source: event.source,
          severity: event.severity,
          status: 'open',
          firstSeenAt: event.observedAt,
          lastSeenAt: event.observedAt,
          occurrences: 1,
          summary: event.summary,
          latestEvidence: event.evidence,
          diagnosis: null,
          recommendations: [],
          actionState: 'advisory_only',
        });
      }
    }
    await writeJsonAtomic(incidentFile, incidents.slice(0, 2000));
    return incidents;
  });
}

export async function listIncidents({ limit = 100 } = {}) {
  return (await readJson(incidentFile, [])).slice(0, Math.min(500, Math.max(1, limit)));
}

export async function setIncidentDiagnosis(id, diagnosis) {
  return serializeMutation(async () => {
    const incidents = await readJson(incidentFile, []);
    const incident = incidents.find(item => item.id === id);
    if (!incident) throw new Error('Incident not found');
    incident.diagnosis = String(diagnosis).slice(0, 50_000);
    incident.diagnosedAt = new Date().toISOString();
    await writeJsonAtomic(incidentFile, incidents);
    return incident;
  });
}

export async function updateIncidentStatus(id, status, ownerNote = '') {
  if (!['open', 'acknowledged', 'resolved'].includes(status)) throw new Error('Invalid incident status');
  return serializeMutation(async () => {
    const incidents = await readJson(incidentFile, []);
    const incident = incidents.find(item => item.id === id);
    if (!incident) throw new Error('Incident not found');
    incident.status = status;
    incident.ownerNote = String(ownerNote).slice(0, 5000);
    incident.updatedAt = new Date().toISOString();
    await writeJsonAtomic(incidentFile, incidents);
    return incident;
  });
}
