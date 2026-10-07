import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from './lib/agent.mjs';
import { config, indexFile } from './lib/config.mjs';
import { loadIndex } from './lib/index-store.mjs';
import { getOllamaStatus } from './lib/ollama.mjs';
import { buildIndex } from './ingest.mjs';
import { appendObserverEvents, listIncidents, setIncidentDiagnosis, updateIncidentStatus, upsertIncidents } from './lib/incident-store.mjs';
import { addMemoryCandidate, listMemory, reviewMemory } from './lib/memory-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function statusPayload() {
  const [ollama, index, incidents] = await Promise.all([getOllamaStatus(), loadIndex(), listIncidents({ limit: 500 })]);
  return {
    mode: 'observe',
    ollama,
    configuredModel: config.model,
    configuredEmbedModel: config.embedModel,
    incidents: { open: incidents.filter(item => item.status === 'open').length, major: incidents.filter(item => item.status === 'open' && ['major', 'critical'].includes(item.severity)).length },
    index: { exists: !!index.createdAt, createdAt: index.createdAt, documents: index.documents.length, chunks: index.chunks.length, embeddingModel: index.embeddingModel },
  };
}

function observerAuthorized(req) {
  if (!config.observerSecret) return false;
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = Buffer.from(config.observerSecret);
  const received = Buffer.from(supplied);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

let diagnosisActive = false;
async function diagnosePendingIncidents() {
  if (diagnosisActive) return;
  diagnosisActive = true;
  try {
    const pending = (await listIncidents({ limit: 100 })).filter(item => item.status === 'open' && !item.diagnosis).slice(0, 3);
    for (const incident of pending) {
      try {
        const prompt = `Diagnose this observed production incident for the Ken Research posting project. Use current repository evidence to explain the cause and consequences. Do not perform any action.\n\nIncident: ${JSON.stringify(incident)}`;
        const result = await runAgent(prompt);
        await setIncidentDiagnosis(incident.id, result.answer);
      } catch (error) {
        console.error(`[guardian] Diagnosis failed for ${incident.id}: ${error.message}`);
      }
    }
  } finally {
    diagnosisActive = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await statusPayload());
    if (req.method === 'GET' && url.pathname === '/api/incidents') return json(res, 200, { incidents: await listIncidents({ limit: Number(url.searchParams.get('limit') || 100) }) });
    if (req.method === 'POST' && url.pathname.startsWith('/api/incidents/') && url.pathname.endsWith('/status')) {
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      const body = await bodyJson(req);
      return json(res, 200, { incident: await updateIncidentStatus(id, body.status, body.ownerNote) });
    }
    if (req.method === 'GET' && url.pathname === '/api/memory') return json(res, 200, { entries: await listMemory(url.searchParams.get('status') || undefined) });
    if (req.method === 'POST' && url.pathname === '/api/memory') {
      const body = await bodyJson(req);
      if (!body.content) return json(res, 400, { error: 'content is required' });
      return json(res, 201, { entry: await addMemoryCandidate(body) });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/memory/') && url.pathname.endsWith('/review')) {
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      const body = await bodyJson(req);
      return json(res, 200, { entry: await reviewMemory(id, body.decision, body.reason) });
    }
    if (req.method === 'POST' && url.pathname === '/api/observer/events') {
      if (!observerAuthorized(req)) return json(res, 401, { error: 'Observer authentication failed' });
      const body = await bodyJson(req);
      const incoming = Array.isArray(body.events) ? body.events : [];
      if (!incoming.length || incoming.length > 200) return json(res, 400, { error: 'events must contain 1 to 200 items' });
      const accepted = await appendObserverEvents(incoming);
      await upsertIncidents(accepted);
      diagnosePendingIncidents().catch(error => console.error(`[guardian] Diagnosis queue failed: ${error.message}`));
      return json(res, 202, { accepted: accepted.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/reindex') return json(res, 200, await buildIndex());
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await bodyJson(req);
      if (!body.message || typeof body.message !== 'string') return json(res, 400, { error: 'message is required' });
      const result = await runAgent(body.message.slice(0, 20_000), Array.isArray(body.history) ? body.history : []);
      return json(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/api/index-location') return json(res, 200, { indexFile });

    const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(publicDir, requested);
    if (!file.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
    const content = await fs.readFile(file);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
    res.end(content);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    json(res, status, { error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`AI Employee POC: http://${config.host}:${config.port}`);
  console.log('Mode: OBSERVE (read-only tools only)');
});
