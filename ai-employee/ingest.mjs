import fs from 'node:fs/promises';
import path from 'node:path';
import { config, dataDir, employeeRoot, ignoredDirectoryNames, importsDir, indexFile, indexedRoots, projectRoot, supportedExtensions } from './lib/config.mjs';
import { clearIndexCache } from './lib/index-store.mjs';
import { embedTexts, getOllamaStatus } from './lib/ollama.mjs';
import { isSensitiveName, redactSecrets } from './lib/security.mjs';
import { chunkText, termFrequencies } from './lib/text.mjs';

async function collectFiles(target, output) {
  let stat;
  try { stat = await fs.stat(target); } catch { return; }
  if (stat.isFile()) {
    const extension = path.extname(target).toLowerCase();
    if (supportedExtensions.has(extension) && !isSensitiveName(path.basename(target)) && stat.size <= 2_000_000) output.push(target);
    return;
  }
  if (!stat.isDirectory() || ignoredDirectoryNames.has(path.basename(target).toLowerCase())) return;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name.toLowerCase())) continue;
    await collectFiles(path.join(target, entry.name), output);
  }
}

function flattenConversationJson(value, source) {
  if (!value || typeof value !== 'object') return null;
  const conversations = Array.isArray(value) ? value : [value];
  const blocks = [];
  for (const conversation of conversations) {
    const title = conversation.title || conversation.name || 'Conversation';
    const messages = [];
    if (conversation.mapping && typeof conversation.mapping === 'object') {
      const nodes = Object.values(conversation.mapping)
        .filter(node => node?.message)
        .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));
      for (const node of nodes) {
        const role = node.message.author?.role || 'unknown';
        const parts = node.message.content?.parts;
        if (Array.isArray(parts)) messages.push(`${role}: ${parts.filter(part => typeof part === 'string').join('\n')}`);
      }
    } else if (Array.isArray(conversation.chat_messages)) {
      for (const message of conversation.chat_messages) messages.push(`${message.sender || message.role || 'unknown'}: ${message.text || message.content || ''}`);
    } else if (Array.isArray(conversation.messages)) {
      for (const message of conversation.messages) messages.push(`${message.role || message.sender || 'unknown'}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')}`);
    }
    if (messages.length) blocks.push(`# ${title}\nSource: ${source}\n\n${messages.join('\n\n')}`);
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : null;
}

async function readKnowledgeFile(file) {
  const relative = path.relative(projectRoot, file).replaceAll('\\', '/');
  const raw = await fs.readFile(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.json' && relative.startsWith('ai-employee/imports/')) {
    try {
      const flattened = flattenConversationJson(JSON.parse(raw), relative);
      if (flattened) return redactSecrets(flattened);
    } catch { /* index raw JSON text */ }
  }
  return redactSecrets(raw);
}

async function embedChunks(chunks) {
  const status = await getOllamaStatus();
  if (!status.available || !status.models.some(name => name === config.embedModel || name.startsWith(`${config.embedModel}:`))) {
    console.log(`Embeddings disabled: Ollama or model "${config.embedModel}" is unavailable. Lexical search will still work.`);
    return null;
  }
  console.log(`Embedding ${chunks.length} chunks with ${config.embedModel}...`);
  const batchSize = 24;
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const embeddings = await embedTexts(batch.map(chunk => chunk.content));
    for (let index = 0; index < batch.length; index++) batch[index].embedding = embeddings[index];
    process.stdout.write(`\rEmbedded ${Math.min(start + batchSize, chunks.length)}/${chunks.length}`);
  }
  process.stdout.write('\n');
  return config.embedModel;
}

export async function buildIndex() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(importsDir, { recursive: true });
  const files = [];
  for (const root of indexedRoots) await collectFiles(path.resolve(projectRoot, root), files);
  files.sort();

  const documents = [];
  const chunks = [];
  for (const file of files) {
    const source = path.relative(projectRoot, file).replaceAll('\\', '/');
    const content = await readKnowledgeFile(file);
    const stat = await fs.stat(file);
    const fileChunks = chunkText(content);
    documents.push({ source, modifiedAt: stat.mtime.toISOString(), size: stat.size, chunks: fileChunks.length });
    for (const chunk of fileChunks) {
      chunks.push({ id: `${source}:${chunk.startLine}`, source, ...chunk, terms: termFrequencies(chunk.content) });
    }
  }

  const documentFrequency = {};
  for (const chunk of chunks) {
    for (const term of Object.keys(chunk.terms)) documentFrequency[term] = (documentFrequency[term] ?? 0) + 1;
  }
  const embeddingModel = await embedChunks(chunks);
  const output = { version: 1, createdAt: new Date().toISOString(), projectRoot, embeddingModel, documents, documentFrequency, chunks };
  await fs.writeFile(indexFile, JSON.stringify(output), 'utf8');
  clearIndexCache();
  console.log(`Indexed ${documents.length} documents into ${chunks.length} chunks.`);
  console.log(`Index: ${path.relative(projectRoot, indexFile)}`);
  return { documents: documents.length, chunks: chunks.length, embeddingModel };
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'))) {
  buildIndex().catch(error => { console.error(error); process.exitCode = 1; });
}
