/**
 * serpApiClient.ts — SERP lookup with provider rotation
 *
 * Providers (equal weight, round-robin):
 *   1. SerpAPI    (SERPAPI_KEY_1 … _15)
 *   2. Zenserp    (ZENSERP_API_KEY_1 … _10)
 *   3. Serpstack  (SERPSTACK_API_KEY_1 … _10)
 *
 * Each call starts with the next provider in rotation.
 * If that provider's keys are exhausted, the call moves to the next provider.
 * Provider rotation state: .sessions/provider-rotation.json
 */

import fs from 'fs';
import path from 'path';

const ZENSERP_BASE   = 'https://app.zenserp.com/api/v2/search';
const SERPSTACK_BASE = 'http://api.serpstack.com/search';
const SERPAPI_BASE   = 'https://serpapi.com/search.json';
const TIMEOUT_MS     = 10000;

const ZENSERP_STATE      = path.resolve('.sessions/zenserp-state.json');
const SERPSTACK_STATE    = path.resolve('.sessions/serpstack-state.json');
const SERPAPI_STATE      = path.resolve('.sessions/serpapi-state.json');
const PROVIDER_ROT_STATE = path.resolve('.sessions/provider-rotation.json');

// ── Key loaders ─────────────────────────────────────────────────────────────

function loadZenserpKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`ZENSERP_API_KEY_${i}`];
    if (k?.trim()) keys.push(k.trim());
  }
  return keys;
}

function loadSerpstackKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`SERPSTACK_API_KEY_${i}`];
    if (k?.trim()) keys.push(k.trim());
  }
  return keys;
}

function loadSerpApiKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const k = process.env[`SERPAPI_KEY_${i}`];
    if (k?.trim()) keys.push(k.trim());
  }
  return keys;
}

// ── State persistence ───────────────────────────────────────────────────────

function loadIdx(file: string): number {
  try { return (JSON.parse(fs.readFileSync(file, 'utf-8')) as any).currentIndex ?? 0; }
  catch { return 0; }
}

function saveIdx(file: string, index: number): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ currentIndex: index }, null, 2));
  } catch { /* non-critical */ }
}

// ── Zenserp ─────────────────────────────────────────────────────────────────

async function makeZenserpRequest(key: string, params: Record<string, string>): Promise<any> {
  // Zenserp uses ?q=...&apikey=...
  const qs = new URLSearchParams({
    q:      params.q ?? '',
    num:    params.num ?? '100',
    hl:     params.hl ?? 'en',
    gl:     params.gl ?? 'us',
    apikey: key,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ZENSERP_BASE}?${qs.toString()}`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429) {
      throw Object.assign(new Error('CREDITS_EXHAUSTED'), { code: String(res.status) });
    }
    if (!res.ok) {
      const text = await res.text();
      if (text.toLowerCase().includes('not enough') || text.toLowerCase().includes('quota') || text.toLowerCase().includes('credit')) {
        throw Object.assign(new Error('CREDITS_EXHAUSTED'), { code: String(res.status) });
      }
      throw new Error(`Zenserp error ${res.status}: ${text.slice(0, 120)}`);
    }

    const json = await res.json() as any;

    // Normalize to { organic_results: [{ link, title, position }] }
    const organic = (json.organic ?? json.organic_results ?? []).map((r: any, i: number) => ({
      link:     r.url || r.link || '',
      title:    r.title || '',
      snippet:  r.description || r.snippet || '',
      position: r.position ?? (i + 1),
    }));

    return { organic_results: organic };
  } catch (err: any) {
    clearTimeout(timer);
    throw err;
  }
}

async function callZenserp(params: Record<string, string>): Promise<any> {
  const keys = loadZenserpKeys();
  if (keys.length === 0) throw new Error('NO_KEYS');

  let index = loadIdx(ZENSERP_STATE) % keys.length;
  const start = index;
  let attempts = 0;

  while (attempts < keys.length) {
    try {
      const result = await makeZenserpRequest(keys[index], params);
      if (index !== start) saveIdx(ZENSERP_STATE, index);
      return result;
    } catch (err: any) {
      if (isExhausted(err)) {
        console.warn(`   ⚠️  Zenserp key ${index + 1}/${keys.length} exhausted — rotating`);
        index = (index + 1) % keys.length;
        saveIdx(ZENSERP_STATE, index);
        attempts++;
        if (index === start) throw new Error('ALL_EXHAUSTED');
      } else {
        throw err;
      }
    }
  }

  throw new Error('ALL_EXHAUSTED');
}

// ── Serpstack ────────────────────────────────────────────────────────────────

async function makeSerpstackRequest(key: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({
    access_key: key,
    query:      params.q ?? '',
    num:        params.num ?? '100',
    hl:         params.hl ?? 'en',
    gl:         params.gl ?? 'us',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${SERPSTACK_BASE}?${qs.toString()}`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429) {
      throw Object.assign(new Error('CREDITS_EXHAUSTED'), { code: String(res.status) });
    }
    if (!res.ok) {
      const text = await res.text();
      if (text.toLowerCase().includes('not enough') || text.toLowerCase().includes('quota') || text.toLowerCase().includes('credit')) {
        throw Object.assign(new Error('CREDITS_EXHAUSTED'), { code: String(res.status) });
      }
      throw new Error(`Serpstack error ${res.status}: ${text.slice(0, 120)}`);
    }

    const json = await res.json() as any;

    // Serpstack returns { error: true } on invalid key
    if (json.error) {
      throw Object.assign(new Error('CREDITS_EXHAUSTED'), { code: '401' });
    }

    const organic = (json.organic_results ?? []).map((r: any, i: number) => ({
      link:     r.url || r.link || '',
      title:    r.title || '',
      snippet:  r.snippet || '',
      position: r.position ?? (i + 1),
    }));

    return { organic_results: organic };
  } catch (err: any) {
    clearTimeout(timer);
    throw err;
  }
}

async function callSerpstack(params: Record<string, string>): Promise<any> {
  const keys = loadSerpstackKeys();
  if (keys.length === 0) throw new Error('NO_KEYS');

  let index = loadIdx(SERPSTACK_STATE) % keys.length;
  const start = index;
  let attempts = 0;

  while (attempts < keys.length) {
    try {
      const result = await makeSerpstackRequest(keys[index], params);
      if (index !== start) saveIdx(SERPSTACK_STATE, index);
      return result;
    } catch (err: any) {
      if (isExhausted(err)) {
        console.warn(`   ⚠️  Serpstack key ${index + 1}/${keys.length} exhausted — rotating`);
        index = (index + 1) % keys.length;
        saveIdx(SERPSTACK_STATE, index);
        attempts++;
        if (index === start) throw new Error('ALL_EXHAUSTED');
      } else {
        throw err;
      }
    }
  }

  throw new Error('ALL_EXHAUSTED');
}

// ── SerpAPI ──────────────────────────────────────────────────────────────────

async function makeSerpApiRequest(key: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, api_key: key, output: 'json' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${SERPAPI_BASE}?${qs.toString()}`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 401 || res.status === 402 || res.status === 403 || res.status === 429) {
      throw Object.assign(new Error('CREDITS_EXHAUSTED'), { code: String(res.status) });
    }
    if (!res.ok) {
      const text = await res.text();
      if (text.toLowerCase().includes('not enough') || text.toLowerCase().includes('quota') || text.toLowerCase().includes('credit')) {
        throw Object.assign(new Error('CREDITS_EXHAUSTED'), { code: String(res.status) });
      }
      throw new Error(`SerpAPI error ${res.status}: ${text.slice(0, 120)}`);
    }

    const json = await res.json() as any;
    const organic = (json.organic_results ?? []).map((r: any, i: number) => ({
      link:     r.link || r.url || '',
      title:    r.title || '',
      snippet:  r.snippet || '',
      position: r.position ?? (i + 1),
    }));

    return { organic_results: organic };
  } catch (err: any) {
    clearTimeout(timer);
    throw err;
  }
}

async function callSerpApiProvider(params: Record<string, string>): Promise<any> {
  const keys = loadSerpApiKeys();
  if (keys.length === 0) throw new Error('NO_KEYS');

  let index = loadIdx(SERPAPI_STATE) % keys.length;
  const start = index;
  let attempts = 0;

  while (attempts < keys.length) {
    try {
      const result = await makeSerpApiRequest(keys[index], params);
      if (index !== start) saveIdx(SERPAPI_STATE, index);
      return result;
    } catch (err: any) {
      if (isExhausted(err)) {
        console.warn(`   ⚠️  SerpAPI key ${index + 1}/${keys.length} exhausted — rotating`);
        index = (index + 1) % keys.length;
        saveIdx(SERPAPI_STATE, index);
        attempts++;
        if (index === start) throw new Error('ALL_EXHAUSTED');
      } else {
        throw err;
      }
    }
  }

  throw new Error('ALL_EXHAUSTED');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isExhausted(err: any): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    err.message === 'CREDITS_EXHAUSTED' ||
    m.includes('credit') ||
    m.includes('insufficient') ||
    m.includes('quota') ||
    m.includes('not enough') ||
    m.includes('402') ||
    m.includes('403') ||
    m.includes('429') ||
    m.includes('401')
  );
}

// ── Provider rotation ────────────────────────────────────────────────────────
// Providers rotate equally: SerpAPI → Zenserp → Serpstack → SerpAPI → …
// Each call starts at the next provider. If it fails, tries the remaining two.

type Provider = 'serpapi' | 'zenserp' | 'serpstack';
const PROVIDERS: Provider[] = ['serpapi', 'zenserp', 'serpstack'];

function loadProviderIndex(): number {
  try { return (JSON.parse(fs.readFileSync(PROVIDER_ROT_STATE, 'utf-8')) as any).index ?? 0; }
  catch { return 0; }
}

function saveProviderIndex(index: number): void {
  try {
    fs.mkdirSync(path.dirname(PROVIDER_ROT_STATE), { recursive: true });
    fs.writeFileSync(PROVIDER_ROT_STATE, JSON.stringify({ index }, null, 2));
  } catch { /* non-critical */ }
}

async function callProvider(provider: Provider, params: Record<string, string>): Promise<any> {
  switch (provider) {
    case 'serpapi':   return callSerpApiProvider(params);
    case 'zenserp':   return callZenserp(params);
    case 'serpstack': return callSerpstack(params);
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

export async function callSerpApi(params: Record<string, string>): Promise<any> {
  const startIndex = loadProviderIndex() % PROVIDERS.length;

  for (let i = 0; i < PROVIDERS.length; i++) {
    const providerIndex = (startIndex + i) % PROVIDERS.length;
    const provider = PROVIDERS[providerIndex];

    try {
      const result = await callProvider(provider, params);
      // Advance rotation so next call uses the next provider
      saveProviderIndex((providerIndex + 1) % PROVIDERS.length);
      console.log(`   ✔ SERP via ${provider}`);
      return result;
    } catch (err: any) {
      const exhausted = err.message === 'ALL_EXHAUSTED' || err.message === 'NO_KEYS' || isExhausted(err);
      if (exhausted) {
        console.warn(`   ⚠️  ${provider} exhausted — trying next provider`);
        saveProviderIndex((providerIndex + 1) % PROVIDERS.length);
      } else {
        console.warn(`   ⚠️  ${provider} error (${err.message}) — trying next provider`);
      }
    }
  }

  throw new Error('All SERP providers exhausted (SerpAPI + Zenserp + Serpstack). Add credits or new keys.');
}
