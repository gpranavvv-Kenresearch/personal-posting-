/**
 * pulseTestPaste.ts
 * One-off: login → fill title → render HTML → paste into LinkedIn Pulse editor → STOP (keep browser open)
 * Usage: node --import=tsx src/tools/pulseTestPaste.ts
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';

// ── Config ───────────────────────────────────────────────────────────────────

const ARTICLE_TITLE =
  'Germany\'s EUR 66 Billion Telecom Market: 5G and Fiber Infrastructure Driving EUR 72-75B Forecast by 2030';

const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Use shrey account
const SESSION_DIR = path.resolve('.sessions/chrome-linkedin-shrey');
const EMAIL       = 'g.pranavvv@gmail.com';
const PASSWORD    = 'g.pranavvv@6096';

// ── HTML content (Market at A Glance table only) ─
const RAW_HTML = `<table style="width:100%;border-collapse:collapse;margin:20px 0;">
  <thead>
    <tr style="background:#f0f4f8;border-bottom:2px solid #2563eb;">
      <th style="padding:12px;text-align:left;font-weight:700;color:#1e40af;">Metric</th>
      <th style="padding:12px;text-align:right;font-weight:700;color:#1e40af;">Value</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Market Size 2026</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">EUR 66B</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Forecast 2030</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">EUR 72-75B</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Growth Rate CAGR</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">2-3%</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">5G Coverage</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">75-80%</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Fiber Access</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">50-55%</td>
    </tr>
    <tr>
      <td style="padding:10px 12px;">Enterprise IoT Growth</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">8-12%</td>
    </tr>
  </tbody>
</table>`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 800, max = 2200) =>
  sleep(Math.floor(Math.random() * (max - min + 1)) + min);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  console.log(`Using Chrome: ${chromePath}`);
  console.log(`Session dir:  ${SESSION_DIR}`);

  const browserContext = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  const page = await browserContext.newPage();

  // ── Login check ────────────────────────────────────────────────────────────
  console.log('Checking login...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await sleep(3000);

  const alreadyLoggedIn = await page.locator('a[href*="/mynetwork/"]').first().isVisible().catch(() => false);
  if (!alreadyLoggedIn) {
    console.log('Not logged in — attempting auto-login...');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    await sleep(2000);

    const userField = page.locator('input#username, input[name="session_key"]');
    if (await userField.isVisible().catch(() => false)) {
      await userField.fill(EMAIL);
      await randomDelay(500, 900);
    }

    const passField = page.locator('input#password, input[name="session_password"]');
    if (await passField.isVisible().catch(() => false)) {
      await passField.fill(PASSWORD);
      await randomDelay(400, 700);
      await page.keyboard.press('Enter');
    }

    await sleep(5000);

    const loggedIn = await page.locator('a[href*="/mynetwork/"]').first().isVisible().catch(() => false);
    if (!loggedIn) {
      console.log('Auto-login failed — please log in manually in the browser. Waiting 60s...');
      await sleep(60000);
    } else {
      console.log('Login successful.');
    }
  } else {
    console.log('Already logged in.');
  }

  // ── Navigate to article composer ───────────────────────────────────────────
  console.log('Navigating to LinkedIn article composer...');
  await page.goto('https://www.linkedin.com/article/new/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(4000);

  // ── Fill title ─────────────────────────────────────────────────────────────
  console.log('Filling article title...');
  await page.waitForSelector('#article-editor-headline__textarea', { timeout: 20000 }).catch(() => {});
  const titleField = page.locator('#article-editor-headline__textarea').first();
  if (await titleField.isVisible().catch(() => false)) {
    await titleField.click({ delay: 150 });
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await randomDelay(200, 400);
    await page.keyboard.insertText(ARTICLE_TITLE);
    await randomDelay(600, 1000);
    console.log('Title filled.');
  } else {
    console.warn('Title field not found — skipping.');
  }

  // ── Render HTML in temp page and copy ─────────────────────────────────────
  console.log('Rendering HTML in temp page and copying to clipboard...');
  const tempPage = await browserContext.newPage();
  try {
    await tempPage.setContent(RAW_HTML, { waitUntil: 'networkidle', timeout: 20000 }).catch(() =>
      tempPage.setContent(RAW_HTML, { waitUntil: 'domcontentloaded', timeout: 10000 })
    );
    await tempPage.waitForTimeout(5000);
    await tempPage.keyboard.press('Control+A');
    await tempPage.waitForTimeout(300);
    await tempPage.keyboard.press('Control+C');
    await tempPage.waitForTimeout(500);
    console.log('HTML rendered and copied.');
  } finally {
    await tempPage.close();
  }

  // ── Click into body and paste ──────────────────────────────────────────────
  console.log('Clicking body field and pasting...');
  const bodyField = page.locator('p.article-editor-paragraph[aria-label*="Write here"]').first();
  if (await bodyField.isVisible().catch(() => false)) {
    await bodyField.click({ delay: 200 }).catch(() => {});
    await randomDelay(400, 700);
    await page.keyboard.press('Control+V');
    await sleep(6000);
    console.log('✅ Content pasted. Browser left open — proceed manually from here.');
  } else {
    console.warn('Body field not found — paste it manually (Ctrl+V) in the article body.');
    console.log('Browser left open for manual action.');
  }

  // ── STOP — do NOT close browser ───────────────────────────────────────────
  console.log('Script complete. Browser remains open. Close it manually when done.');
  await new Promise(() => {}); // Never resolves — Ctrl+C to exit
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
