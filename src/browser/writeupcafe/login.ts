import { chromium, Browser, Page } from 'playwright';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const WRITEUPCAFE_ACCOUNTS_FILE = '.accounts/accounts-writeupcafe.json';
const SESSION_ROOT = path.resolve('.sessions/writeupcafe');
const DEBUG_PORT = 9223;

export interface WriteupCafeAccount {
  email: string;
  password?: string;
  sessionDir?: string;
  nickname?: string;
  username?: string;
  active: boolean;
}

export function getWriteupCafeAccounts(): WriteupCafeAccount[] {
  if (!fs.existsSync(WRITEUPCAFE_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(WRITEUPCAFE_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveWriteupCafeAccount(): WriteupCafeAccount | null {
  return getWriteupCafeAccounts().find(a => a.active) || null;
}

export function getWriteupCafeAccountByNickname(nickname: string): WriteupCafeAccount | null {
  return getWriteupCafeAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let chromeProcess: ChildProcess | null = null;
let browser: Browser | null = null;

export async function closeWriteupCafeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (chromeProcess) {
    try {
      spawn('taskkill', ['/PID', String(chromeProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* ignore */ }
    chromeProcess = null;
  }
  console.log('   WriteupCafe browser closed.');
}

export async function loginToWriteupCafe(options?: {
  email?: string;
  password?: string;
  nickname?: string;
}): Promise<Page> {
  const account = options?.nickname
    ? getWriteupCafeAccountByNickname(options.nickname) ?? getActiveWriteupCafeAccount()
    : getActiveWriteupCafeAccount();

  const email    = options?.email    || account?.email    || process.env.WRITEUPCAFE_EMAIL;
  const password = options?.password || account?.password || process.env.WRITEUPCAFE_PASSWORD;

  if (!email || !password) {
    throw new Error(`WriteupCafe credentials missing. Add email+password to ${WRITEUPCAFE_ACCOUNTS_FILE}.`);
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account?.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(email);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Kill any Chrome already holding this port or profile
  spawn('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore' });
  await sleep(2000);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log(`   Launching real Chrome on port ${DEBUG_PORT}...`);

  chromeProcess = spawn(chromePath, [
    `--user-data-dir=${sessionDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-infobars',
    'https://writeupcafe.com/',
  ], { detached: false, stdio: 'ignore' });

  console.log('   Waiting for Chrome to start...');
  await sleep(5000);

  // Connect Playwright via CDP — Chrome is a real browser, no automation flags
  browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  await sleep(2000);

  // Check if already logged in by going to post page
  console.log('   Checking session...');
  await page.goto('https://writeupcafe.com/post-writeup', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (page.url().includes('/post-writeup')) {
    console.log('   ✅ Already logged in (session restored)');
    return page;
  }

  // Not logged in — navigate to login and fill credentials
  console.log('   Session not found — logging in with credentials...');
  await page.goto('https://writeupcafe.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Fill email
  await page.evaluate((val) => {
    const el = document.querySelector('input[type="email"], input[name="email"]') as HTMLInputElement;
    if (el) { el.focus(); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  }, email);
  await sleep(1000);

  // Fill password
  await page.evaluate((val) => {
    const el = document.querySelector('input[type="password"], input[name="password"]') as HTMLInputElement;
    if (el) { el.focus(); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  }, password);
  await sleep(1000);

  // Click login button
  await page.evaluate(() => {
    const candidates = [
      document.querySelector('button[type="submit"]'),
      document.querySelector('input[type="submit"]'),
      ...Array.from(document.querySelectorAll('button')).filter(b => /login|sign in/i.test(b.textContent || '')),
    ];
    const btn = candidates.find(Boolean) as HTMLElement | null;
    if (btn) btn.click();
  });

  console.log('   Waiting for login to complete...');
  await sleep(5000);

  // Check if login succeeded
  const urlAfter = page.url();
  if (!urlAfter.includes('/login') && !urlAfter.includes('/signin')) {
    console.log('   ✅ Login successful');
    return page;
  }

  // reCAPTCHA or other issue — wait for manual resolution
  console.log('   ⚠️  Login may need manual intervention (captcha etc.)');
  await new Promise<void>(resolve => {
    process.stdout.write('   Complete login in the browser, then type y and press Enter: ');
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  console.log('   ✅ Login assumed');
  return page;
}
