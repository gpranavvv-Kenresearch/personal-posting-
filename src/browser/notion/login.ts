import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

const NOTION_ACCOUNTS_FILE = '.accounts/accounts-notion.json';
const SESSION_ROOT = path.resolve('.sessions/notion');

export interface NotionAccount {
  email: string;
  password?: string;
  nickname?: string;
  workspaceName?: string;
  sessionDir?: string;
  active: boolean;
}

export function getNotionAccounts(): NotionAccount[] {
  if (!fs.existsSync(NOTION_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(NOTION_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveNotionAccount(): NotionAccount | null {
  return getNotionAccounts().find(a => a.active) || null;
}

export function getNotionAccountByNickname(nickname: string): NotionAccount | null {
  return getNotionAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeNotionBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Notion browser closed.');
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes('/login') || url.includes('/sign-in')) return false;
    const selectors = [
      '[data-testid="sidebar"]',
      '.notion-sidebar',
      '[class*="sidebar"]',
      'nav[class*="side"]',
      '[aria-label="Sidebar"]',
      'div[role="navigation"]',
    ];
    for (const sel of selectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) return true;
    }
    const loginForm = await page.locator('input[placeholder*="email" i]').first().isVisible({ timeout: 800 }).catch(() => false);
    if (!loginForm && url.includes('notion.so') && !url.includes('login')) return true;
    return false;
  } catch {
    return false;
  }
}

export async function loginToNotion(options?: { nickname?: string; headless?: boolean }): Promise<Page> {
  const account = options?.nickname
    ? getNotionAccountByNickname(options.nickname) ?? getActiveNotionAccount()
    : getActiveNotionAccount();

  if (!account) throw new Error('No Notion account found in .accounts/accounts-notion.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Notion session: ${sessionDir}`);

  const headless = options?.headless ?? true;
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
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  });

  await browserContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    (window as any).chrome = (window as any).chrome || { runtime: {} };
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

  // Check saved session
  console.log('   Checking Notion session...');
  await page.goto('https://www.notion.so/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  if (await isLoggedIn(page)) {
    console.log(`   ✅ Already logged in to Notion (${account.nickname})`);
    return page;
  }

  // Login flow
  console.log('   Not logged in — starting Notion login...');
  await page.goto('https://www.notion.so/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Enter email
  if (account.email) {
    try {
      const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.fill(account.email);
      await sleep(500);

      const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await sleep(1500);
      } else {
        await page.keyboard.press('Enter');
        await sleep(1500);
      }

      // If password available, try filling it
      if (account.password) {
        const passInput = page.locator('input[type="password"]').first();
        if (await passInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await passInput.fill(account.password);
          await sleep(300);
          const loginBtn = page.locator('button:has-text("Continue"), button:has-text("Log in"), button[type="submit"]').first();
          if (await loginBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await loginBtn.click();
          } else {
            await page.keyboard.press('Enter');
          }
          await sleep(3000);
        } else {
          console.log(`\n   📧 OTP sent to ${account.email}`);
          console.log('   👉 Enter the OTP/magic link in the browser, then wait...\n');
        }
      } else {
        console.log(`\n   📧 OTP/magic link sent to ${account.email}`);
        console.log('   👉 Complete login in the browser window...\n');
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-type email: ${err.message}`);
      console.log('   👉 Please log in manually in the browser window.\n');
    }
  } else {
    console.log('   👉 Please log in manually in the browser window.\n');
  }

  // Poll for login — up to 3 minutes
  console.log('   ⏳ Waiting for login (up to 3 minutes)...');
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    if (await isLoggedIn(page)) {
      console.log(`\n   ✅ Notion login detected! Session saved.`);
      return page;
    }
    if ((i + 1) % 10 === 0) console.log(`   ⏳ Still waiting... (${(i + 1) * 3}s)`);
  }

  await closeNotionBrowser();
  throw new Error('Notion login timed out after 3 minutes.');
}

// Standalone: npx tsx src/browser/notion/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Notion Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToNotion({ nickname, headless: false });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('notion/login') || process.argv[1]?.includes('notion\\login')) main();

