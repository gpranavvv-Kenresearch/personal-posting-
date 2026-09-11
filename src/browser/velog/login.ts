import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';

// TODO(locators): velog login is typically GitHub OAuth (velog.io/login →
// github.com/login → redirect back). Confirm whether email/password login is
// also available, and update VELOG_LOGIN_URL / flow accordingly.
const VELOG_LOGIN_URL = 'https://velog.io/login';
const VELOG_HOME_URL = 'https://velog.io/';

const VELOG_ACCOUNTS_FILE = '.accounts/accounts-velog.json';
const SESSION_ROOT = path.resolve('.sessions/velog');

export interface VelogAccount {
  email: string; // GitHub email or velog login identifier
  password?: string;
  nickname?: string;
  velogHandle?: string; // velog.io/@<handle>
  sessionDir?: string;
  active: boolean;
}

export function getVelogAccounts(): VelogAccount[] {
  if (!fs.existsSync(VELOG_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(VELOG_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveVelogAccount(): VelogAccount | null {
  return getVelogAccounts().find(a => a.active) || null;
}

export function getVelogAccountByNickname(nickname: string): VelogAccount | null {
  return getVelogAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeVelogBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Velog browser closed.');
  }
}

// Confirmed against the logged-in velog.io homepage: a "Write a new post"
// pill button and a circular profile avatar with dropdown appear top-right.
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes('/login')) return false;
    const selectors = [
      'text=Write a new post',
      'a[href="/write"]',
      'button:has-text("Write a new post")',
      '[class*="UserProfile"]',
      'img[class*="avatar" i]',
    ];
    for (const sel of selectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function loginToVelog(options?: { nickname?: string; interactive?: boolean }): Promise<Page> {
  const account = options?.nickname
    ? getVelogAccountByNickname(options.nickname) ?? getActiveVelogAccount()
    : getActiveVelogAccount();

  if (!account) throw new Error('No Velog account found in .accounts/accounts-velog.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Velog session: ${sessionDir}`);

  const headless = process.env.HEADLESS !== 'false';

  // Minimal launch — Cloudflare (and similar) bot checks fingerprint on
  // inconsistencies between the browser's real identity and what automation
  // tooling normally injects: a forced userAgent string that doesn't match
  // this Chrome build's actual Client-Hints/internals, extra command-line
  // flags a normal user launch never has, and JS-level property overrides
  // (e.g. redefining navigator.webdriver) that are themselves detectable via
  // toString() inspection. Real Chrome + '--disable-blink-features=
  // AutomationControlled' already makes navigator.webdriver natively
  // undefined at the engine level — no JS shim needed on top of it, and no
  // custom userAgent, so every signal Cloudflare checks stays internally
  // consistent with a genuine user-launched Chrome profile.
  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: null,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      ...(headless ? ['--start-minimized'] : []),
      '--disable-blink-features=AutomationControlled',
    ],
  });

  if (headless) {
    try {
      const tmpPage = browserContext.pages()[0] || await browserContext.newPage();
      const cdp = await browserContext.newCDPSession(tmpPage);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.detach().catch(() => {});
    } catch { /* ignore */ }
  }

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  console.log('   Loading Velog session...');
  await page.goto(VELOG_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  // Production/batch/cron path (the default): every account here has
  // already completed a one-time manual login and has a saved persistent
  // session — just load it and hand back the page. No login-state check,
  // no interactive prompt. This matters beyond convenience: a headless cron
  // run has no one at the terminal, so any code path that could block on
  // stdin (waitForEnter) would hang that run forever. Only the standalone
  // onboarding CLI below opts into the guided interactive flow.
  if (!options?.interactive) {
    console.log(`   ✅ Session loaded for ${account.nickname} — proceeding.`);
    return page;
  }

  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Velog (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Velog login...');
  await page.goto(VELOG_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  console.log('\n   👉 Complete the login in the browser window (GitHub OAuth or whatever velog presents).');
  await waitForEnter('   Once you\'re logged in, come back here and press Enter... ');

  // Best-effort confirmation only — never blocks on it. The site's logged-in
  // markup isn't fully confirmed, so a false negative here shouldn't discard
  // a login the user just told us they finished.
  const confirmed = await isLoggedIn(page).catch(() => false);
  console.log(confirmed
    ? '   ✅ Velog login confirmed — session saved.'
    : '   ⚠️ Could not visually confirm login, but trusting your Enter — session saved as-is.');
  return page;
}

async function waitForEnter(promptText: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(promptText);
  rl.close();
}

// Standalone: npx tsx src/browser/velog/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Velog Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToVelog({ nickname, interactive: true });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('velog/login') || process.argv[1]?.includes('velog\\login')) main();
