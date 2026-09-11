import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const MEDIUM_ACCOUNTS_FILE = '.accounts/accounts-medium.json';
const SESSION_ROOT = path.resolve('.sessions/medium');

export interface MediumAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getMediumAccounts(): MediumAccount[] {
  if (!fs.existsSync(MEDIUM_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(MEDIUM_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveMediumAccount(): MediumAccount | null {
  return getMediumAccounts().find(a => a.active) || null;
}

export function getMediumAccountByNickname(nickname: string): MediumAccount | null {
  return getMediumAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeMediumBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Medium browser closed.');
  }
}

export async function loginToMedium(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getMediumAccountByNickname(options.nickname) ?? getActiveMediumAccount()
    : getActiveMediumAccount();

  const email    = options?.email    || account?.email    || process.env.MEDIUM_EMAIL;
  const password = options?.password || account?.password || process.env.MEDIUM_PASSWORD;

  if (!email) {
    throw new Error(`Medium email missing. Add account to .accounts/accounts-medium.json or set MEDIUM_EMAIL env var.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  // Don't create if it doesn't exist - use existing saved session
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Medium browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-minimized',
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  await browserContext.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
  });

  // Reuse the page the persistent context opened; close any extras
  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  // Go to Medium homepage
  console.log('   Navigating to Medium...');
  await page.goto('https://medium.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait 5 seconds for auto-login via session
  console.log('   Waiting 5 seconds for session check...');
  await sleep(5000);

  // Check if already logged in
  const loggedIn = !(await page.url()).includes('signin');
  if (loggedIn) {
    console.log(`   ✅ Already logged in to Medium (session restored)`);
    return page;
  }

  // If password provided, try auto-login
  if (password) {
    console.log(`   Attempting auto-login...`);
    // [Auto-login flow could be implemented here if needed]
    // For now, just wait for manual login
  }

  await closeMediumBrowser();
  throw new Error(`Unable to log in to Medium as ${email}. Session expired — run save-medium-session manually.`);
}

