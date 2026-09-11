/**
 * apiPoster.ts — HackMD API-based note creation
 *
 * Uses the HackMD REST API (api.hackmd.io/v1) to create and publish notes.
 * This is the PRIMARY posting path. Browser automation is the fallback.
 *
 * API docs: https://hackmd.io/@hackmd-api/developer-portal
 */

import { createRequire } from 'module';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const require = createRequire(import.meta.url);
const TurndownService = require('turndown') as { new(options?: any): { turndown(html: string): string } };

const HACKMD_API_BASE = 'https://api.hackmd.io/v1';

export interface HackMDApiResult {
  success: boolean;
  postUrl?: string;
  postText?: string;
  postedAt?: Date;
  error?: string;
}

interface HackMDNoteResponse {
  id: string;
  title: string;
  publishLink?: string;
  shortId?: string;
  permalink?: string;
  userPath?: string;
  teamPath?: string | null;
}

async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  apiKey: string,
  body?: object,
): Promise<T> {
  const url = `${HACKMD_API_BASE}${path}`;
  const res = await fetch(url, {
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
    throw new Error(`HackMD API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

function buildPublishUrl(note: HackMDNoteResponse): string {
  // publishLink is the canonical public URL when the note is published
  if (note.publishLink) return note.publishLink;

  // userPath + shortId form the readable URL
  if (note.userPath && note.shortId) return `https://hackmd.io/@${note.userPath}/${note.shortId}`;
  if (note.userPath && note.id)      return `https://hackmd.io/@${note.userPath}/${note.id}`;

  // Bare note URL as last resort
  return `https://hackmd.io/${note.id}`;
}

export async function postToHackMDApi(
  apiKey: string,
  title: string,
  htmlContent: string,
): Promise<HackMDApiResult> {
  try {
    // Inject UTMs into HTML before converting to markdown
    const htmlWithUtm = injectUTM(htmlContent, UTM_PARAMS.HackMD);
    const turndown = new TurndownService();
    const markdown = turndown.turndown(htmlWithUtm);

    // Build the full markdown body with title heading
    const body = `# ${title}\n\n${markdown}`;

    console.log(`   [HackMD API] Creating note: "${title.slice(0, 60)}..."`);

    const note = await apiRequest<HackMDNoteResponse>('POST', '/notes', apiKey, {
      title,
      content: body,
      readPermission: 'guest',      // publicly readable
      writePermission: 'owner',
      commentPermission: 'everyone',
    });

    const noteId = note.id;
    console.log(`   [HackMD API] Note created: ${noteId}`);

    // Publish the note so it gets a public permalink
    try {
      await apiRequest('PATCH', `/notes/${noteId}`, apiKey, {
        publishType: 'view',         // publish in view mode
        readPermission: 'guest',
      });
      console.log(`   [HackMD API] Note published`);
    } catch (pubErr: any) {
      // Publishing may fail if already published or not supported — the note is still live
      console.warn(`   [HackMD API] Publish patch failed (note is still accessible): ${pubErr.message}`);
    }

    // Re-fetch to get the updated publishLink
    let finalUrl = buildPublishUrl(note);
    try {
      const updated = await apiRequest<HackMDNoteResponse>('GET', `/notes/${noteId}`, apiKey);
      finalUrl = buildPublishUrl(updated);
    } catch { /* use the URL from creation response */ }

    console.log(`   [HackMD API] ✅ Post URL: ${finalUrl}`);
    return { success: true, postUrl: finalUrl, postText: markdown, postedAt: new Date() };

  } catch (err: any) {
    console.error(`   [HackMD API] ❌ ${err.message}`);
    return { success: false, error: err.message };
  }
}
