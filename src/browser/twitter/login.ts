import { chromium, BrowserContext, Page } from 'playwright';
import { humanDelay } from '../stagehand.js';
import { Account } from '../../config/accounts.js';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

let browserContext: BrowserContext | null = null;
let loginPage: Page | null = null;

export async function closeBrowser() {
  // Close via persistent context — properly flushes cookies to disk before closing
  if (loginPage) {
    await loginPage.close().catch(() => {});
    loginPage = null;
  }
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }
  console.log('   Browser closed.');
}

async function launchPersistentChrome(profileDir: string): Promise<{ context: BrowserContext; page: Page }> {
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  fs.mkdirSync(profileDir, { recursive: true });
  await killChromeForProfile(profileDir);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    chromiumSandbox: true,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Needed for the "Share → Copy link" step in poster.ts to read the tweet URL
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await context.addInitScript(() => {
    // Remove Playwright/CDP artifacts that automation detectors look for
    const win = window as any;
    delete win.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete win.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete win.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    delete win.__playwright;
    delete win.__pw_manual;
    delete win.__PW_inspect_computed_accessibility_info;

    // webdriver must return undefined (not false) — false is itself a signal
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Realistic platform/hardware fingerprint
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

    // Real Chrome always has plugins; empty list is a bot signal
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr: any[] = [
          { name: 'Chrome PDF Plugin',  description: 'Portable Document Format', filename: 'internal-pdf-viewer', length: 0 },
          { name: 'Chrome PDF Viewer',  description: '',                          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', length: 0 },
          { name: 'Native Client',      description: '',                          filename: 'internal-nacl-plugin', length: 0 },
        ];
        Object.defineProperty(arr, 'item', { value: (i: number) => arr[i] });
        Object.defineProperty(arr, 'namedItem', { value: (n: string) => arr.find(p => p.name === n) || null });
        return arr;
      },
    });

    // Permissions query — sites probe notification state to fingerprint bots
    const _origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc: any) =>
      desc.name === 'notifications'
        ? Promise.resolve({ state: (win.Notification || {}).permission || 'default', onchange: null } as PermissionStatus)
        : _origQuery(desc);

    // Full chrome object — absence is detected
    win.chrome = {
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
      runtime: { id: undefined, onConnect: { addListener: () => {} }, onMessage: { addListener: () => {} } },
      loadTimes: () => ({}),
      csi: () => ({}),
    };
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  page.on('dialog', async (d) => { await d.dismiss().catch(() => {}); });

  return { context, page };
}

const SESSION_DIR = path.resolve('.sessions/chrome-profile');

async function hasLoggedInXUi(page: Page): Promise<boolean> {
  const loggedInSelectors = [
    '[data-testid="SideNav_NewTweet_Button"]',
    '[data-testid="tweetButtonInline"]',
    'a[href="/compose/tweet"]',
    'a[data-testid="AppTabBar_Home_Link"]',
  ];

  for (const selector of loggedInSelectors) {
    const visible = await page.locator(selector).first().isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) return true;
  }

  return false;
}

async function saveXLoginDebug(page: Page, handle: string, step: string): Promise<string> {
  const outDir = path.resolve('debug', `x-login-${handle}`);
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `${step}.png`), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(outDir, `${step}.html`), await page.content().catch(() => ''), 'utf8');
  return outDir;
}


function getSessionStatePath(account?: Account): string | null {
  const candidate =
    account?.sessionStatePath ||
    account?.storageState ||
    (account?.sessionDir?.toLowerCase().endsWith('.json') ? account.sessionDir : undefined);

  return candidate ? path.resolve(candidate) : null;
}

function getSessionProfileDir(account?: Account): string {
  return account?.sessionDir && !account.sessionDir.toLowerCase().endsWith('.json')
    ? path.resolve(account.sessionDir)
    : SESSION_DIR;
}

async function launchSavedSessionChrome(account: Account | undefined, handle: string): Promise<Page | null> {
  const sessionDir = getSessionProfileDir(account);

  if (!fs.existsSync(sessionDir)) {
    console.warn(`   X session folder not found: ${sessionDir}`);
    return null;
  }

  console.log(`   Loading X session: ${sessionDir}`);
  const { context, page } = await launchPersistentChrome(sessionDir);
  browserContext = context;
  loginPage = page;

  // No login verification — session dir exists, so trust it and go straight
  // to automation. Skips hasLoggedInXUi() entirely.
  await loginPage.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(3000, 4000);

  console.log(`   ✅ Opened X session for ${handle} (login not checked)`);
  return loginPage;
}

/**
 * Returns true if the session directory exists and has at least one cookie/storage file.
 * A missing or empty session dir means the account was never logged in — throw immediately
 * so the batch can write a human-review-login alert without launching Chrome.
 */
export function isSessionReady(account?: Account): boolean {
  const statePath = getSessionStatePath(account);
  if (statePath) return fs.existsSync(statePath);

  const sessionDir = getSessionProfileDir(account);
  if (!fs.existsSync(sessionDir)) return false;
  // Playwright stores cookies in "Default/Cookies" (Chrome) or "Default/Network/Cookies"
  const cookiesPath1 = path.join(sessionDir, 'Default', 'Cookies');
  const cookiesPath2 = path.join(sessionDir, 'Default', 'Network', 'Cookies');
  return fs.existsSync(cookiesPath1) || fs.existsSync(cookiesPath2);
}

export async function loginToX(account?: Account): Promise<Page> {
  // Close any existing browser before opening a new one (prevents two browsers from appearing)
  if (browserContext) {
    console.log('   Closing existing browser before opening new one...');
    await closeBrowser();
  }

  const username = account?.username || process.env.X_USERNAME!;
  const password = account?.password || process.env.X_PASSWORD!;
  const handle = account?.handle || process.env.X_HANDLE || username;

  console.log('   Checking saved X session...');
  const sessionPage = await launchSavedSessionChrome(account, handle).catch(async (err: any) => {
    console.warn(`   Saved X session failed: ${err.message}`);
    await closeBrowser().catch(() => {});
    return null;
  });
  if (sessionPage) return sessionPage;

  if (!username || !password) {
    throw new Error(`X_CREDENTIALS_MISSING:${handle} — account username/password or X_USERNAME/X_PASSWORD env vars are required`);
  }

  console.log('   Launching fresh Chrome for login...');
  const properSessionDir = getSessionProfileDir(account);
  const launched = await launchPersistentChrome(properSessionDir);
  browserContext = launched.context;
  loginPage = launched.page;

  browserContext.on('page', async (newPage) => {
    if (!loginPage || newPage === loginPage) return;
    console.warn(`   Closing unexpected new tab: ${newPage.url()}`);
    await newPage.close().catch(() => {});
  });

  console.log('   Browser launched!');

  console.log('   Opening X login flow...');
  await loginPage.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await humanDelay(2000, 3000);

  // Fill username
  console.log('   Typing username...');
  const userInput = loginPage.locator('input[name="text"], input[autocomplete="username"]').first();
  await userInput.waitFor({ state: 'visible', timeout: 30000 });
  await userInput.click();
  await humanDelay(400, 700);
  await userInput.fill('');
  await humanDelay(200, 300);
  await userInput.type(username, { delay: 30 });
  await humanDelay(800, 1200);

  // Click Next button (fallback to Enter)
  const nextButton = loginPage.locator(
    '[data-testid="LoginForm_Login_Button"], div[role="button"]:has-text("Next"), button[role="button"]:has-text("Next")'
  );
  if (await nextButton.first().isVisible().catch(() => false)) {
    await nextButton.first().click();
  } else {
    await loginPage.keyboard.press('Enter');
  }
  await humanDelay(2000, 3000);
  console.log(`   URL after username: ${loginPage.url()}`);

  const passwordVisibleAfterUsername = await loginPage.locator('input[name="password"]').first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  const verificationVisibleAfterUsername = await loginPage.locator('input[data-testid="ocfEnterTextTextInput"]').first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  const usernameStillVisible = await loginPage.locator('input[name="text"], input[autocomplete="username"]').first()
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!passwordVisibleAfterUsername && !verificationVisibleAfterUsername && usernameStillVisible) {
    const debugDir = await saveXLoginDebug(loginPage, handle, 'username-step-stuck');
    throw new Error(
      `X_USERNAME_STEP_STUCK:${handle} — X stayed on the username screen after Next. ` +
      `Manual login is required. Debug saved at ${debugDir}`
    );
  }

  // Security check / verification step — X often asks for the handle here.
  try {
    const sec = loginPage.locator('input[data-testid="ocfEnterTextTextInput"]');
    if (await sec.isVisible({ timeout: 10000 })) {
      console.log('   Security check...');
      await sec.click();
      await sec.fill('');
      await humanDelay(200, 300);
      await sec.type(handle, { delay: 30 });
      await humanDelay(800, 1200);
      const secNext = loginPage.locator(
        '[data-testid="ocfEnterTextNextButton"], div[role="button"]:has-text("Next"), button:has-text("Next")'
      );
      if (await secNext.first().isVisible().catch(() => false)) {
        await secNext.first().click();
      } else {
        await loginPage.keyboard.press('Enter');
      }
      await humanDelay(2000, 3000);
    }
  } catch { /* no security check */ }

  // Fill password
  console.log('   Typing password...');
  const passInput = loginPage.locator('input[name="password"]').first();
  if (!await passInput.isVisible({ timeout: 10000 }).catch(() => false)) {
    const verifyAgain = loginPage.locator('input[data-testid="ocfEnterTextTextInput"]').first();
    if (await verifyAgain.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('   Verification step before password...');
      await verifyAgain.click();
      await verifyAgain.fill('');
      await humanDelay(200, 300);
      await verifyAgain.type(handle, { delay: 30 });
      await humanDelay(800, 1200);
      const verifyNext = loginPage.locator(
        '[data-testid="ocfEnterTextNextButton"], div[role="button"]:has-text("Next"), button:has-text("Next")'
      );
      if (await verifyNext.first().isVisible().catch(() => false)) {
        await verifyNext.first().click();
      } else {
        await loginPage.keyboard.press('Enter');
      }
      await humanDelay(2000, 3000);
    }
  }
  await passInput.waitFor({ state: 'visible', timeout: 30000 });
  await passInput.click();
  await humanDelay(400, 700);
  await passInput.fill('');
  await humanDelay(200, 300);
  await passInput.type(password, { delay: 30 });
  await humanDelay(800, 1200);

  // Click Log in button (fallback to Enter)
  const loginButton = loginPage.locator('div[role="button"]:has-text("Log in"), button:has-text("Log in")');
  if (await loginButton.first().isVisible().catch(() => false)) {
    await loginButton.first().click();
  } else {
    await loginPage.keyboard.press('Enter');
  }
  await humanDelay(3000, 4000);

  // Handle possible phone/email verification challenge
  try {
    const verifyInput = loginPage.locator('input[data-testid="ocfEnterTextTextInput"]');
    if (await verifyInput.isVisible({ timeout: 3000 })) {
      console.log('   Phone/email verification challenge...');
      await verifyInput.click();
      await verifyInput.fill('');
      await humanDelay(200, 300);
      await verifyInput.type(handle, { delay: 30 });
      await humanDelay(800, 1200);
      const verifyNext = loginPage.locator(
        '[data-testid="ocfEnterTextNextButton"], div[role="button"]:has-text("Next"), button:has-text("Next")'
      );
      if (await verifyNext.first().isVisible().catch(() => false)) {
        await verifyNext.first().click();
      } else {
        await loginPage.keyboard.press('Enter');
      }
      await humanDelay(3000, 4000);
    }
  } catch { /* no verification challenge */ }

  // Wait for navigation away from login page
  try {
    await loginPage.waitForFunction(
      () => !window.location.href.includes('/flow/login'),
      { timeout: 15000 }
    );
  } catch {
    console.log('   ⚠️  Still on login page — may need manual intervention');
  }

  if (!await hasLoggedInXUi(loginPage)) {
    const debugDir = await saveXLoginDebug(loginPage, handle, 'login-not-confirmed');
    throw new Error(
      `X_LOGIN_NOT_CONFIRMED:${handle} — logged-in X UI was not detected. Debug saved at ${debugDir}`
    );
  }

  console.log(`   URL after login: ${loginPage.url()}`);
  console.log('✅ Login done!');
  return loginPage;
}

