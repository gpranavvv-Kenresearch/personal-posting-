/**
 * apiPoster.ts — Mataroa blog REST API poster.
 *
 * Pure HTTP API, no browser automation at all — Mataroa's whole appeal is a
 * minimal, no-tracking blog with a simple authenticated JSON API.
 *
 * API docs: https://mataroa.blog/api/
 * Auth: Authorization: Bearer <MATAROA_API_KEY> (from .env)
 */

import fs from 'fs';
import { createRequire } from 'module';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const require = createRequire(import.meta.url);
const TurndownService = require('turndown') as { new(options?: any): { turndown(html: string): string } };

const MATAROA_API_BASE = 'https://mataroa.blog/api';
const MATAROA_ACCOUNTS_FILE = '.accounts/accounts-mataroa.json';

export interface MataroaAccount {
  nickname: string;
  apiKey: string;
  active: boolean;
}

export function getMataroaAccounts(): MataroaAccount[] {
  if (!fs.existsSync(MATAROA_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(MATAROA_ACCOUNTS_FILE, 'utf8'));
}

export function getMataroaAccountByNickname(nickname: string): MataroaAccount | null {
  return getMataroaAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

export interface MataroaApiResult {
  success: boolean;
  postUrl?: string;
  postText?: string;
  postedAt?: Date;
  error?: string;
}

interface MataroaPostResponse {
  ok: boolean;
  slug: string;
  url: string;
}

async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  apiKey: string,
  body?: object,
): Promise<T> {
  const url = `${MATAROA_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mataroa API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

export async function postToMataroaApi(
  apiKey: string,
  title: string,
  htmlContent: string,
): Promise<MataroaApiResult> {
  try {
    const htmlWithUtm = injectUTM(htmlContent, UTM_PARAMS.Mataroa);
    const turndown = new TurndownService();
    const markdown = turndown.turndown(htmlWithUtm);

    console.log(`   [Mataroa API] Creating post: "${title.slice(0, 60)}..."`);

    const today = new Date().toISOString().split('T')[0];
    const post = await apiRequest<MataroaPostResponse>('POST', '/posts/', apiKey, {
      title,
      body: markdown,
      published_at: today,
    });

    console.log(`   [Mataroa API] ✅ Post URL: ${post.url}`);
    return { success: true, postUrl: post.url, postText: markdown, postedAt: new Date() };

  } catch (err: any) {
    console.error(`   [Mataroa API] ❌ ${err.message}`);
    return { success: false, error: err.message };
  }
}
