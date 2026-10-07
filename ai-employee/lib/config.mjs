import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const employeeRoot = path.resolve(here, '..');
export const projectRoot = path.resolve(employeeRoot, '..');
export const dataDir = path.join(employeeRoot, 'data');
export const importsDir = path.join(employeeRoot, 'imports');
export const indexFile = path.join(dataDir, 'knowledge-index.json');
export const auditFile = path.join(dataDir, 'audit.jsonl');
export const eventFile = path.join(dataDir, 'observer-events.jsonl');
export const incidentFile = path.join(dataDir, 'incidents.json');
export const memoryFile = path.join(dataDir, 'memory.json');

const localConfigFile = path.join(employeeRoot, 'config.json');
let localConfig = {};
try {
  localConfig = JSON.parse(fs.readFileSync(localConfigFile, 'utf8').replace(/^\uFEFF/, ''));
} catch {
  // setup.mjs creates this private file. Environment variables remain valid fallbacks.
}

export const config = {
  port: Number(process.env.AI_EMPLOYEE_PORT || 3210),
  host: process.env.AI_EMPLOYEE_HOST || localConfig.host || '127.0.0.1',
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
  model: process.env.AI_EMPLOYEE_MODEL || 'qwen3:4b',
  embedModel: process.env.AI_EMPLOYEE_EMBED_MODEL || 'nomic-embed-text',
  maxToolRounds: Number(process.env.AI_EMPLOYEE_MAX_TOOL_ROUNDS || 0),
  topK: Number(process.env.AI_EMPLOYEE_TOP_K || 5),
  observerSecret: process.env.AI_GUARDIAN_SHARED_SECRET || localConfig.observerSecret || '',
};

export const indexedRoots = [
  'src',
  'docs',
  'tests',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT_FOR_INTEGRATION.md',
  'PRD_RSS_Content_Distribution.md',
  'package.json',
  'tsconfig.json',
  'logs/fixes.md',
  'logs/errors.json',
  'ai-employee/imports',
];

export const ignoredDirectoryNames = new Set([
  '.git',
  '.accounts',
  '.sessions',
  'node_modules',
  'dist',
  'generated_images',
  'graphify-out',
  'data',
]);

export const supportedExtensions = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yaml', '.yml', '.html', '.css', '.ps1',
]);
