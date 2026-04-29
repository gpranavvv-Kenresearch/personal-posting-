/**
 * uploader.ts — YouTube Studio Upload (Direct Playwright)
 *
 * Uploads a merged MP4 to YouTube Studio via Playwright.
 * Uses persistent Chrome session per account.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_ROOT = 'C:\\yt-grok\\sessions';

interface YoutubeAccount {
  'Account Name'?: string;
  name?: string;
  username?: string;
  [key: string]: unknown;
}

const INVALID = new Set(['', 'undefined', 'null', 'na', 'n/a', '-']);

function normVal(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return INVALID.has(t.toLowerCase()) ? '' : t;
}

function loadAccounts(): YoutubeAccount[] {
  const p = path.join(__dirname, '../../../.accounts/accounts-youtube.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function findAccount(name: string): YoutubeAccount | null {
  const accounts = loadAccounts();
  const needle = normVal(name).toLowerCase();
  if (!needle) return null;
  return accounts.find(acc =>
    [acc?.['Account Name'], acc?.name, acc?.username]
      .map(a => (typeof a === 'string' ? a.trim().toLowerCase() : ''))
      .filter(Boolean)
      .includes(needle)
  ) ?? null;
}

function sessionDirFor(username: string): string {
  const safe = String(username || 'default').replace(/[^a-z0-9_.-]/gi, '_');
  return path.join(SESSION_ROOT, safe || 'default');
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface UploadParams {
  finalPath: string;
  title: string;
  description: string;
  chromeProfile: string;
}

export interface UploadResult {
  videoId: string | null;
  videoUrl: string | null;
}

export async function uploadToYoutube(params: UploadParams): Promise<UploadResult> {
  const { finalPath, title, description, chromeProfile } = params;

  const account = findAccount(chromeProfile);
  if (!account) throw new Error(`Account "${chromeProfile}" not found in accounts-youtube.json`);

  const username   = String(account.username || account['Account Name'] || chromeProfile);
  const sessionDir = sessionDirFor(username);
  fs.mkdirSync(sessionDir, { recursive: true });

  if (!fs.existsSync(finalPath)) throw new Error(`Video file not found: ${finalPath}`);

  console.log(`   📁 Session: ${sessionDir}`);

  const browser = await chromium.launchPersistentContext(sessionDir, {
    channel:           'chrome',
    headless:          false,
    viewport:          null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--window-size=1366,768',
    ],
  });

  await browser.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page    = await browser.newPage();
  let   videoId: string | null = null;

  try {
    console.log('   Opening YouTube Studio...');
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForTimeout(4000);

    if (!page.url().includes('studio.youtube.com')) {
      throw new Error('Not logged into YouTube Studio. Log in manually using this session first.');
    }

    // Click CREATE
    console.log('   Clicking CREATE...');
    await page.waitForSelector('button[aria-label="Create"]', { timeout: 30_000 });
    await page.click('button[aria-label="Create"]');
    await page.waitForTimeout(1500);

    // Upload videos
    console.log('   Clicking Upload videos...');
    await page.waitForSelector('yt-formatted-string.item-text:has-text("Upload videos")', { timeout: 10_000 });
    await page.click('yt-formatted-string.item-text:has-text("Upload videos")');
    await page.waitForTimeout(2000);

    // Attach file
    console.log(`   Attaching file: ${finalPath}`);
    await page.waitForSelector('button[aria-label="Select files"]', { timeout: 15_000 });
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('button[aria-label="Select files"]'),
    ]);
    await fileChooser.setFiles(finalPath);
    console.log('   File attached.');

    await page.waitForSelector('ytcp-uploads-dialog', { timeout: 30_000 })
      .catch(() => console.log('   Dialog not found, continuing...'));
    await page.waitForTimeout(3000);

    // Title
    console.log('   Setting title...');
    const titleBox = page.locator('#title-textarea #textbox').first();
    await titleBox.click({ timeout: 15_000 });
    await page.keyboard.press('Control+A');
    await page.keyboard.type(title || 'Market Analysis #shorts', { delay: 30 });

    // Description
    console.log('   Setting description...');
    const descBox = page.locator('#description-textarea #textbox').first();
    await descBox.click({ timeout: 10_000 });
    await page.keyboard.press('Control+A');
    await page.keyboard.type(description || '#shorts #market #business #investing', { delay: 20 });

    // Next (wait until enabled)
    console.log('   Clicking Next...');
    await page.waitForSelector('button[aria-label="Next"]:not([disabled])', { timeout: 30_000 });
    await page.click('button[aria-label="Next"]:not([disabled])');
    await page.waitForTimeout(1500);

    // Not for kids
    console.log('   Setting audience...');
    const radios = await page.$$('tp-yt-paper-radio-button div#radioContainer');
    if (radios.length >= 2) await radios[1].click();
    else if (radios.length === 1) await radios[0].click();
    await page.waitForTimeout(1000);

    // Next x3
    console.log('   Clicking Next x3...');
    for (let i = 0; i < 3; i++) {
      await page.waitForSelector('button[aria-label="Next"]:not([disabled])', { timeout: 15_000 });
      await page.click('button[aria-label="Next"]:not([disabled])');
      console.log(`   Next ${i + 1}/3`);
      await page.waitForTimeout(1500);
    }

    // Public
    console.log('   Setting Public...');
    await page.waitForSelector('tp-yt-paper-radio-button[name="PUBLIC"]', { timeout: 15_000 });
    await page.click('tp-yt-paper-radio-button[name="PUBLIC"]');
    await page.waitForTimeout(1000);

    // Wait for upload to finish
    console.log('   Waiting for upload to complete...');
    await page.waitForFunction(() => {
      const p = document.querySelector('ytcp-video-upload-progress');
      if (!p) return true;
      const t = p.textContent || '';
      return t.includes('Upload complete') || t.includes('100%') || t.includes('Processing will begin');
    }, { timeout: 300_000 }).catch(() => console.log('   Upload progress timeout, proceeding...'));
    await page.waitForTimeout(2000);

    // Publish
    console.log('   Clicking Publish...');
    await page.waitForSelector('button[aria-label="Publish"]:not([disabled])', { timeout: 30_000 });
    await page.click('button[aria-label="Publish"]:not([disabled])');
    await page.waitForTimeout(5000);

    // Extract video ID
    videoId = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      for (const a of links) {
        const m = (a.href || '').match(/youtube\.com\/shorts\/([\w-]+)|youtube\.com\/watch\?v=([\w-]+)/);
        if (m) return m[1] || m[2];
      }
      const u = window.location.href.match(/video\/([\w-]+)/);
      return u ? u[1] : null;
    });

    console.log(`   ✅ Published! Video ID: ${videoId}`);

  } finally {
    await page.goto('about:blank').catch(() => {});
    await browser.close().catch(() => {});
  }

  return {
    videoId,
    videoUrl: videoId ? `https://youtube.com/watch?v=${videoId}` : null,
  };
}
