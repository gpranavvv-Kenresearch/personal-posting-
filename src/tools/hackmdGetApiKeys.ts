/**
 * hackmdGetApiKeys.ts
 *
 * Opens each HackMD session, navigates to the Access Tokens settings page,
 * reads or generates an API token, and saves it back to accounts-hackmd.json.
 *
 * Run: npx ts-node --esm src/tools/hackmdGetApiKeys.ts
 * Or add to package.json: "hackmd-keys": "node --loader ts-node/esm src/tools/hackmdGetApiKeys.ts"
 */

import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

const ACCOUNTS_FILE = path.resolve('.accounts/accounts-hackmd.json');
const SESSION_ROOT   = path.resolve('.sessions/hackmd');
const DEBUG_DIR      = path.resolve('debug/hackmd-api-keys');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface HackMDAccount {
  email: string;
  password: string;
  nickname?: string;
  username?: string;
  sessionDir?: string;
  active: boolean;
  apiKey?: string;
}

function loadAccounts(): HackMDAccount[] {
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

function saveAccounts(accounts: HackMDAccount[]): void {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

function sessionDirFor(account: HackMDAccount): string {
  if (account.sessionDir) return path.resolve(account.sessionDir);
  const safe = (account.username || account.email).replace(/[^a-z0-9_-]/gi, '_');
  return path.join(SESSION_ROOT, safe);
}

async function saveDebugSnapshot(page: Page, nickname: string, step: string): Promise<void> {
  const dir = path.join(DEBUG_DIR, nickname);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${step}.png`), fullPage: true }).catch(() => {});
}

async function launchSession(sessionDir: string): Promise<{ context: BrowserContext; page: Page }> {
  const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: true,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    channel: fs.existsSync(chromePath) ? undefined : 'chrome',
    viewport: { width: 1280, height: 900 },
    slowMo: 80,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    (window as any).chrome = (window as any).chrome || { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
  });

  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  for (const extra of pages.slice(1)) await extra.close().catch(() => {});

  context.on('page', async p => { if (p !== page) await p.close().catch(() => {}); });

  return { context, page };
}

async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes('/login') || url.includes('accounts.')) return false;

  const indicators = [
    'a[href="/logout"]',
    'img.avatar',
    'div.navbar-user-dropdown',
    '[data-testid="user-menu"]',
    'a[href*="/settings"]',
  ];
  for (const sel of indicators) {
    if (await page.$(sel).catch(() => null)) return true;
  }
  return !url.includes('/login');
}

async function ensureLoggedIn(page: Page, account: HackMDAccount): Promise<boolean> {
  await page.goto('https://hackmd.io/?nav=overview', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);

  if (await isLoggedIn(page)) return true;

  console.log(`      Session expired â€” trying credential login for ${account.nickname}...`);
  await page.goto('https://hackmd.io/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(1500);

  const emailInput = page.locator('input[name="email"], input[type="email"]').first();
  const passInput  = page.locator('input[name="password"], input[type="password"]').first();

  if (!await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) return false;

  await emailInput.fill(account.email);
  await passInput.fill(account.password);
  await page.keyboard.press('Enter');
  await sleep(3000);

  return isLoggedIn(page);
}

/**
 * Navigate to settings and extract the API token.
 * HackMD settings page path: /settings (the "Access tokens" tab is one of the sections).
 */
async function getOrCreateApiToken(page: Page, nickname: string): Promise<string | null> {
  // Step 1 â€” go to settings
  await page.goto('https://hackmd.io/settings', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);
  await saveDebugSnapshot(page, nickname, '01-settings-loaded');

  // Step 2 â€” click the "Access tokens" tab if it exists
  const tokenTabSelectors = [
    'a:has-text("Access tokens")',
    'a:has-text("API")',
    'li:has-text("Access tokens")',
    '[data-tab="access-tokens"]',
    '[href="#access-tokens"]',
    '[href*="access-token"]',
  ];
  for (const sel of tokenTabSelectors) {
    const tab = page.locator(sel).first();
    if (await tab.isVisible({ timeout: 1500 }).catch(() => false)) {
      await tab.click();
      await sleep(1500);
      break;
    }
  }
  await saveDebugSnapshot(page, nickname, '02-after-tab-click');

  // Step 3 â€” look for an existing token in a read-only input / code block
  const tokenInputSelectors = [
    'input[id*="token" i]',
    'input[name*="token" i]',
    'input[aria-label*="token" i]',
    'input[placeholder*="token" i]',
    'code.token',
    '.access-token-value',
    '[data-testid="token-value"]',
    'input[readonly]',
    'input[type="text"][value]',
  ];

  for (const sel of tokenInputSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        const val = (await el.inputValue().catch(() => '')) || (await el.innerText().catch(() => ''));
        if (val && val.length > 10) {
          console.log(`      âœ… Found existing token via "${sel}"`);
          return val.trim();
        }
      }
    } catch { /* continue */ }
  }

  // Step 4 â€” look for "Show" or "Reveal" button to unhide the token
  const revealSelectors = [
    'button:has-text("Show")',
    'button:has-text("Reveal")',
    'button[aria-label*="show" i]',
    'button[aria-label*="reveal" i]',
    '[data-testid="show-token"]',
  ];
  for (const sel of revealSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      await sleep(1000);
      // Re-check inputs after reveal
      for (const inSel of tokenInputSelectors) {
        const el = page.locator(inSel).first();
        if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
          const val = (await el.inputValue().catch(() => '')) || (await el.innerText().catch(() => ''));
          if (val && val.length > 10) return val.trim();
        }
      }
      break;
    }
  }

  // Step 5 â€” try to generate a new token
  const createSelectors = [
    'button:has-text("Create access token")',
    'button:has-text("Generate token")',
    'button:has-text("Generate")',
    'button:has-text("New token")',
    'button:has-text("Add token")',
    'button:has-text("Create token")',
    'a:has-text("Create access token")',
    '[data-testid="create-token"]',
  ];

  let created = false;
  for (const sel of createSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log(`      Clicking create token button: "${sel}"`);
      await btn.click();
      await sleep(2000);
      created = true;
      await saveDebugSnapshot(page, nickname, '03-after-create-click');
      break;
    }
  }

  if (created) {
    // A modal or inline form may appear asking for a token name
    const nameInputSelectors = [
      'input[placeholder*="name" i]',
      'input[placeholder*="description" i]',
      'input[aria-label*="name" i]',
      'input[name="name"]',
    ];
    for (const sel of nameInputSelectors) {
      const inp = page.locator(sel).first();
      if (await inp.isVisible({ timeout: 1500 }).catch(() => false)) {
        await inp.fill(`ken-research-${nickname}`);
        await sleep(500);
        // Submit the form
        const submitBtn = page.locator('button[type="submit"], button:has-text("Create"), button:has-text("Generate"), button:has-text("OK")').first();
        if (await submitBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await submitBtn.click();
          await sleep(2000);
        } else {
          await page.keyboard.press('Enter');
          await sleep(2000);
        }
        await saveDebugSnapshot(page, nickname, '04-after-token-name-submit');
        break;
      }
    }

    // Now look for the newly generated token (often shown once in a modal)
    const newTokenSelectors = [
      'input[readonly]',
      'input[type="text"]',
      'code',
      '.token-value',
      '[data-testid="new-token-value"]',
      'textarea',
    ];
    for (const sel of newTokenSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const val = (await el.inputValue().catch(() => '')) || (await el.innerText().catch(() => ''));
        if (val && val.length > 10) {
          console.log(`      âœ… Got newly generated token`);
          return val.trim();
        }
      }
    }
  }

  // Step 6 â€” last resort: scan all visible text inputs for something that looks like a token
  await saveDebugSnapshot(page, nickname, '05-final-scan');
  const allInputs = await page.locator('input[type="text"], input:not([type])').all();
  for (const inp of allInputs) {
    const val = await inp.inputValue().catch(() => '');
    // HackMD tokens are long alphanumeric strings
    if (val && /^[a-zA-Z0-9_\-]{20,}$/.test(val.trim())) {
      return val.trim();
    }
  }

  // Also check code/pre elements
  const codeEls = await page.locator('code, pre').all();
  for (const el of codeEls) {
    const text = (await el.innerText().catch(() => '')).trim();
    if (text && /^[a-zA-Z0-9_\-]{20,}$/.test(text)) return text;
  }

  console.warn(`      âš ï¸  Could not find or create token â€” check debug screenshots in debug/hackmd-api-keys/${nickname}/`);
  return null;
}

async function processAccount(account: HackMDAccount): Promise<string | null> {
  const sessionDir = sessionDirFor(account);
  const label = account.nickname || account.email;

  if (!fs.existsSync(sessionDir)) {
    console.log(`   [${label}] âš ï¸  Session folder missing: ${sessionDir} â€” skipping`);
    return null;
  }

  console.log(`\n   [${label}] Opening session: ${sessionDir}`);
  let context: BrowserContext | null = null;

  try {
    const launched = await launchSession(sessionDir);
    context = launched.context;
    const page  = launched.page;

    const loggedIn = await ensureLoggedIn(page, account);
    if (!loggedIn) {
      console.log(`   [${label}] âŒ Could not log in â€” skipping`);
      return null;
    }

    const token = await getOrCreateApiToken(page, label);
    if (token) {
      console.log(`   [${label}] âœ… API token: ${token.slice(0, 8)}...`);
    }
    return token;
  } catch (err: any) {
    console.error(`   [${label}] âŒ Error: ${err.message}`);
    return null;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function main() {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const accounts = loadAccounts();
  console.log(`\nHackMD API key extractor â€” ${accounts.length} accounts\n`);

  let updated = 0;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const label = account.nickname || account.email;
    console.log(`\n[${i + 1}/${accounts.length}] ${label}`);

    if (account.apiKey) {
      console.log(`   Already has API key (${account.apiKey.slice(0, 8)}...) â€” skipping`);
      continue;
    }

    const token = await processAccount(account);
    if (token) {
      accounts[i] = { ...account, apiKey: token };
      saveAccounts(accounts);
      console.log(`   ðŸ’¾ Saved to accounts-hackmd.json`);
      updated++;
    }

    // Small pause between accounts to avoid fingerprint correlation
    if (i < accounts.length - 1) await sleep(2000);
  }

  console.log(`\nâœ… Done â€” updated ${updated} / ${accounts.length} accounts`);
  console.log(`   Debug screenshots: ${DEBUG_DIR}`);

  const final = loadAccounts();
  const missing = final.filter(a => !a.apiKey);
  if (missing.length) {
    console.log(`\nâš ï¸  Still missing API keys for:`);
    missing.forEach(a => console.log(`   - ${a.nickname || a.email}`));
    console.log(`   Check debug screenshots and run again, or add keys manually.`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

