import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';
import { safeCloseContext } from '../../utils/safeClose.js';

// Tistory (Korea, Kakao-owned) — login is via a Kakao account, same
// OAuth/checkpoint risk profile as Instagram/Note. Session-only: no
// password ever auto-filled or stored, same pattern as
// src/browser/instagram/login.ts and src/browser/note/login.ts. Log in
// once by hand via src/tools/loginTistory.ts, session is then reused.

const ACCOUNTS_FILE = '.accounts/accounts-tistory.json';
const SESSION_ROOT = path.resolve('.sessions/tistory');

export interface TistoryAccount {
  nickname: string;
  /** The account's own blog subdomain, e.g. "myblog" for myblog.tistory.com — needed for posting, not for login. */
  blogName?: string;
  active: boolean;
}

export function getTistoryAccounts(): TistoryAccount[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

export function getTistoryAccountByNickname(nickname: string): TistoryAccount | undefined {
  const accounts = getTistoryAccounts();
  const needle = nickname.toLowerCase();
  // No "fall back to any active account" here — that exact bug (silently
  // substituting the wrong account for an unmatched nickname) was
  // confirmed live on Instagram's login.ts and fixed there; don't repeat it.
  return accounts.find(a => a.active && a.nickname.toLowerCase() === needle);
}

export function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;
let currentSessionDir: string | null = null;

export async function closeTistoryBrowser(): Promise<void> {
  await safeCloseContext(browserContext, { label: 'Tistory', sessionDir: currentSessionDir });
  browserContext = null;
}

export async function loginToTistory(nickname: string): Promise<Page> {
  const sessionDir = sessionDirFor(nickname);
  currentSessionDir = sessionDir;
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  console.log(`   Using Tistory session folder (account: ${nickname}): ${sessionDir}`);
  console.log('   Launching Tistory browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--window-size=1366,900',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const existingPages = browserContext.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await browserContext.newPage();
  for (const p of existingPages.slice(1)) await p.close().catch(() => {});

  // Trust the saved session — no login-state check here (same convention
  // as Note's login.ts). Just open tistory.com and hand the page to the
  // caller; a genuinely dead session will fail visibly at the next real
  // step (e.g. the write-post page redirecting to login) rather than being
  // silently masked here.
  console.log('   Opening tistory.com with saved session...');
  await page.goto('https://www.tistory.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  return page;
}
