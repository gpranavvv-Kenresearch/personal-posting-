import { chromium, BrowserContext, Page } from 'playwright';
import { humanDelay } from '../stagehand.js';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const LINKEDIN_ACCOUNTS_FILE = '.accounts/linkedin-accounts.json';
const SESSION_ROOT = path.resolve('li-sessions');
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.mkdirSync(SESSION_ROOT, { recursive: true });

export interface LinkedInAccount {
  email: string;
  password: string;
  sessionDir?: string;
  nickname?: string;
  profileUrl?: string;
  active: boolean;
}

export function getLinkedInAccounts(): LinkedInAccount[] {
  if (!fs.existsSync(LINKEDIN_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(LINKEDIN_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveLinkedInAccount(): LinkedInAccount | null {
  return getLinkedInAccounts().find(a => a.active) || null;
}

export function getLinkedInAccountByNickname(nickname: string): LinkedInAccount | null {
  return getLinkedInAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

let browserContext: BrowserContext;

export async function closeLinkedInBrowser() {
  if (browserContext) {
    await browserContext.close();
    console.log('   LinkedIn browser closed.');
  }
}

export async function loginToLinkedIn(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getLinkedInAccountByNickname(options.nickname) ?? getActiveLinkedInAccount()
    : getActiveLinkedInAccount();
  const email    = options?.email    || account?.email    || process.env.LINKEDIN_EMAIL!;
  const password = options?.password || account?.password || process.env.LINKEDIN_PASSWORD!;

  // Use system Chrome if available, otherwise fall back to Playwright's bundled Chromium
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Chrome not found at ${CHROME_PATH}. Set CHROME_PATH env var.`);
  }

  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching LinkedIn browser (real Chrome)...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: CHROME_PATH,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await browserContext.newPage();

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });

  // Already logged in check
  const alreadyLoggedIn = await page.locator('a[href*="/mynetwork/"]').first().isVisible().catch(() => false);
  if (alreadyLoggedIn) {
    console.log('   Already logged in to LinkedIn!');
    return page;
  }

  console.log('   Session missing, logging in...');
  const onLoginPage = (page.url() || '').toLowerCase().includes('login');
  if (!onLoginPage) {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  }

  await humanDelay(2000, 3000);

  const userField = page.locator('input#username, input[name="session_key"]');
  if (await userField.isVisible().catch(() => false)) {
    await userField.fill(email);
    await humanDelay(400, 700);
  }

  const passField = page.locator('input#password, input[name="session_password"]');
  if (await passField.isVisible().catch(() => false)) {
    await passField.fill(password);
    await humanDelay(800, 1200);
    await page.keyboard.press('Enter');
  }

  await humanDelay(4000, 6000);

  console.log(`   URL after login: ${page.url()}`);
  console.log('✅ LinkedIn login done!');
  return page;
}
