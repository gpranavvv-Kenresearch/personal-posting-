import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { memoryFile } from './config.mjs';

async function load() {
  try { return JSON.parse(await fs.readFile(memoryFile, 'utf8')); } catch { return []; }
}

async function save(entries) {
  const temp = `${memoryFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries, null, 2));
  await fs.rename(temp, memoryFile);
}

export async function addMemoryCandidate(input) {
  const entries = await load();
  const entry = {
    id: `MEM-${crypto.randomUUID().slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'pending',
    kind: String(input.kind || 'conversation_note').slice(0, 80),
    title: String(input.title || 'Untitled memory').slice(0, 300),
    content: String(input.content || '').slice(0, 50_000),
    source: String(input.source || 'manual').slice(0, 500),
    rejectionReason: null,
  };
  entries.unshift(entry);
  await save(entries);
  return entry;
}

export async function reviewMemory(id, decision, reason = '') {
  if (!['approved', 'rejected', 'superseded'].includes(decision)) throw new Error('Invalid memory decision');
  const entries = await load();
  const entry = entries.find(item => item.id === id);
  if (!entry) throw new Error('Memory entry not found');
  entry.status = decision;
  entry.updatedAt = new Date().toISOString();
  entry.rejectionReason = decision === 'rejected' ? String(reason).slice(0, 2000) : null;
  await save(entries);
  return entry;
}

export async function listMemory(status) {
  const entries = await load();
  return status ? entries.filter(item => item.status === status) : entries;
}
