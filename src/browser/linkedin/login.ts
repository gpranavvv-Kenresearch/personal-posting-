import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const LINKEDIN_ACCOUNTS_FILE = '.accounts/linkedin-accounts.json';
const SESSION_ROOT = path.resolve('li-sessions');
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MANUAL_LOGIN_TIMEOUT_MS = 30_000;

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 500, max = 1400) =>
  sleep(Math.floor(Math.random() * (max - min + 1)) + min);

// ── 2FA detection ───────────────────────────────────────────────────────────

async function detectTwoFactorBlock(page: Page, username: string): Promise<boolean> {
  try {
    const url = (page.url() || '').toLowerCase();
    if (
      url.includes('two_step_verification') ||
      url.includes('two-step-verification') ||
      url.includes('checkpoint/challenge')
    ) {
      console.log(`   ⚠️  ${username}: 2FA verification required — cannot log in automatically`);
      return true;
    }
    const indicators = [
      'text=/two[-\\s]?step verification/i',
      'text=/verification code/i',
      'input[name="pin"]',
      'input[name="verification_code"]',
      '#input__phone_verification_pin',
    ];
    for (const sel of indicators) {
      const visible = await page.locator(sel).first().isVisible().catch(() => false);
      if (visible) {
        console.log(`   ⚠️  ${username}: 2FA indicator found (${sel}) — cannot log in automatically`);
        return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

// ── Login helper ────────────────────────────────────────────────────────────

async function ensureLoggedIn(page: Page, email: string, password: string): Promise<boolean> {
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    if (await detectTwoFactorBlock(page, email)) return false;

    const alreadyLoggedIn = await page.locator('a[href*="/mynetwork/"]').first().isVisible().catch(() => false);
    if (alreadyLoggedIn) {
      console.log(`   ✅ ${email}: already logged in`);
      return true;
    }

    if (!email || !password) {
      console.error(`   ❌ Credentials missing for ${email || 'unknown account'}`);
      return false;
    }

    // ── Auto-login attempt ──────────────────────────────────────────────────
    console.log(`   🔐 ${email}: session missing, attempting auto-login...`);
    const onLoginPage = (page.url() || '').toLowerCase().includes('login');
    if (!onLoginPage) {
      await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    }
    if (await detectTwoFactorBlock(page, email)) return false;

    const userField = page.locator('input#username, input[name="session_key"]');
    if (await userField.isVisible().catch(() => false)) {
      await userField.fill(email);
      await randomDelay();
    }

    const passField = page.locator('input#password, input[name="session_password"]');
    if (await passField.isVisible().catch(() => false)) {
      await passField.fill(password);
      await randomDelay();
      await page.keyboard.press('Enter').catch(() => {});
    }

    await page.waitForTimeout(4000);
    if (await detectTwoFactorBlock(page, email)) return false;

    const loggedIn = await page.locator('a[href*="/mynetwork/"]').first().isVisible().catch(() => false);
    if (loggedIn) {
      console.log(`   ✅ ${email}: login successful`);
      return true;
    }

    // ── Manual login fallback ───────────────────────────────────────────────
    console.log(`   ⚠️  ${email}: auto-login failed — waiting for manual login (${MANUAL_LOGIN_TIMEOUT_MS / 1000}s)...`);
    try {
      await page.locator('a[href*="/mynetwork/"]').first().waitFor({ state: 'visible', timeout: MANUAL_LOGIN_TIMEOUT_MS });
      console.log(`   ✅ ${email}: manual login detected`);
      return true;
    } catch {
      console.error(`   ❌ ${email}: manual login not detected within ${MANUAL_LOGIN_TIMEOUT_MS / 1000}s`);
      return false;
    }
  } catch (err: any) {
    console.error(`   ❌ Login error for ${email}: ${err.message}`);
    return false;
  }
}

// ── Browser context management ──────────────────────────────────────────────

let browserContext: BrowserContext | null = null;

export async function closeLinkedInBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
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

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching LinkedIn browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await browserContext.newPage();

  const loggedIn = await ensureLoggedIn(page, email, password);
  if (!loggedIn) {
    await closeLinkedInBrowser();
    throw new Error(`Unable to log in to LinkedIn as ${email}`);
  }

  return page;
}
