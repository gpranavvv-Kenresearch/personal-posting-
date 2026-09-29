/**
 * graphClient.ts — Microsoft Graph OAuth2 (client-credentials) token acquisition
 * and a thin authenticated request helper.
 *
 * Outlook is the newsletter medium per PRD_RSS_Content_Distribution.md §6.1
 * (Outlook / Microsoft 365 API with OAuth — explicitly NOT Gmail, NOT browser
 * automation). App-only auth is used (not a delegated/browser login) because
 * this runs unattended on a cron schedule with no user present to consent.
 *
 * Requires an Azure AD app registration with an Application permission of
 * Mail.Send (admin-consented), sending as OUTLOOK_SENDER_MAILBOX.
 *
 * Required env vars:
 *   OUTLOOK_TENANT_ID
 *   OUTLOOK_CLIENT_ID
 *   OUTLOOK_CLIENT_SECRET
 *   OUTLOOK_SENDER_MAILBOX   (the mailbox address Graph sends "as", e.g. newsletter@kenresearch.com)
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var ${name} — required for Outlook/Graph newsletter sending`);
  return val;
}

export function getOutlookConfig() {
  return {
    tenantId: requireEnv('OUTLOOK_TENANT_ID'),
    clientId: requireEnv('OUTLOOK_CLIENT_ID'),
    clientSecret: requireEnv('OUTLOOK_CLIENT_SECRET'),
    senderMailbox: requireEnv('OUTLOOK_SENDER_MAILBOX'),
  };
}

async function fetchAccessToken(): Promise<CachedToken> {
  const { tenantId, clientId, clientSecret } = getOutlookConfig();
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Outlook OAuth token request failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }

  const json = await res.json() as { access_token: string; expires_in: number };
  return {
    accessToken: json.access_token,
    // refresh 60s before actual expiry to avoid edge-of-window failures
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;
  cachedToken = await fetchAccessToken();
  return cachedToken.accessToken;
}

export async function graphRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: object,
): Promise<T | null> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
  }

  if (res.status === 202 || res.status === 204) return null; // sendMail returns 202 with empty body
  return res.json() as Promise<T>;
}
