/**
 * serpApiClient.ts — SerpAPI with auto key rotation
 *
 * Loads up to 10 keys from SERPAPI_KEY_1 … SERPAPI_KEY_10.
 * When a key's credits run out (402/429), rotates to the next.
 * After the last key wraps back to key 1.
 * Persists current key index to .sessions/serpapi-key-state.json.
 */

import fs from 'fs';
import path from 'path';

const STATE_FILE      = path.resolve('.sessions/serpapi-key-state.json');
const SERPAPI_BASE    = 'https://serpapi.com/search.json';
const TIMEOUT_MS      = 8000;

// ── Key loading ─────────────────────────────────────────────────────────────

function loadKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`SERPAPI_KEY_${i}`];
    if (key && key.trim()) keys.push(key.trim());
  }
  return keys;
}

// ── State persistence ───────────────────────────────────────────────────────

function loadState(): { currentIndex: number } {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { currentIndex: 0 };
  }
}

function saveState(index: number): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ currentIndex: index }, null, 2));
  } catch {
    console.warn('   ⚠️  Could not save SerpAPI key state');
  }
}

// ── Raw request ─────────────────────────────────────────────────────────────

async function makeRequest(key: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, api_key: key, output: 'json' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${SERPAPI_BASE}?${qs.toString()}`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 402 || res.status === 429) {
      const err = new Error('CREDITS_EXHAUSTED');
      (err as NodeJS.ErrnoException).code = String(res.status);
      throw err;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SerpAPI error ${res.status}: ${text}`);
    }

    return await res.json();
  } catch (err: any) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Public entry point ──────────────────────────────────────────────────────

export async function callSerpApi(params: Record<string, string>): Promise<any> {
  const keys = loadKeys();
  if (keys.length === 0) {
    throw new Error('No SerpAPI keys found. Set SERPAPI_KEY_1 … _10 in .env');
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
          err.message.includes('402') ||
          err.message.includes('429') ||
          err.message.toLowerCase().includes('credit') ||
          err.message.toLowerCase().includes('insufficient'));

      if (isCreditsError) {
        console.warn(`   ⚠️  SerpAPI key ${keyNum} exhausted — rotating to next key`);
        index = (index + 1) % keys.length;
        saveState(index);
        attempts++;

        if (index === startIndex) {
          throw new Error('All SerpAPI keys have exhausted credits. Please top up or add more keys.');
        }
      } else {
        throw err;
      }
    }
  }

  throw new Error('All SerpAPI keys have exhausted credits. Please top up or add more keys.');
}
