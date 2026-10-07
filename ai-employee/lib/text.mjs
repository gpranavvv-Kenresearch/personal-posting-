export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9_./:-]{2,}/g) ?? [];
}

export function chunkText(text, options = {}) {
  const maxChars = options.maxChars ?? 1800;
  const overlapLines = options.overlapLines ?? 4;
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let length = 0;
    while (end < lines.length) {
      const next = lines[end].length + 1;
      if (end > start && length + next > maxChars) break;
      length += next;
      end++;
    }
    const content = lines.slice(start, end).join('\n').trim();
    if (content) chunks.push({ content, startLine: start + 1, endLine: end });
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlapLines);
  }
  return chunks;
}

export function termFrequencies(text) {
  const counts = {};
  for (const token of tokenize(text)) counts[token] = (counts[token] ?? 0) + 1;
  return counts;
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
