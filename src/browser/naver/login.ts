import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';

// TODO(locators): confirm login URL — section.blog.naver.com redirects through
// nid.naver.com for auth. Update if the redirect target changes.
const NAVER_LOGIN_URL = 'https://nid.naver.com/nidlogin.login';
const NAVER_HOME_URL = 'https://section.blog.naver.com/';

const NAVER_ACCOUNTS_FILE = '.accounts/accounts-naver.json';
const SESSION_ROOT = path.resolve('.sessions/naver');

export interface NaverAccount {
  email: string; // Naver ID (not necessarily an email address)
  password?: string;
  nickname?: string;
  blogId?: string; // Naver blog handle, e.g. blog.naver.com/<blogId>
  sessionDir?: string;
  active: boolean;
}

export function getNaverAccounts(): NaverAccount[] {
  if (!fs.existsSync(NAVER_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(NAVER_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveNaverAccount(): NaverAccount | null {
  return getNaverAccounts().find(a => a.active) || null;
}

export function getNaverAccountByNickname(nickname: string): NaverAccount | null {
  return getNaverAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Naver's auth cookies (NID_AUT/NID_SES) come back as session cookies (no
// expiry) unless the "stay signed in" (로그인 상태 유지) box is checked at
// login — checkNaverStaySignedIn() below handles that during automated
// login. This client-side rewrite is a second, independent layer on top:
// even with the box checked, Chromium purges session cookies on process
// restart inside a persistent context, so a fresh `npx tsx` run could still
// lose the login. Rewriting them with a far-future expiry right after login
// makes Chromium treat them as persistent locally. Both pieces matter — the
// checkbox controls Naver's SERVER-side session lifetime (this rewrite has
// no effect on that; a checkbox-less login gets logged out server-side
// after Naver's short "not remembered" TTL regardless of the local cookie
// expiry), while this rewrite controls the LOCAL browser-side persistence.
async function persistSessionCookies(context: BrowserContext): Promise<void> {
  // NID_SES (the actual session token, as opposed to the long-lived NID_AUT
  // "remember me" cookie) can be issued by a background request slightly
  // after the login redirect completes — grabbing cookies too early misses
  // it entirely, and it then evaporates as a normal session cookie.
  await sleep(3000);
  const cookies = await context.cookies();
  const naverCookies = cookies.filter(c => c.domain.includes('naver.com'));
  console.log(`   Cookies captured for persistence: ${naverCookies.map(c => `${c.name}${c.expires && c.expires > 0 ? '' : '(session)'}`).join(', ') || '(none)'}`);
  if (naverCookies.length === 0) return;
  const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
  const rewritten = naverCookies.map(c => ({
    ...c,
    expires: c.expires && c.expires > 0 ? c.expires : farFuture,
  }));
  await context.addCookies(rewritten);
}

// Naver's nidlogin.login page has a "로그인 상태 유지" (stay signed in)
// checkbox, id="keep". Checking it is what makes Naver issue a genuinely
// long-lived NID_AUT session server-side — without it, the session gets
// invalidated server-side after a short TTL regardless of local cookie
// expiry, which is the actual root cause of "logged in fine today, logged
// out again tomorrow." Best-effort: if the element isn't found (Naver
// changed the login page), login still proceeds — just without the fix.
async function checkNaverStaySignedIn(page: Page): Promise<void> {
  try {
    const keepBox = page.locator('#keep').first();
    if (await keepBox.isVisible({ timeout: 3000 }).catch(() => false)) {
      const checked = await keepBox.isChecked().catch(() => false);
      if (!checked) {
        await keepBox.check({ timeout: 2000 }).catch(() => keepBox.click({ timeout: 2000 }));
      }
      console.log('   ✅ "로그인 상태 유지" (stay signed in) checked');
    } else {
      console.warn('   ⚠️ "Stay signed in" checkbox not found — session may expire faster than expected');
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not check "stay signed in" box: ${err.message}`);
  }
}

let browserContext: BrowserContext | null = null;

export async function closeNaverBrowser(): Promise<void> {
  if (browserContext) {
    // JSESSIONID (section.blog.naver.com's actual blog-write session cookie)
    // is only created once postToNaver() navigates to BlogHome — well after
    // the post-login persistSessionCookies() call already ran. Rewrite again
    // here, right before shutdown, so it captures whatever accumulated
    // during the whole session instead of just what existed at login time.
    await persistSessionCookies(browserContext).catch(() => {});
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Naver browser closed.');
  }
}

// Confirmed against a real logged-in BlogHome screenshot (2026-07-22): the
// "글쓰기" (write) link and "로그아웃" (logout) button are both visible in the
// profile panel only when actually authenticated.
async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes('nidlogin')) return false;
    const selectors = [
      'a[href="https://blog.naver.com/GoBlogWrite.naver"]', // "글쓰기" write link
      'button:has-text("로그아웃")',
      'a:has-text("로그아웃")',
    ];
    for (const sel of selectors) {
      if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// BlogHome.naver is a heavy React SPA — a single isLoggedIn() check right
// after navigation can false-negative if the write/logout elements haven't
// hydrated yet, forcing a needless full re-login on an already-valid
// session. Poll for up to ~15s instead of trusting one snapshot.
async function waitForLoggedInOnLoad(page: Page): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    if (await isLoggedIn(page)) return true;
    await sleep(2000);
  }
  return false;
}

export async function loginToNaver(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getNaverAccountByNickname(options.nickname) ?? getActiveNaverAccount()
    : getActiveNaverAccount();

  if (!account) throw new Error('No Naver account found in .accounts/accounts-naver.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Naver session: ${sessionDir}`);

  // headless:false and no auto-minimize — Naver login can require solving a
  // captcha by hand (see TODO below), so the window must actually be visible
  // for a manual login run, same as Coda's login flow.
  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: null,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
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

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  console.log('   Checking Naver session...');
  await page.goto(NAVER_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (await waitForLoggedInOnLoad(page)) {
    console.log(`   ✅ Already logged in to Naver (${account.nickname})`);
    await persistSessionCookies(browserContext);
    return page;
  }

  console.log('   Not logged in — starting Naver login...');
  await page.goto(NAVER_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // TODO(locators): Naver aggressively flags automated fast typing/paste on the
  // login form and can trigger a captcha. Fill in confirmed selectors + a
  // human-like typing delay once provided — do not use page.fill() here.
  if (account.email && account.password) {
    try {
      const idInput = page.locator('#id').first();
      await idInput.waitFor({ state: 'visible', timeout: 10000 });
      await idInput.click();
      await page.keyboard.type(account.email, { delay: 120 });
      await sleep(400);

      const pwInput = page.locator('#pw').first();
      await pwInput.click();
      await page.keyboard.type(account.password, { delay: 120 });
      await sleep(400);

      await checkNaverStaySignedIn(page);

      const loginBtn = page.locator('#log\\.login').first();
      if (await loginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await loginBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await sleep(3000);
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Naver login: ${err.message}`);
      console.log('   👉 Please log in manually — CHECK "로그인 상태 유지" (stay signed in) before submitting, or the session will get logged out again within a day.\n');
    }
  } else {
    console.log('   👉 Please log in manually — CHECK "로그인 상태 유지" (stay signed in) before submitting, or the session will get logged out again within a day.\n');
  }

  console.log('   ⏳ Waiting for login (up to 3 minutes)...');
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    if (await isLoggedIn(page)) {
      console.log(`\n   ✅ Naver login detected! Session saved.`);
      await persistSessionCookies(browserContext!);
      return page;
    }
    if ((i + 1) % 10 === 0) console.log(`   ⏳ Still waiting... (${(i + 1) * 3}s)`);
  }

  await closeNaverBrowser();
  throw new Error('Naver login timed out after 3 minutes.');
}

async function waitForEnter(promptText: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(promptText);
  rl.close();
}

/**
 * Same as loginToNaver(), but for the interactive one-time session-save script:
 * the isLoggedIn() selectors are unconfirmed (see TODOs above), so instead of
 * polling them for up to 3 minutes, this explicitly asks you to press Enter in
 * the terminal once you've finished logging in by hand.
 */
export async function loginToNaverInteractive(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getNaverAccountByNickname(options.nickname) ?? getActiveNaverAccount()
    : getActiveNaverAccount();

  if (!account) throw new Error('No Naver account found in .accounts/accounts-naver.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Naver session: ${sessionDir}`);

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: null,
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
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

  const existingPages = browserContext.pages();
  let page: Page;
  if (existingPages.length > 0) {
    page = existingPages[0];
    for (const p of existingPages.slice(1)) await p.close().catch(() => {});
  } else {
    page = await browserContext.newPage();
  }

  console.log('   Checking Naver session...');
  await page.goto(NAVER_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (await waitForLoggedInOnLoad(page)) {
    console.log(`   ✅ Already logged in to Naver (${account.nickname})`);
    await persistSessionCookies(browserContext);
    return page;
  }

  console.log('   Not logged in — starting Naver login...');
  await page.goto(NAVER_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // Auto-check "stay signed in" right away so the session survives past today
  // even if you don't notice/click the box yourself — this is the actual fix
  // for "logged in fine today, logged out again tomorrow": without it, Naver
  // invalidates the session server-side within a day regardless of what gets
  // cookie-persisted locally. Best-effort — if the page structure changed and
  // the box can't be found, you still need to check it by hand (see the
  // fallback message below).
  await checkNaverStaySignedIn(page);

  console.log('   ⚠️  Naver: no active session — please log in manually in the open browser window (solve captcha if prompted).');
  console.log('   👉 "로그인 상태 유지" (stay signed in) has been auto-checked — verify it\'s still ticked before submitting. If you don\'t see it checked, click it yourself, or the session will expire within a day.');
  await waitForEnter('   Press Enter here once you have finished logging in... ');

  // isLoggedIn() selectors are unconfirmed, so don't gate success on them —
  // just make sure the page actually left the login URL.
  await page.goto(NAVER_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(2000);

  if (page.url().includes('nidlogin')) {
    await closeNaverBrowser();
    throw new Error('Naver: still on login page after confirmation — login did not complete.');
  }

  await persistSessionCookies(browserContext);
  console.log(`\n   ✅ Naver login confirmed! Session saved (${account.nickname}).`);
  return page;
}

// Standalone: npx tsx src/browser/naver/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Naver Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToNaver({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('naver/login') || process.argv[1]?.includes('naver\\login')) main();
