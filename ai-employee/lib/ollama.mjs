import { config } from './config.mjs';

async function request(path, options = {}) {
  const response = await fetch(`${config.ollamaUrl}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama ${path} returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

export async function getOllamaStatus() {
  try {
    const result = await request('/api/tags', { timeoutMs: 4_000 });
    return { available: true, models: (result.models ?? []).map(item => item.name) };
  } catch (error) {
    return { available: false, models: [], error: error.message };
  }
}

export async function embedTexts(input) {
  const list = Array.isArray(input) ? input : [input];
  const result = await request('/api/embed', {
    method: 'POST',
    body: JSON.stringify({ model: config.embedModel, input: list }),
    timeoutMs: 300_000,
  });
  return result.embeddings ?? [];
}

export async function chat(messages, tools = []) {
  return request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      stream: false,
      think: false,
      options: { temperature: 0.15, num_ctx: 4096, num_predict: 300 },
    }),
    timeoutMs: 300_000,
  });
}
