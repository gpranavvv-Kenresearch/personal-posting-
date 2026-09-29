import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

export interface InstagramAccount {
  nickname: string;
  username: string;
  password?: string;
  active: boolean;
}

const ACCOUNTS_FILE = '.accounts/accounts-instagram.json';
const SESSION_ROOT  = '.sessions';

let browserContext: BrowserContext | null = null;

export function getInstagramAccounts(): InstagramAccount[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

export function getInstagramAccountByNickname(nickname: string): InstagramAccount | undefined {
  const accounts = getInstagramAccounts();
  const needle = nickname.toLowerCase();
  // No fallback to "any active account" — that silently substituted
  // whichever account happened to be first in the list (confirmed live
  // 2026-09-23: every nickname that wasn't actually in the file ended up
  // reusing "aniket"'s session instead of a clear "not found" error).
  return accounts.find(a => a.active && a.nickname.toLowerCase() === needle);
}

export async function closeInstagramBrowser(): Promise<void> {
  if (browserContext) {
    try { await browserContext.close(); } catch { /* already closed */ }
    browserContext = null;
  }
}

export async function loginToInstagram(account: InstagramAccount): Promise<Page> {
  if (browserContext) {
    try { await browserContext.close(); } catch {}
    browserContext = null;
  }

  const sessionDir = path.resolve(`${SESSION_ROOT}/instagram-${account.nickname}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!fs.existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}. Set CHROME_PATH env var.`);
  }

  // Every other platform in this project runs visibly (headless: false,
  // no env toggle) — Instagram was the one exception, defaulting to
  // headless unless HEADLESS=false was set. Confirmed live 2026-09-23: a
  // batch run died silently mid-flow with no error logged, consistent
  // with a headless-Chrome crash rather than a caught failure. Match the
  // rest of the project instead of guessing why headless was flakier here.
  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--window-size=1366,768',
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const existingPages = browserContext.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await browserContext.newPage();
  for (const p of existingPages.slice(1)) await p.close().catch(() => {});

  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if already logged in
  const homeIcon = page.locator('svg[aria-label="Home"], svg[aria-label="Search"]').first();
  if (await homeIcon.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log(`   Already logged in as ${account.username}`);
    return page;
  }

  // No password stored (accounts logged in via src/tools/loginInstagram.ts's
  // manual-session flow instead) — nothing to auto-fill. Hand the page back
  // and let the caller decide (batch code should treat "not logged in" as a
  // hard failure telling the user to run the manual login tool for this
  // nickname, same as Note).
  if (!account.password) {
    console.warn(`   ⚠️  No saved session for "${account.nickname}" and no password on file — run: npx tsx src/tools/loginInstagram.ts ${account.nickname}`);
    return page;
  }

  console.log(`   Logging in as ${account.username}...`);

  // Go to login page if not already there
  if (!page.url().includes('login')) {
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  }

  // Confirmed live 2026-09-23 via HTML dump: the real input name is "email",
  // not "username" — kept both, comma-separated, in case Instagram varies
  // this across accounts/sessions the way LinkedIn does for its own forms.
  const userField = page.locator('input[name="email"], input[name="username"]').first();
  // Confirmed live 2026-09-23 via HTML dump: password field is
  // name="pass", not name="password".
  const passField = page.locator('input[name="pass"], input[name="password"], input[type="password"]').first();
  // Confirmed live 2026-09-23 via HTML dump: the real login control is
  // <div role="button" aria-label="Log In">, not a <button type="submit">
  // at all — kept the old selector as a fallback in case that varies too.
  const loginBtn  = page.locator('div[role="button"][aria-label="Log In"], button[type="submit"]').first();

  try {
    await userField.waitFor({ state: 'visible', timeout: 15000 });
  } catch (err) {
    // Dump evidence instead of guessing why — could be a cookie-consent
    // dialog, a changed login form, or a checkpoint/challenge page.
    const debugDir = path.resolve('logs');
    fs.mkdirSync(debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(debugDir, `ig-login-timeout-${account.nickname}-${stamp}.png`) }).catch(() => {});
    fs.writeFileSync(path.join(debugDir, `ig-login-timeout-${account.nickname}-${stamp}.html`), await page.content().catch(() => ''), 'utf8');
    console.error(`   ⚠️  Username field never appeared (URL: ${page.url()}) — dumped ${debugDir}\\ig-login-timeout-${account.nickname}-${stamp}.*`);
    throw err;
  }
  await userField.fill(account.username);
  await page.waitForTimeout(500);
  await passField.fill(account.password);
  await page.waitForTimeout(500);
  await loginBtn.click();

  await page.waitForTimeout(5000);

  // Dismiss "Save your login info?" / "Turn on notifications?" dialogs
  for (const text of ['Not now', 'Not Now', 'Later']) {
    try {
      const btn = page.locator(`button:has-text("${text}"), [role="button"]:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1000);
      }
    } catch { /* ignore */ }
  }

  const loggedIn = await homeIcon.isVisible({ timeout: 8000 }).catch(() => false);
  if (!loggedIn) {
    console.warn(`   ⚠️  Login may not have completed for ${account.username} — check browser manually`);
  } else {
    console.log(`   ✅ Logged in as ${account.username}`);
  }

  return page;
}

