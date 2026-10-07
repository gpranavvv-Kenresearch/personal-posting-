import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './config.mjs';
import { resolveSafeProjectPath, redactSecrets } from './security.mjs';
import { searchIndex } from './index-store.mjs';

const schemas = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Search indexed project files, documentation, fixes, errors, and imported conversations.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description: 'Read a non-sensitive text file inside the project. Credential, environment, session, and account paths are blocked.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_project',
      description: 'Find exact text or a regular expression in non-sensitive project text files.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, maxResults: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['pattern'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_runtime_status',
      description: 'Inspect safe runtime metadata such as whether state directories and heartbeat files exist. Does not expose credentials.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_recent_errors',
      description: 'Read recent entries from approved local error and runtime logs.',
      parameters: { type: 'object', properties: { lines: { type: 'integer', minimum: 1, maximum: 200 } } },
    },
  },
];

export function toolSchemas() {
  return schemas;
}

async function readProjectFile(args) {
  const { absolute, relative } = resolveSafeProjectPath(args.path);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size > 1_500_000) throw new Error('File is not a supported text file or is too large');
  const lines = redactSecrets(await fs.readFile(absolute, 'utf8')).split(/\r?\n/);
  const start = Math.max(1, Number(args.startLine || 1));
  const end = Math.min(lines.length, Number(args.endLine || start + 199));
  return { source: relative, startLine: start, endLine: end, content: lines.slice(start - 1, end).join('\n') };
}

async function searchProject(args) {
  const root = args.path ? resolveSafeProjectPath(args.path).absolute : projectRoot;
  const maxResults = Math.min(50, Math.max(1, Number(args.maxResults || 20)));
  const regex = new RegExp(args.pattern, 'i');
  const results = [];

  async function walk(current) {
    if (results.length >= maxResults) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (results.length >= maxResults) break;
      const relative = path.relative(projectRoot, path.join(current, entry.name)).replaceAll('\\', '/');
      try { resolveSafeProjectPath(relative); } catch { continue; }
      if (entry.isDirectory()) await walk(path.join(current, entry.name));
      else if (/\.(ts|tsx|js|mjs|json|md|txt|yaml|yml)$/i.test(entry.name)) {
        const stat = await fs.stat(path.join(current, entry.name));
        if (stat.size > 1_500_000) continue;
        const lines = (await fs.readFile(path.join(current, entry.name), 'utf8')).split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maxResults; index++) {
          if (regex.test(lines[index])) results.push({ source: relative, line: index + 1, text: redactSecrets(lines[index]).slice(0, 500) });
        }
      }
    }
  }
  await walk(root);
  return results;
}

async function inspectRuntimeStatus() {
  const paths = ['.sessions', '.accounts', 'logs/runtime.log', '.sessions/heartbeat.json', '.sessions/slot-ledger.json'];
  const status = {};
  for (const item of paths) {
    try {
      const stat = await fs.stat(path.join(projectRoot, item));
      status[item] = { exists: true, type: stat.isDirectory() ? 'directory' : 'file', modifiedAt: stat.mtime.toISOString(), size: stat.isFile() ? stat.size : undefined };
    } catch {
      status[item] = { exists: false };
    }
  }
  return status;
}

async function readRecentErrors(args) {
  const count = Math.min(200, Math.max(1, Number(args.lines || 60)));
  const allowed = ['logs/runtime.log', 'logs/errors.json', 'logs/fixes.md'];
  const output = [];
  for (const file of allowed) {
    try {
      const text = redactSecrets(await fs.readFile(path.join(projectRoot, file), 'utf8'));
      output.push({ source: file, content: text.split(/\r?\n/).slice(-count).join('\n') });
    } catch { /* optional log */ }
  }
  return output;
}

export async function executeTool(name, args = {}) {
  switch (name) {
    case 'search_knowledge': {
      const hits = await searchIndex(String(args.query || ''), { topK: Math.min(12, Number(args.limit || 8)) });
      return hits.map(hit => ({ source: hit.source, startLine: hit.startLine, endLine: hit.endLine, content: hit.content, score: Number(hit.score.toFixed(3)) }));
    }
    case 'read_project_file': return readProjectFile(args);
    case 'search_project': return searchProject(args);
    case 'inspect_runtime_status': return inspectRuntimeStatus();
    case 'read_recent_errors': return readRecentErrors(args);
    default: throw new Error(`Unknown or unapproved tool: ${name}`);
  }
}
