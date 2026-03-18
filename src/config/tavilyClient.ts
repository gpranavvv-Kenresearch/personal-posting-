/**
 * tavilyClient.ts — Tavily Web Search API with auto key rotation
 *
 * Loads up to 10 keys from TAVILY_API_KEY_1 … TAVILY_API_KEY_10.
 * When a key's credits run out (401/429), automatically rotates to the next.
 * After the last key wraps back to key 1.
 * Persists current key index to .sessions/tavily-key-state.json.
 */

import fs from 'fs';
import path from 'path';

const STATE_FILE     = path.resolve('.sessions/tavily-key-state.json');
const TAVILY_BASE_URL = 'https://api.tavily.com';

// ── Key loading ─────────────────────────────────────────────────────────────

function loadKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`TAVILY_API_KEY_${i}`];
    if (key && key.trim()) keys.push(key.trim());
  }
  return keys;
}

// ── State persistence ───────────────────────────────────────────────────────

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
    console.warn('   ⚠️  Could not save Tavily key state');
  }
}

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface TavilySearchParams {
  query: string;
  search_depth?: 'basic' | 'advanced';
  include_answer?: boolean;
  include_images?: boolean;
  include_raw_content?: boolean;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  topic?: 'general' | 'news';
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string;
}

export interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  response_time: number;
}

// ── Raw request ─────────────────────────────────────────────────────────────

async function makeRequest(key: string, params: TavilySearchParams): Promise<TavilyResponse> {
  const res = await fetch(`${TAVILY_BASE_URL}/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query:               params.query,
      search_depth:        params.search_depth        ?? 'basic',
      include_answer:      params.include_answer       ?? false,
      include_images:      params.include_images       ?? false,
      include_raw_content: params.include_raw_content  ?? false,
      max_results:         params.max_results          ?? 5,
      ...(params.include_domains  ? { include_domains:  params.include_domains  } : {}),
      ...(params.exclude_domains  ? { exclude_domains:  params.exclude_domains  } : {}),
      ...(params.topic            ? { topic:            params.topic            } : {}),
    }),
  });

  // Credits exhausted / unauthorized → rotate key
  if (res.status === 401 || res.status === 429) {
    const err = new Error('CREDITS_EXHAUSTED');
    (err as NodeJS.ErrnoException).code = String(res.status);
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<TavilyResponse>;
}

// ── Public entry point ──────────────────────────────────────────────────────

export async function callTavily(params: TavilySearchParams): Promise<TavilyResponse> {
  const keys = loadKeys();
  if (keys.length === 0) {
    throw new Error('No Tavily API keys found. Set TAVILY_API_KEY_1 … _10 in .env');
  }

  const state = loadState();
  let index = state.currentIndex % keys.length;
  const startIndex = index;
  let attempts = 0;

  while (attempts < keys.length) {
    const keyNum = index + 1;
    try {
      const result = await makeRequest(keys[index], params);
      if (index !== state.currentIndex) saveState(index);
      return result;
    } catch (err: unknown) {
      const isCreditsError =
        err instanceof Error &&
        (err.message === 'CREDITS_EXHAUSTED' ||
          err.message.includes('401') ||
          err.message.includes('429') ||
          err.message.toLowerCase().includes('credit') ||
          err.message.toLowerCase().includes('insufficient'));

      if (isCreditsError) {
        console.warn(`   ⚠️  Tavily key ${keyNum} exhausted — rotating to next key`);
        index = (index + 1) % keys.length;
        saveState(index);
        attempts++;

        if (index === startIndex) {
          throw new Error('All Tavily API keys have exhausted credits. Please top up or add more keys.');
        }
      } else {
        throw err;
      }
    }
  }

  throw new Error('All Tavily API keys have exhausted credits. Please top up or add more keys.');
}
