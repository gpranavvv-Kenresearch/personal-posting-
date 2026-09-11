import fs from 'fs';
import path from 'path';
import { stripModelArtifacts } from '../utils/textChecks.js';

const STATE_FILE = path.resolve('.sessions/openrouter-key-state.json');
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Load all non-empty keys from env
function loadKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const key = process.env[`OPENROUTER_API_KEY_${i}`];
    if (key && key.trim()) keys.push(key.trim());
  }
  return keys;
}

function loadState(): { currentIndex: number } {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { currentIndex: 0 };
  }
}

function saveState(index: number): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ currentIndex: index }, null, 2));
  } catch {
    // non-critical — just log
    console.warn('   ⚠️  Could not save OpenRouter key state');
  }
}

export interface OpenRouterMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OpenRouterParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: OpenRouterMessage[];
}

export interface OpenRouterResponse {
  content: Array<{ type: string; text: string }>;
}

async function makeRequest(key: string, params: OpenRouterParams): Promise<OpenRouterResponse> {
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: params.system
      ? [{ role: 'system', content: params.system }, ...params.messages]
      : params.messages,
  };

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://kenresearch.com',
      'X-Title': 'Ken Research Posting Agent',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 402) {
    const err = new Error('CREDITS_EXHAUSTED');
    (err as NodeJS.ErrnoException).code = '402';
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API error ${res.status}: ${text}`);
  }

  const json = await res.json() as { choices: Array<{ message: { content: string } }> };
  const text = stripModelArtifacts(json.choices?.[0]?.message?.content ?? '');

  // Return in same shape as Anthropic SDK so callers need no changes
  return {
    content: [{ type: 'text', text }],
  };
}

export async function callOpenRouter(params: OpenRouterParams): Promise<OpenRouterResponse> {
  const keys = loadKeys();
  if (keys.length === 0) {
    throw new Error('No OpenRouter API keys found. Set OPENROUTER_API_KEY_1 … _15 in .env');
  }

  const state = loadState();
  let index = state.currentIndex % keys.length;
  const startIndex = index;

  // Try each key at most once before giving up
  let attempts = 0;
  while (attempts < keys.length) {
    const keyNum = index + 1; // human-readable (matches env var suffix)
    try {
      const result = await makeRequest(keys[index], params);
      // Persist index in case it changed from a previous rotation
      if (index !== state.currentIndex) saveState(index);
      return result;
    } catch (err: unknown) {
      const isCreditsError =
        err instanceof Error &&
        (err.message === 'CREDITS_EXHAUSTED' ||
          err.message.includes('402') ||
          err.message.toLowerCase().includes('credit') ||
          err.message.toLowerCase().includes('insufficient'));

      if (isCreditsError) {
        console.warn(`   ⚠️  OpenRouter key ${keyNum} credits exhausted — rotating to next key`);
        index = (index + 1) % keys.length;
        saveState(index);
        attempts++;

        if (index === startIndex) {
          throw new Error('All OpenRouter API keys have exhausted credits. Please top up or add more keys.');
        }
      } else {
        throw err;
      }
    }
  }

  throw new Error('All OpenRouter API keys have exhausted credits. Please top up or add more keys.');
}
