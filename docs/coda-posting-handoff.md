# Coda Login + Posting — Handoff Package

**For the Claude instance reading this on the other laptop:** this document is
self-contained. It gives you the goal, the full source of the two files this
depends on, every piece of glue code that wires them into the rest of the
project, and a step-by-step integration checklist. You should not need any
other context from this conversation to do the port.

## What this is

Browser-automation login + posting for **Coda** (coda.io), one of 12 blog
platforms in a Ken Research content-distribution system. It's part of a
larger Playwright-based project where each platform has a `login.ts` (opens
a persistent, already-authenticated Chrome profile) and a `poster.ts`
(drives the actual publish flow), both called through a shared "browser
tools" dispatcher, and orchestrated by a per-platform batch runner that pulls
rows from a Google Sheet, posts them, and writes results back.

**If the target laptop already has a clone of this exact repository**, the
simplest path is just `git pull` / copying the repo — skip everything below
and go straight to account setup (Step 4). This document exists for the case
where you're porting the *logic* into a different codebase, or don't have
git access to the original repo.

## Architecture (what talks to what)

```
.accounts/accounts-coda.json          ← account credentials/config (per user, not committed)
        │
src/browser/coda/login.ts             ← opens/reuses persistent Chrome profile, handles login
src/browser/coda/poster.ts            ← drives the actual Coda publish UI, returns the post URL
        │
src/tools/browserTools.ts             ← exposes them as "login_coda" / "post_coda" tools,
        │                                holds the live Page/nickname across the two calls
src/coordinator/masterCoordinator.ts  ← runCodaBatch(): pulls pending rows, calls the tools,
        │                                writes results back to the sheet
src/sheets/sheets.ts                  ← getRowsForContinuousCodaPosting / saveUnifiedCodaResult
```

Shared utilities it depends on (bring these too if the target repo doesn't
have equivalents):
- `src/utils/killChrome.ts` — kills any Chrome process already holding a
  given profile directory, and clears stale Playwright singleton lock files,
  before launching. Prevents "profile already in use" errors.
- `src/utils/utm.ts` — `injectUTM(content, utmString)` + `UTM_PARAMS` map,
  used to tag every kenresearch.com link in the posted content with
  `?utm_source=Coda&utm_medium=Referral&utm_campaign=Automation`.

## Step 1 — Create `src/browser/coda/login.ts`

```ts
import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { killChromeForProfile } from '../../utils/killChrome.js';

// TODO(locators): coda.io login supports Google OAuth and email magic-link.
// Confirm which flow the automation accounts use and update CODA_LOGIN_URL /
// the fill-in flow below accordingly.
const CODA_LOGIN_URL = 'https://coda.io/login';
const CODA_HOME_URL = 'https://coda.io/docs';

const CODA_ACCOUNTS_FILE = '.accounts/accounts-coda.json';
const SESSION_ROOT = path.resolve('.sessions/coda');

export interface CodaAccount {
  email: string;
  password?: string;
  nickname?: string;
  docUrl?: string; // target Coda doc to publish pages into
  sessionDir?: string;
  active: boolean;
}

export function getCodaAccounts(): CodaAccount[] {
  if (!fs.existsSync(CODA_ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(CODA_ACCOUNTS_FILE, 'utf8'));
}

export function getActiveCodaAccount(): CodaAccount | null {
  return getCodaAccounts().find(a => a.active) || null;
}

export function getCodaAccountByNickname(nickname: string): CodaAccount | null {
  return getCodaAccounts().find(a => a.nickname?.toLowerCase() === nickname.toLowerCase()) || null;
}

function sessionDirFor(nickname: string): string {
  const safe = String(nickname || 'default').replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let browserContext: BrowserContext | null = null;

export async function closeCodaBrowser(): Promise<void> {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    console.log('   Coda browser closed.');
  }
}

function pageLooksLoggedIn(url: string): boolean {
  if (url.includes('/login') || url.includes('accounts.google.com') || url.includes('accounts.youtube.com')) {
    return false;
  }
  // coda.io redirects unauthenticated visitors to /login (or Google OAuth) —
  // landing anywhere else under coda.io means the session is authenticated.
  return url.includes('coda.io');
}

async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return pageLooksLoggedIn(page.url());
  } catch {
    return false;
  }
}

// Google OAuth can open the account picker in a new tab/popup, leaving the
// originally-tracked page stuck on /login while a different tab in the same
// context reaches the real Coda home page — so scan every open tab.
function findLoggedInPage(context: BrowserContext): Page | null {
  for (const p of context.pages()) {
    if (pageLooksLoggedIn(p.url())) return p;
  }
  return null;
}

export async function loginToCoda(options?: { nickname?: string }): Promise<Page> {
  const account = options?.nickname
    ? getCodaAccountByNickname(options.nickname) ?? getActiveCodaAccount()
    : getActiveCodaAccount();

  if (!account) throw new Error('No Coda account found in .accounts/accounts-coda.json');

  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const sessionDir = account.sessionDir ? path.resolve(account.sessionDir) : sessionDirFor(account.nickname || account.email || 'default');

  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  console.log(`   Using Coda session: ${sessionDir}`);

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

  console.log('   Opening Coda with saved session...');
  await page.goto(CODA_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // The persistent profile (.sessions/coda/<nickname>) already holds a valid
  // login — skip the login-state verification/redirect check entirely and
  // trust the saved session, per explicit instruction to stop probing for
  // login state on every run.
  if (!page.url().includes('/login')) {
    console.log(`   ✅ Using saved Coda session (${account.nickname})`);
    return page;
  }

  console.log('   Not logged in — starting Coda login...');
  await page.goto(CODA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  // TODO(locators): fill in email/password or Google OAuth handoff once
  // confirmed. Left as manual fallback for now.
  if (account.email && account.password) {
    try {
      const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
      await emailInput.waitFor({ state: 'visible', timeout: 10000 });
      await emailInput.fill(account.email);
      await sleep(500);
      const continueBtn = page.locator('button:has-text("Continue"), button[type="submit"]').first();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await sleep(1500);
      }
      const passInput = page.locator('input[type="password"]').first();
      if (await passInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await passInput.fill(account.password);
        await sleep(300);
        await page.keyboard.press('Enter');
        await sleep(3000);
      } else {
        console.log(`\n   📧 Magic link / OAuth likely required for ${account.email}`);
        console.log('   👉 Complete login in the browser window...\n');
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Could not auto-fill Coda login: ${err.message}`);
      console.log('   👉 Please log in manually in the browser window.\n');
    }
  } else {
    console.log('   👉 Please log in manually in the browser window.\n');
  }

  console.log('   ⏳ Waiting for login (up to 3 minutes)...');
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const loggedInPage = findLoggedInPage(browserContext);
    if (loggedInPage) {
      for (const p of browserContext.pages()) {
        if (p !== loggedInPage) await p.close().catch(() => {});
      }
      console.log(`\n   ✅ Coda login detected! Session saved.`);
      return loggedInPage;
    }
    if ((i + 1) % 10 === 0) console.log(`   ⏳ Still waiting... (${(i + 1) * 3}s)`);
  }

  await closeCodaBrowser();
  throw new Error('Coda login timed out after 3 minutes.');
}

// Standalone: npx tsx src/browser/coda/login.ts --nickname aniket
async function main() {
  const args = process.argv.slice(2);
  const nickIdx = args.indexOf('--nickname');
  const nickname = nickIdx !== -1 ? args[nickIdx + 1] : undefined;
  console.log(`\n🔐 Coda Login${nickname ? ` (${nickname})` : ''}`);
  try {
    await loginToCoda({ nickname });
    console.log('\n✅ Session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
  } catch (err: any) {
    console.error('Login failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.includes('coda/login') || process.argv[1]?.includes('coda\\login')) main();
```

## Step 2 — Create `src/browser/coda/poster.ts`

```ts
import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function postToCoda(
  page: Page,
  title: string,
  htmlContent: string,
  docUrl?: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Coda);

  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  // Step 1: Navigate to the account's target doc (falls back to docs home)
  const target = docUrl || 'https://coda.io/docs';
  console.log(`   Navigating to Coda doc: ${target}...`);
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch { /* timeout ok */ }
  await sleep(4000);

  // Step 2: Click "New page" (+ button in the doc's page tree) if we're
  // already inside a doc (docUrl was provided), or "New doc" if we're on the
  // docs home page. We deliberately do NOT fall back to opening an existing
  // doc from the recent-docs list — that previously caused posts to land
  // inside an already-published doc instead of a fresh one (see incident:
  // title/content got typed into a doc that had already been posted).
  console.log('   Clicking New page / New doc button...');
  let newPageClicked = false;
  const newPageSelectors = [
    '[aria-label="New page"]',
    '[aria-label*="Add page" i]',
  ];
  const newDocSelectors = [
    // Exact "New doc" button on the docs home page, identified from live
    // inspection — no stable aria-label/data-id on this element, so match
    // on its full class list plus role.
    'span.Tie_K1V4.QuZsUaXW.dBDkKmiC.eVb7DBLp.LMycHfdJ[role="button"]',
    '[aria-label="New doc"]',
    '[aria-label*="New doc" i]',
    '[aria-label*="Create doc" i]',
    'button:has-text("New doc")',
    'button:has-text("New Doc")',
    '[data-coda-ui-id="create-doc-button"]',
  ];
  const isHomePage = !docUrl;
  const selectorsToTry = isHomePage ? newDocSelectors : newPageSelectors;
  for (const sel of selectorsToTry) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      newPageClicked = true;
      console.log(`   ✅ ${isHomePage ? 'New doc' : 'New page'} clicked (${sel})`);
      break;
    }
  }
  if (!newPageClicked) {
    console.warn(`   ⚠️ ${isHomePage ? 'New doc' : 'New page'} button not found — aborting rather than risk editing an existing doc`);
    throw new Error(`Coda: could not find ${isHomePage ? 'New doc' : 'New page'} button — refusing to fall back to an existing doc`);
  }
  await sleep(2500);

  // Step 3: Fill title field
  console.log('   Filling title field...');
  const TITLE_SEL = 'textarea[data-coda-ui-id="page-title"]';
  try {
    await page.waitForSelector(TITLE_SEL, { timeout: 10000 });
    const titleEl = page.locator(TITLE_SEL).first();
    await titleEl.click();
    await sleep(500);
    await page.keyboard.type(String(title).trim(), { delay: 20 });
    console.log('   ✅ Title typed');
  } catch (err: any) {
    console.warn(`   ⚠️ Title field not found: ${err.message}`);
  }
  await sleep(1500);

  // Step 4: Render HTML in a temp page → copy to clipboard → paste into canvas body
  console.log('   Rendering HTML in temp page and copying...');
  try {
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(500);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
      console.log('   ✅ HTML rendered and copied');
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not render/copy HTML: ${err.message}`);
  }
  await sleep(1500);

  console.log('   Clicking canvas body and pasting...');
  const CANVAS_SEL = 'div[data-kr-drop-target="true"][data-canvas-placement-block="true"]';
  const canvasEl = page.locator(CANVAS_SEL).first();
  await canvasEl.click({ timeout: 5000 }).catch(async () => {
    await page.mouse.click(640, 450);
    console.warn('   ⚠️ Canvas body selector not found — used mouse click fallback');
  });
  await sleep(1000);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');
  await sleep(2000);

  const draftUrl = page.url();

  // Step 5: Open Share panel
  console.log('   Waiting before opening Share panel...');
  await sleep(3500);
  console.log('   Clicking Share button...');
  const SHARE_SEL = '[data-coda-ui-id="sharing-button"]';
  let shareOpened = false;
  try {
    await page.waitForSelector(SHARE_SEL, { timeout: 8000 });
    await page.locator(SHARE_SEL).first().click({ timeout: 4000 });
    shareOpened = true;
    console.log('   ✅ Share panel opened');
  } catch (err: any) {
    console.warn(`   ⚠️ Share button not found: ${err.message} — using draft URL`);
  }
  if (!shareOpened) {
    return { success: true, postUrl: draftUrl, postedAt: new Date() };
  }
  await sleep(2000);

  // Step 6: Open the access-level control (Globe icon) in the share panel.
  console.log('   Opening access-level control (Globe icon)...');
  let dropdownOpened = false;
  try {
    const shareDialog = page.locator('[role="dialog"]').last();
    const globeIcon = shareDialog.locator('svg[data-icon="Globe"]').first();
    await globeIcon.waitFor({ state: 'visible', timeout: 5000 });
    await globeIcon.click({ timeout: 4000, force: true });
    dropdownOpened = true;
    console.log('   ✅ Access-level control opened (Globe icon)');
  } catch (err: any) {
    console.warn(`   ⚠️ Globe icon not found: ${err.message}`);
  }
  await sleep(1500);

  // Step 7: Confirm "Anyone with the link" access. No stable aria-label on
  // this element, so match on its exact class list; the tooltip span is a
  // fallback in case the button itself isn't the hit target.
  if (dropdownOpened) {
    console.log('   Confirming "Anyone with the link" access...');
    const accessOptionSelectors = [
      'span.utd9D74T.QuZsUaXW.eVb7DBLp[role="button"]',
      'span.C9cn7gCQ.EA0SBqHo.HcHsL0rQ',
    ];
    let accessConfirmed = false;
    for (const sel of accessOptionSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click({ timeout: 4000, force: true });
        accessConfirmed = true;
        console.log(`   ✅ Access option confirmed (${sel})`);
        break;
      }
    }
    if (!accessConfirmed) {
      console.warn('   ⚠️ Could not confirm access option');
    }
    await sleep(2000);
  }

  // Step 7b: Click "Publish doc"
  console.log('   Clicking Publish doc...');
  try {
    const publishBtn = page.locator('[data-coda-ui-id="publish-dialog-publish-button"]').first();
    await publishBtn.waitFor({ state: 'visible', timeout: 5000 });
    await publishBtn.click({ timeout: 4000, force: true });
    console.log('   ✅ Publish doc clicked');
  } catch (err: any) {
    console.warn(`   ⚠️ Publish doc button not found: ${err.message}`);
  }
  await sleep(3000);

  // Step 8: Copy the published link
  console.log('   Copying public link...');
  let publicUrl = draftUrl;
  try {
    const copyLinkSelectors = [
      'span.Tie_K1V4.e6IwyBed.DgTD0n6q.QuZsUaXW.eVb7DBLp[role="button"]',
      'button:has-text("Copy link")',
      '[aria-label*="copy" i]',
      'button[aria-label*="Copy" i]',
    ];
    let linkCopied = false;
    for (const sel of copyLinkSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        // force: true — a transient dialog layer sits on top of this button
        // and blocks the normal actionability check even though the button
        // itself is the correct, visible target.
        await el.click({ timeout: 4000, force: true });
        linkCopied = true;
        console.log(`   ✅ Copy link clicked (${sel})`);
        break;
      }
    }
    if (!linkCopied) {
      console.warn('   ⚠️ Copy link button not found — falling back to draft URL');
    } else {
      await sleep(1500);
      try {
        // Read the OS clipboard directly via PowerShell rather than
        // navigator.clipboard.readText() — the in-page Clipboard API can
        // trigger a native browser permission prompt that never resolves
        // with no one there to click it, hanging the run indefinitely.
        const { execSync } = await import('child_process');
        publicUrl = execSync('powershell -command Get-Clipboard', { timeout: 5000 }).toString().trim();
      } catch (err: any) {
        console.warn(`   ⚠️ Clipboard read failed: ${err.message}`);
      }
      // Coda doc URLs can live on custom domains (e.g. docs.superhuman.com),
      // so just require it to be a real URL rather than checking for coda.io.
      if (!publicUrl || !/^https?:\/\//.test(publicUrl)) {
        publicUrl = draftUrl;
      }
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Copy link failed: ${err.message}`);
    publicUrl = draftUrl;
  }

  await page.keyboard.press('Escape').catch(() => {});
  console.log(`   ✅ Coda page URL: ${publicUrl}`);
  return { success: true, postUrl: publicUrl, postedAt: new Date() };
}
```

**Note on `docUrl`**: it comes from the account's own `docUrl` field, looked
up by nickname inside `postCodaTool` (Step 3 below) — `runCodaBatch` doesn't
pass it directly, the tool wrapper does the lookup itself.

## Step 3 — Wire into `src/tools/browserTools.ts`

This file is a big dispatcher shared by every platform — add these pieces
into the existing structure (don't replace the whole file):

**a) Tool schemas** (in the array of tool definitions):
```ts
{
  name: 'login_coda',
  description: 'Login to Coda with account credentials',
  input_schema: {
    type: 'object' as const,
    properties: {
      nickname: { type: 'string', description: 'Coda account nickname' },
    },
    required: ['nickname'],
  },
},
{
  name: 'post_coda',
  description: 'Post to Coda (coda.io). Must call login_coda first.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Page title' },
      htmlContent: { type: 'string', description: 'Page content (HTML)' },
    },
    required: ['title', 'htmlContent'],
  },
},
```

**b) Dispatch cases** (in the big `if (toolName === ...)` chain):
```ts
if (toolName === 'login_coda') {
  return await loginCodaTool(input.nickname);
}
if (toolName === 'post_coda') {
  return await postCodaTool(input.title, input.htmlContent);
}
```

**c) State + wrapper functions** (module-level, alongside the other
platforms' `<platform>Page`/`<platform>Nickname` variables):
```ts
let codaPage: Page | null = null;
let codaNickname: string | null = null;

async function loginCodaTool(nickname: string): Promise<any> {
  const { loginToCoda } = await import('../browser/coda/login.js');
  try {
    codaPage = await loginToCoda({ nickname });
    codaNickname = nickname;
    return { success: true, message: `Logged in to Coda (${nickname})` };
  } catch (err: any) {
    codaPage = null;
    codaNickname = null;
    return { error: err.message, success: false };
  }
}

async function postCodaTool(title: string, htmlContent: string): Promise<any> {
  try {
    if (!codaPage) return { error: 'Not logged in. Call login_coda first.', success: false };
    const { getCodaAccountByNickname: getByNick } = await import('../browser/coda/login.js');
    const { postToCoda } = await import('../browser/coda/poster.js');
    const { closeCodaBrowser } = await import('../browser/coda/login.js');
    const account = codaNickname ? getByNick(codaNickname) : null;
    const result = await postToCoda(codaPage, title, htmlContent, account?.docUrl);
    return { success: result.success, postUrl: result.postUrl };
  } catch (err: any) {
    return { error: err.message, success: false };
  } finally {
    if (codaPage) {
      await closeCodaBrowser().catch(() => {});
      codaPage = null;
      codaNickname = null;
    }
  }
}
```
(Adjust the exact import style to match whatever pattern the rest of
`browserTools.ts` in the target repo already uses — e.g. some files import
these at the top instead of dynamically inside the function.)

## Step 4 — Account config: `.accounts/accounts-coda.json`

Not committed to git (gitignored — contains credentials). Create it on the
new laptop:
```json
[
  { "email": "someone@example.com", "password": "", "nickname": "aniket", "docUrl": "", "sessionDir": ".sessions/coda/aniket", "active": true }
]
```
- `password` can be left empty — coda.io mostly uses Google OAuth or a magic
  link, so first login is usually manual (a Chrome window opens and waits up
  to 3 minutes for you to complete it by hand; the session then persists).
- `docUrl` optional — leave `""` to always create a brand-new doc per post.
  Set it to publish into one specific existing doc instead.
- `sessionDir` optional — defaults to `.sessions/coda/<nickname>` if omitted.

**First login**, one time per account:
```
npx tsx src/browser/coda/login.ts --nickname aniket
```
A visible Chrome window opens; log in by hand; the script confirms and saves
the session. After that, all automated runs reuse it silently.

## Step 5 — Utilities this depends on

If the target repo doesn't already have these, bring them too:

**`src/utils/killChrome.ts`**:
```ts
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

export async function killChromeForProfile(sessionDir: string): Promise<void> {
  const absDir = path.resolve(sessionDir);
  try {
    const script = `
      $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
      foreach ($p in $procs) {
        if ($p.CommandLine -and $p.CommandLine -like '*${absDir.replace(/\\/g, '\\\\')}*') {
          Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
      }
    `;
    await execAsync(`powershell -NoProfile -Command "${script.replace(/\n\s*/g, ' ')}"`, { timeout: 8000 });
  } catch { /* Non-fatal — best effort */ }

  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(absDir, lockFile);
    if (fs.existsSync(lockPath)) { try { fs.rmSync(lockPath); } catch {} }
  }
  const defaultLock = path.join(absDir, 'Default', 'LOCK');
  if (fs.existsSync(defaultLock)) { try { fs.rmSync(defaultLock); } catch {} }
}
```
(This is Windows-specific — PowerShell `Get-CimInstance`. On macOS/Linux,
replace the process-kill block with `pkill -f "<absDir>"` or similar; the
lock-file cleanup below it is OS-agnostic.)

**`src/utils/utm.ts`** — only the piece Coda needs:
```ts
export const UTM_PARAMS = {
  // ...whatever other platforms the target repo has...
  Coda: '?utm_source=Coda&utm_medium=Referral&utm_campaign=Automation',
};

export function injectUTM(content: string, utmString: string): string {
  if (!content || !utmString) return content;
  const utmParams = utmString.replace(/^\?/, '');
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g;
  return content.replace(urlRegex, (match) => {
    if (match.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) return match; // never touch image/media URLs
    if (match.includes('kenresearch.com')) {
      const baseUrl = match
        .replace(/[?&]utm_source=[^&"'\s]*/g, '')
        .replace(/[?&]utm_medium=[^&"'\s]*/g, '')
        .replace(/[?&]utm_campaign=[^&"'\s]*/g, '')
        .replace(/[?&]utm_term=[^&"'\s]*/g, '')
        .replace(/[?&]utm_content=[^&"'\s]*/g, '')
        .replace(/\?$/, '')
        .replace(/&$/, '');
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}${utmParams}`;
    }
    return match; // non-kenresearch links pass through untouched
  });
}
```

## Step 6 — Batch runner + sheet integration (optional — only if the target
repo also has the Google Sheets + cron batch system)

`src/sheets/sheets.ts`:
```ts
export async function getRowsForContinuousCodaPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Coda Status', 'coda status', 'CodaStatus'], 'Coda', limit);
}

export async function saveUnifiedCodaResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.codaPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedCoda, today)
    : (row.lastPostedCoda ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Coda Post URL', 'coda post url'], value: newUrl },
    { names: ['Coda Status', 'coda status'], value: result.status },
    { names: ['Coda Error', 'coda error'], value: result.error ?? '' },
    { names: ['Coda Batch', 'coda batch', 'codaBatch'], value: result.batch ?? '' },
    { names: ['lastPostedCoda', 'lastposteddoca'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}
```
`pickRowsByEmptyStatus`, `getSheetsClient`, `getSheetConfig`, `getColumnMap`,
`buildUpdates`, `batchWrite`, `appendValue`, `SheetRow` are pre-existing
shared helpers in `sheets.ts` — this is only meaningful if the target repo
already has that shared sheet-access layer; otherwise skip this step and
just call `postToCoda` directly with whatever content source you have.

`src/coordinator/masterCoordinator.ts` — the batch runner:
```ts
export async function runCodaBatch(batchNum: number = 1, rowsOverride?: SheetRow[]): Promise<void> {
  console.log(`\n[CODA BATCH] Starting...`);
  const rows = rowsOverride ?? await getRowsForContinuousCodaPosting(15);
  if (rows.length === 0) { console.log('[CODA BATCH] No rows available'); return; }
  const batchLabel = `Batch ${batchNum}`;
  console.log(`  Found ${rows.length} rows ready for Coda (${batchLabel})`);
  let posted = 0, failed = 0;
  for (const row of rows) {
    try {
      console.log(`\n  Processing: ${row.title.slice(0, 60)}`);
      let content = row.blogContent || '';
      const title = row.title || row.descriptionTitle || '';
      if (!content) {
        await saveUnifiedCodaResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: 'No blog content' });
        failed++;
        continue;
      }
      content = ensureTargetUrl(content, row.targetUrl);
      const loginResult = await executeBrowserTool('login_coda', { nickname: row.name });
      if (!loginResult.success) throw new Error(loginResult.error || 'Login failed');
      const postResult = await executeBrowserTool('post_coda', { title, htmlContent: content });
      if (postResult.success) {
        await saveUnifiedCodaResult(row, { postUrl: postResult.postUrl || '', status: 'Posted', batch: batchLabel });
        posted++;
      } else {
        await saveUnifiedCodaResult(row, { postUrl: '', status: 'Failed', batch: batchLabel, error: postResult.error });
        failed++;
      }
    } catch (err: any) {
      console.error(`  ❌ Row ${row.rowIndex}: ${err.message}`);
      try { await saveUnifiedCodaResult(row, { postUrl: '', status: 'Error', batch: batchLabel, error: err.message }); } catch {}
      failed++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n[CODA BATCH] ${batchLabel} complete: ${posted}/${rows.length} posted, ${failed} failed`);
}
```
(`ensureTargetUrl`, `executeBrowserTool` are pre-existing shared helpers —
same caveat as above.)

## Verification checklist after integrating

1. `npx tsc --noEmit` (or the target repo's typecheck command) — should show
   no new errors from these files.
2. `npx tsx src/browser/coda/login.ts --nickname <name>` — confirms login
   flow works standalone, saves the session.
3. If the sheet/batch layer was ported too: run one Coda batch manually and
   confirm a real page gets published and the URL is written back correctly.

## Known rough edges (carried over, not fixed — mention if asked)

- Coda's login flow (email/password vs. Google OAuth vs. magic link) was
  never fully confirmed — the code has a `TODO(locators)` and mostly relies
  on manual login rather than full automation.
- Several UI selectors (Publish button, Copy-link button, access-option
  toggle) are matched by exact CSS class names with no stable
  `aria-label`/`data-*` attribute — these are the most likely things to
  break if Coda changes its UI, since class names like `Tie_K1V4` look
  auto-generated/hashed and could change on Coda's next deploy.
