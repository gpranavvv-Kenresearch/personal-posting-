/**
 * subscribers.ts — newsletter subscriber list loader.
 *
 * PRD §6.1: "Subscriber list source to be provided by the team — not yet
 * available. Pipeline should be built so the list source can be swapped in
 * once confirmed (e.g., a Sheet tab, a synced list, etc.)."
 *
 * Until that source is confirmed, subscribers are read from a local JSON
 * file (same convention as .accounts/accounts-<platform>.json). Swap the
 * body of getNewsletterSubscribers() for a Sheet/CRM read once the real
 * source is known — callers only depend on this function's return shape.
 */

import fs from 'fs';

const SUBSCRIBERS_FILE = '.accounts/newsletter-subscribers.json';

export interface NewsletterSubscriber {
  email: string;
  name?: string;
  active: boolean;
}

export function getNewsletterSubscribers(): NewsletterSubscriber[] {
  if (!fs.existsSync(SUBSCRIBERS_FILE)) {
    console.warn(`   ⚠️ [Newsletter] ${SUBSCRIBERS_FILE} not found — no subscriber list configured yet. See ${SUBSCRIBERS_FILE.replace('.json', '.example.json')} for the expected format.`);
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8')) as NewsletterSubscriber[];
  return raw.filter(s => s.active && s.email);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parses the Newsletter Campaign tab's "Prospect Emails" cell (comma,
 * semicolon, or newline-separated addresses) into subscriber objects.
 * Silently drops anything that doesn't look like an email rather than
 * failing the whole row over one typo'd address.
 */
export function parseProspectEmails(raw: string): NewsletterSubscriber[] {
  if (!raw) return [];
  return raw
    .split(/[,;\n]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => EMAIL_RE.test(s))
    .map(email => ({ email, active: true }));
}
