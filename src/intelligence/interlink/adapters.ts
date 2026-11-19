/**
 * adapters.ts — platform edit adapters for interlinking.
 *
 * An adapter is the ONLY way this layer is allowed to touch an already
 * published page. There is deliberately one adapter per platform that we have
 * PROVEN can be edited through an API, and a refusing default for everything
 * else.
 *
 * Reuse, not reinvention:
 *   - HackMD: the REST surface, base URL, auth scheme and error shape mirror
 *     src/browser/hackmd/apiPoster.ts exactly (Bearer token against
 *     api.hackmd.io/v1, GET/POST/PATCH/DELETE, body JSON, error text truncated
 *     to 200 chars).
 *   - Mataroa: likewise mirrors src/browser/mataroa/apiPoster.ts, and the
 *     account/API-key loading is IMPORTED from it rather than duplicated.
 *
 *   Note on the one piece that is restated instead of imported: both posters
 *   keep their `apiRequest` helper module-private (it is not exported), and
 *   this task is not permitted to modify files outside src/intelligence/.
 *   So `bearerJson` below is a faithful restatement of that same helper, kept
 *   byte-for-byte compatible in method set, headers and error message shape.
 *   If those posters ever export `apiRequest`, delete `bearerJson` and import
 *   it instead — nothing else here has to change.
 *
 * NOTHING in this file is called unless the applier's flag gates pass. The
 * adapters themselves perform no gating; they are dumb transport.
 */

import fs from 'fs';
import { getMataroaAccounts, getMataroaAccountByNickname } from '../../browser/mataroa/apiPoster.js';

// ── The interface ────────────────────────────────────────────────────────────

export interface PlatformEditAdapter {
  /** Platform key, matching src/intelligence/platforms.ts. */
  key: string;
  /** False means: this platform can never be edited programmatically. */
  canEdit: boolean;
  /** Extract the platform's own post identifier from a published URL. */
  idFromUrl(url: string): string | null;
  /** Current full body of the post, as markdown. */
  fetchContent(id: string): Promise<string>;
  /** Replace the full body of the post. */
  updateContent(id: string, newContent: string): Promise<void>;
}

/** Resolve an adapter for a platform key/name. Returns null when none exists. */
export type AdapterResolver = (platform: string | null | undefined) => PlatformEditAdapter | null;

// ── Shared transport (see the note at the top of the file) ───────────────────

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function bearerJson<T>(
  label: string,
  base: string,
  method: HttpMethod,
  path: string,
  apiKey: string,
  body?: object,
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Never echo the key — only method, path and the server's own message.
    throw new Error(`${label} API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }

  if (method === 'PATCH' || method === 'DELETE') {
    // These frequently return an empty body; don't let JSON.parse blow up.
    const text = await res.text().catch(() => '');
    return (text ? safeJson<T>(text) : (undefined as unknown as T));
  }
  return res.json() as Promise<T>;
}

function safeJson<T>(text: string): T {
  try { return JSON.parse(text) as T; } catch { return undefined as unknown as T; }
}

// ── Key resolution ───────────────────────────────────────────────────────────

const HACKMD_ACCOUNTS_FILE = '.accounts/accounts-hackmd.json';

/**
 * HackMD API token. Env first (HACKMD_API_KEY), then the accounts file written
 * by src/tools/hackmdGetApiKeys.ts. Never logged.
 */
export function hackmdApiKey(nickname?: string): string | null {
  const fromEnv = (process.env.HACKMD_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (!fs.existsSync(HACKMD_ACCOUNTS_FILE)) return null;
    const rows = JSON.parse(fs.readFileSync(HACKMD_ACCOUNTS_FILE, 'utf8')) as any[];
    if (!Array.isArray(rows)) return null;
    const match = nickname
      ? rows.find(a => String(a?.nickname ?? '').toLowerCase() === nickname.toLowerCase())
      : (rows.find(a => a?.active && (a?.apiKey || a?.apiToken)) ?? rows.find(a => a?.apiKey || a?.apiToken));
    const key = String(match?.apiKey ?? match?.apiToken ?? '').trim();
    return key || null;
  } catch {
    return null;
  }
}

/** Mataroa API key, via the poster's own exported account loader. */
export function mataroaApiKey(nickname?: string): string | null {
  try {
    const acct = nickname
      ? getMataroaAccountByNickname(nickname)
      : (getMataroaAccounts().find(a => a.active) ?? getMataroaAccounts()[0] ?? null);
    const key = String(acct?.apiKey ?? '').trim();
    return key || null;
  } catch {
    return null;
  }
}

// ── HackMD ───────────────────────────────────────────────────────────────────

const HACKMD_API_BASE = 'https://api.hackmd.io/v1';

interface HackMDNote { id: string; content?: string; title?: string }

export function hackmdNoteIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)hackmd\.io$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    // https://hackmd.io/@user/<shortId>  or  https://hackmd.io/<noteId>
    const last = parts[parts.length - 1];
    return decodeURIComponent(last) || null;
  } catch {
    return null;
  }
}

export function hackmdAdapter(apiKey: string | null = hackmdApiKey()): PlatformEditAdapter {
  return {
    key: 'hackmd',
    canEdit: Boolean(apiKey),
    idFromUrl: hackmdNoteIdFromUrl,
    async fetchContent(id: string): Promise<string> {
      if (!apiKey) throw new Error('HackMD API key is not configured.');
      const note = await bearerJson<HackMDNote>('HackMD', HACKMD_API_BASE, 'GET', `/notes/${id}`, apiKey);
      if (typeof note?.content !== 'string') {
        throw new Error(`HackMD note ${id} returned no content field.`);
      }
      return note.content;
    },
    async updateContent(id: string, newContent: string): Promise<void> {
      if (!apiKey) throw new Error('HackMD API key is not configured.');
      await bearerJson('HackMD', HACKMD_API_BASE, 'PATCH', `/notes/${id}`, apiKey, { content: newContent });
    },
  };
}

// ── Mataroa ──────────────────────────────────────────────────────────────────

const MATAROA_API_BASE = 'https://mataroa.blog/api';

interface MataroaPost { ok?: boolean; slug?: string; title?: string; body?: string; url?: string }

export function mataroaSlugFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/mataroa\.blog$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    // https://<user>.mataroa.blog/blog/<slug>/
    const last = parts[parts.length - 1];
    return decodeURIComponent(last) || null;
  } catch {
    return null;
  }
}

export function mataroaAdapter(apiKey: string | null = mataroaApiKey()): PlatformEditAdapter {
  return {
    key: 'mataroa',
    canEdit: Boolean(apiKey),
    idFromUrl: mataroaSlugFromUrl,
    async fetchContent(slug: string): Promise<string> {
      if (!apiKey) throw new Error('Mataroa API key is not configured.');
      const post = await bearerJson<MataroaPost>('Mataroa', MATAROA_API_BASE, 'GET', `/posts/${slug}/`, apiKey);
      if (typeof post?.body !== 'string') {
        throw new Error(`Mataroa post ${slug} returned no body field.`);
      }
      return post.body;
    },
    async updateContent(slug: string, newContent: string): Promise<void> {
      if (!apiKey) throw new Error('Mataroa API key is not configured.');
      await bearerJson('Mataroa', MATAROA_API_BASE, 'PATCH', `/posts/${slug}/`, apiKey, { body: newContent });
    },
  };
}

// ── Everything else refuses ──────────────────────────────────────────────────

/** A permanently-refusing adapter. Used for every platform we cannot edit. */
export function refusingAdapter(key: string): PlatformEditAdapter {
  return {
    key,
    canEdit: false,
    idFromUrl: () => null,
    async fetchContent(): Promise<string> {
      throw new Error(`Platform "${key}" has no edit adapter — published content cannot be modified.`);
    },
    async updateContent(): Promise<void> {
      throw new Error(`Platform "${key}" has no edit adapter — published content cannot be modified.`);
    },
  };
}

/**
 * The real resolver. Returns null for any platform without a proven adapter,
 * which the applier treats as a hard refusal.
 */
export const defaultAdapters: AdapterResolver = (platform) => {
  const k = String(platform ?? '').trim().toLowerCase();
  if (k === 'hackmd') return hackmdAdapter();
  if (k === 'mataroa') return mataroaAdapter();
  return null;
};
