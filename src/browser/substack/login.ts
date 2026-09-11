import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome';

const SUBSTACK_ACCOUNTS_FILE = '.accounts/accounts-substack.json';
const SESSION_ROOT = path.resolve('.sessions/substack');

export interface SubstackAccount {
  email: string;
  password: string;
  nickname?: string;
  publicationUrl?: string;
  sessionDir?: string;
  active: boolean;
}

export function getSubstackAccounts(): SubstackAccount[] {
  if (!fs.existsSync(SUBSTACK_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(SUBSTACK_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveSubstackAccount(): SubstackAccount | null {
  return getSubstackAccounts().find(a => a.active) || null;
}

export function getSubstackAccountByNickname(nickname: string): SubstackAccount | null {
  return getSubstackAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(email: string): string {
  const safe = String(email || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeSubstackBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Substack browser closed.');
  }
}

export async function loginToSubstack(options?: {
  nickname?: string;
  manualMode?: boolean;  // if true, skip auto-type and wait for full manual login
}): Promise<Page> {
  const account = options?.nickname
    ? getSubstackAccountByNickname(options.nickname) ?? getActiveSubstackAccount()
    : getActiveSubstackAccount();

  if (!account) {
    throw new Error('No Substack account found in .accounts/accounts-substack.json');
  }

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });

  await killChromeForProfile(sessionDir);

  console.log(`   Using session folder: ${sessionDir}`);
  console.log('   Launching Substack browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: chromePath,
    viewport: { width: 1280, height: 720 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-minimized',
      '--window-size=1280,720',
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--simulate-outdated-no-au=Tue, 31 Dec 2099 00:00:00 GMT',
      '--disable-component-update',
      '--disable-features=ChromeWhatsNewUI',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });

  await browserContext.addInitScript(() => {
    Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
    (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
  });

  // Minimize window — wait for browser to fully init before CDP call
  await sleep(600);
  try {
    const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
    const cdp = await browserContext.newCDPSession(tmpPage);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore — non-critical */ }

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  // ── Check if already logged in via saved session ───────────────────────────
  console.log('   Navigating to Substack...');
  await page.goto('https://substack.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Substack (${account.nickname})`);
    return page;
  }

  // ── Go to sign-in and type email ───────────────────────────────────────────
  console.log('   Not logged in — going to sign-in page...');
  await page.goto('https://substack.com/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Click "Sign in with email" link if present
  try {
    const emailSignIn = page.locator('a:has-text("Sign in with email"), button:has-text("Sign in with email")').first();
    if (await emailSignIn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await emailSignIn.click();
      await sleep(1500);
    }
  } catch {}

  // Type email if we have one
  if (account.email) {
    try {
      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
      await emailInput.fill(account.email);
      await sleep(500);

      // Click Continue / Next to trigger OTP send
      const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]').first();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await sleep(1000);
      }

      console.log(`\n   📧 OTP sent to ${account.email}`);
      console.log('   👉 Check your email, enter the OTP in the browser, then wait...\n');
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-type email: ${err.message}`);
      console.log('   👉 Please enter your email and OTP manually in the browser window.\n');
    }
  } else {
    console.log('   👉 Please enter your email and OTP manually in the browser window.\n');
  }

  // ── Poll for login (up to 3 minutes) ──────────────────────────────────────
  console.log('   ⏳ Waiting for you to complete login (OTP entry)...');
  const maxWait = 180; // 3 minutes
  for (let i = 0; i < maxWait; i += 3) {
    await sleep(3000);
    if (await isLoggedIn(page)) {
      console.log(`\n   ✅ Login detected! Session saved.`);
      return page;
    }
    if ((i + 3) % 30 === 0) {
      console.log(`   ⏳ Still waiting... (${i + 3}s elapsed, up to ${maxWait}s)`);
    }
  }

  await closeSubstackBrowser();
  throw new Error('Login timed out after 3 minutes. Please try again.');
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    // If still on sign-in page, not logged in
    if (url.includes('sign-in') || url.includes('signin')) return false;

    // Check for logged-in indicators (broad set)
    const selectors = [
      'a[href*="/publish"]',
      '[data-testid="user-menu"]',
      'button[aria-label="Account menu"]',
      '.pencraft-user-head',
      'a[href*="/dashboard"]',
      'a[href*="substack.com/publish"]',
      'img[alt="Profile photo"]',
      'button.profile-photo-button',
      '.reader2-navigation',
      'a[href="/account"]',
    ];
    for (const sel of selectors) {
      const visible = await page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false);
      if (visible) return true;
    }

    // Fallback: if URL moved away from sign-in and no sign-in form visible, assume logged in
    const loginFormVisible = await page.locator('input[type="email"]').first().isVisible({ timeout: 800 }).catch(() => false);
    if (!loginFormVisible && !url.includes('sign-in')) return true;

    return false;
  } catch {
    return false;
  }
}

// ── Standalone login script ────────────────────────────────────────────────────
// Run: npx tsx src/browser/substack/login.ts --nickname pranav

async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;

  console.log(`\n🔐 Substack Login${nickname ? ` (${nickname})` : ''}`);

  try {
    const page = await loginToSubstack({ nickname });
    console.log('\n✅ Session saved. You can now run the full agent.');
    console.log('   Press Ctrl+C to exit.');
    await new Promise(() => {}); // Keep browser open
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('substack/login')) {
  main();
}

