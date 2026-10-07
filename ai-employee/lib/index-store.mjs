import fs from 'node:fs/promises';
import { indexFile } from './config.mjs';
import { cosineSimilarity, tokenize } from './text.mjs';
import { embedTexts } from './ollama.mjs';

let cached = null;

export async function loadIndex() {
  if (cached) return cached;
  try {
    cached = JSON.parse(await fs.readFile(indexFile, 'utf8'));
  } catch {
    cached = { version: 1, createdAt: null, embeddingModel: null, documents: [], chunks: [] };
  }
  return cached;
}

export function clearIndexCache() {
  cached = null;
}

function lexicalScore(query, chunk, documentFrequency, totalChunks) {
  const queryTerms = [...new Set(tokenize(query))];
  let score = 0;
  for (const term of queryTerms) {
    const tf = chunk.terms?.[term] ?? 0;
    if (!tf) continue;
    const idf = Math.log(1 + totalChunks / (1 + (documentFrequency[term] ?? 0)));
    score += (1 + Math.log(tf)) * idf;
  }
  const lower = chunk.content.toLowerCase();
  if (query.trim().length >= 4 && lower.includes(query.trim().toLowerCase())) score += 8;
  return score;
}

export async function searchIndex(query, options = {}) {
  const index = await loadIndex();
  const topK = options.topK ?? 8;
  let queryEmbedding = null;
  if (index.embeddingModel && index.chunks.some(chunk => Array.isArray(chunk.embedding))) {
    try {
      [queryEmbedding] = await embedTexts(query);
    } catch {
      queryEmbedding = null;
    }
  }

  const ranked = index.chunks.map(chunk => {
    const lexical = lexicalScore(query, chunk, index.documentFrequency ?? {}, index.chunks.length || 1);
    const semantic = queryEmbedding && chunk.embedding ? cosineSimilarity(queryEmbedding, chunk.embedding) : 0;
    return { ...chunk, score: lexical + semantic * 6, lexicalScore: lexical, semanticScore: semantic };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);

  const seen = new Map();
  for (const item of ranked) {
    const count = seen.get(item.source) ?? 0;
    if (count >= 3) continue;
    seen.set(item.source, count + 1);
    if ([...seen.values()].reduce((sum, value) => sum + value, 0) >= topK) break;
  }

  const selected = [];
  const sourceCounts = new Map();
  for (const item of ranked) {
    const count = sourceCounts.get(item.source) ?? 0;
    if (count >= 3) continue;
    selected.push(item);
    sourceCounts.set(item.source, count + 1);
    if (selected.length >= topK) break;
  }
  return selected;
}
