/**
 * platforms.ts — the platform registry.
 *
 * One place that records, per platform: how we post to it, whether we can EDIT
 * something already published, and what utm_source its links carry.
 *
 * The edit capability is the gate for interlinking. A link can only be added to
 * an existing post on a platform we can edit programmatically; everywhere else
 * a proposal can be generated but a human must apply it by hand.
 *
 * Verified against the repository on 2026-11-16:
 *   - src/browser/<platform>/ directories (36 of them)
 *   - only hackmd and mataroa have an apiPoster.ts with PATCH/PUT capability
 *   - utm sources come from src/utils/utm.ts
 */

export type PostMethod = 'api' | 'browser';
export type EditCapability =
  /** A REST API exists that can update an already-published post. */
  | 'api-edit'
  /** The post can be edited, but only by driving the browser (slow, fragile). */
  | 'browser-edit'
  /** Published content cannot be edited at all; it can only be replaced. */
  | 'none'
  /** Not yet investigated. Must be treated as 'none' until confirmed. */
  | 'unknown';

export interface PlatformInfo {
  /** Canonical key, matches the src/browser/<dir> name. */
  key: string;
  /** Display name as used in the sheet and in UTM_PARAMS. */
  name: string;
  utmSource: string;
  postMethod: PostMethod;
  editCapability: EditCapability;
  /** Domain the published post lives on, for indexation site: queries. */
  domain?: string;
  notes?: string;
}

/**
 * Edit capability is deliberately conservative. Anything not PROVEN editable is
 * 'unknown', and the interlinking applier must refuse 'unknown' exactly as it
 * refuses 'none'. Promoting a platform out of 'unknown' requires someone to
 * actually verify it, not to assume it.
 */
export const PLATFORMS: PlatformInfo[] = [
  // ── Proven editable: these are the interlinking targets ──────────────────
  { key: 'hackmd', name: 'HackMD', utmSource: 'hackmd', postMethod: 'api', editCapability: 'api-edit', domain: 'hackmd.io',
    notes: 'Full REST client with PATCH at src/browser/hackmd/apiPoster.ts. Lowest-risk interlinking target.' },
  { key: 'mataroa', name: 'Mataroa', utmSource: 'mataroa', postMethod: 'api', editCapability: 'api-edit', domain: 'mataroa.blog',
    notes: 'REST client with update capability at src/browser/mataroa/apiPoster.ts.' },

  // ── Browser-posted. Editing is plausible but UNVERIFIED. ─────────────────
  { key: 'medium', name: 'Medium', utmSource: 'medium', postMethod: 'browser', editCapability: 'unknown', domain: 'medium.com' },
  { key: 'devto', name: 'Devto', utmSource: 'devto', postMethod: 'browser', editCapability: 'unknown', domain: 'dev.to',
    notes: 'dev.to has a public API with article update; worth promoting to api-edit if a key is obtained.' },
  { key: 'blogger', name: 'Blogger', utmSource: 'blogger', postMethod: 'browser', editCapability: 'unknown', domain: 'blogspot.com',
    notes: 'Blogger API v3 supports post update; the same Google service account may already suffice.' },
  { key: 'wordpress', name: 'WordPress', utmSource: 'wordpress', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'notion', name: 'Notion', utmSource: 'notion', postMethod: 'browser', editCapability: 'unknown', domain: 'notion.site' },
  { key: 'substack', name: 'Substack', utmSource: 'substack', postMethod: 'browser', editCapability: 'unknown', domain: 'substack.com' },
  { key: 'googlesite', name: 'GoogleSite', utmSource: 'googlesites', postMethod: 'browser', editCapability: 'unknown', domain: 'sites.google.com' },
  { key: 'linkedin-pulse', name: 'LinkedinPulse', utmSource: 'linkedin-pulse', postMethod: 'browser', editCapability: 'unknown', domain: 'linkedin.com' },
  { key: 'linkmate', name: 'Linkmate', utmSource: 'linkmate', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'calisthenics', name: 'Calisthenics', utmSource: 'calisthenics', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'coda', name: 'Coda', utmSource: 'coda', postMethod: 'browser', editCapability: 'unknown', domain: 'coda.io' },
  { key: 'paragraph', name: 'Paragraph', utmSource: 'paragraph', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'telegraph', name: 'Telegraph', utmSource: 'telegraph', postMethod: 'browser', editCapability: 'unknown', domain: 'telegra.ph' },
  { key: 'tumblr', name: 'Tumblr', utmSource: 'tumblr', postMethod: 'browser', editCapability: 'unknown', domain: 'tumblr.com' },
  { key: 'velog', name: 'Velog', utmSource: 'velog', postMethod: 'browser', editCapability: 'unknown', domain: 'velog.io' },
  { key: 'naver', name: 'Naver', utmSource: 'naver', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'note', name: 'Note', utmSource: 'note', postMethod: 'browser', editCapability: 'unknown', domain: 'note.com' },
  { key: 'patreon', name: 'Patreon', utmSource: 'patreon', postMethod: 'browser', editCapability: 'unknown', domain: 'patreon.com' },
  { key: 'letsdiskuss', name: 'Letsdiskuss', utmSource: 'letsdiskuss', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'articlescad', name: 'Articlescad', utmSource: 'articlescad', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'tistory', name: 'Tistory', utmSource: 'tistory', postMethod: 'browser', editCapability: 'unknown' },
  { key: 'mastodon', name: 'Mastodon', utmSource: 'mastodon', postMethod: 'browser', editCapability: 'none' },
  { key: 'vcru', name: 'Vcru', utmSource: 'vcru', postMethod: 'browser', editCapability: 'unknown', notes: 'Commented out of the cron schedule.' },
  { key: 'ameba', name: 'Ameba', utmSource: 'ameba', postMethod: 'browser', editCapability: 'unknown', notes: 'Removed from the schedule.' },

  // ── Social: posts are effectively immutable once published ───────────────
  { key: 'twitter', name: 'X', utmSource: 'x', postMethod: 'browser', editCapability: 'none', domain: 'x.com' },
  { key: 'facebook', name: 'Facebook', utmSource: 'facebook', postMethod: 'browser', editCapability: 'none', domain: 'facebook.com' },
  { key: 'linkedin', name: 'LinkedIn', utmSource: 'linkedin', postMethod: 'browser', editCapability: 'none', domain: 'linkedin.com' },
  { key: 'instagram', name: 'Instagram', utmSource: 'instagram', postMethod: 'browser', editCapability: 'none', domain: 'instagram.com' },

  // ── Bookmarking / file hosts: no editable body text ──────────────────────
  { key: 'instapaper', name: 'Instapaper', utmSource: 'instapaper', postMethod: 'browser', editCapability: 'none' },
  { key: 'raindrop', name: 'Raindrop', utmSource: 'raindrop', postMethod: 'browser', editCapability: 'none' },
  { key: 'pearltrees', name: 'Pearltrees', utmSource: 'pearltrees', postMethod: 'browser', editCapability: 'none' },
  { key: 'fourshared', name: 'FourShared', utmSource: '4shared', postMethod: 'browser', editCapability: 'none' },
  { key: 'pdfhost', name: 'PdfHost', utmSource: 'pdfhost', postMethod: 'browser', editCapability: 'none' },
  { key: 'scribd', name: 'Scribd', utmSource: 'scribd', postMethod: 'browser', editCapability: 'none' },

  // Found in the live sheet during ingest (2026-11-16) but absent from
  // src/browser/ and from UTM_PARAMS. They are really being posted to, so they
  // are registered here or they stay invisible to every platform report.
  // utmSource is a best guess until confirmed against GA4 — if these links
  // carry no utm_source at all, their traffic cannot be attributed and that is
  // itself worth knowing.
  { key: 'archiveorg', name: 'ArchiveOrg', utmSource: 'archiveorg', postMethod: 'browser', editCapability: 'unknown', domain: 'archive.org',
    notes: 'Seen in the sheet; no agent directory in src/browser/. Posting route unconfirmed.' },
  { key: 'mediafire', name: 'MediaFire', utmSource: 'mediafire', postMethod: 'browser', editCapability: 'none', domain: 'mediafire.com',
    notes: 'Seen in the sheet; file host, no editable body text.' },
];

const BY_KEY = new Map(PLATFORMS.map(p => [p.key.toLowerCase(), p]));
const BY_UTM = new Map(PLATFORMS.map(p => [p.utmSource.toLowerCase(), p]));
const BY_NAME = new Map(PLATFORMS.map(p => [p.name.toLowerCase(), p]));

export function platformByKey(key: string): PlatformInfo | undefined {
  return BY_KEY.get((key ?? '').trim().toLowerCase());
}

export function platformByUtmSource(utm: string): PlatformInfo | undefined {
  return BY_UTM.get((utm ?? '').trim().toLowerCase());
}

export function platformByName(name: string): PlatformInfo | undefined {
  const k = (name ?? '').trim().toLowerCase();
  return BY_NAME.get(k) ?? BY_KEY.get(k) ?? BY_UTM.get(k);
}

/**
 * Platforms where an approved interlink could actually be applied automatically.
 * 'unknown' is excluded on purpose — it must be proven, not presumed.
 */
export function editablePlatforms(): PlatformInfo[] {
  return PLATFORMS.filter(p => p.editCapability === 'api-edit' || p.editCapability === 'browser-edit');
}

export function canApplyInterlinks(platformKeyOrName: string): boolean {
  const p = platformByName(platformKeyOrName);
  return !!p && (p.editCapability === 'api-edit' || p.editCapability === 'browser-edit');
}

/** Domain for a site: indexation query, derived from the published URL if unknown. */
export function domainFor(platformKeyOrName: string, publishedUrl?: string): string | undefined {
  const p = platformByName(platformKeyOrName);
  if (p?.domain) return p.domain;
  if (!publishedUrl) return undefined;
  try { return new URL(publishedUrl).hostname.replace(/^www\./, ''); } catch { return undefined; }
}
