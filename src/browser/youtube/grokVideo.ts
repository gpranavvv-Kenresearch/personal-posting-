/**
 * grokVideo.ts — Grok Video Generator (Direct Playwright)
 *
 * Generates 4 video clips via Grok Imagine, downloads them to C:\temp\
 * Writes list.txt for FFmpeg concat.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GROK_VIDEO_URL = 'https://grok.com/imagine';
const DOWNLOAD_DIR   = 'C:\\temp';
const SESSION_ROOT   = 'C:\\yt-grok\\sessions';

const wait       = (ms: number) => new Promise(r => setTimeout(r, ms));
const humanDelay = (min = 400, max = 1200) => wait(Math.floor(Math.random() * (max - min + 1)) + min);

// ── Account lookup ────────────────────────────────────────────────────────────

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

// ── Browser context ───────────────────────────────────────────────────────────

async function createContext(sessionDir: string) {
  const ctx = await chromium.launchPersistentContext(sessionDir, {
    channel:           'chrome',
    headless:          false,
    viewport:          null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
      '--window-size=1366,768',
    ],
    acceptDownloads: true,
    downloadsPath:   DOWNLOAD_DIR,
  });

  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  return ctx;
}

// ── Session check ─────────────────────────────────────────────────────────────

async function ensureLoggedIn(page: import('playwright').Page, username: string): Promise<boolean> {
  console.log('   Opening Grok imagine...');
  await page.goto(GROK_VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await wait(3000);

  if (page.url().toLowerCase().includes('grok.com/imagine')) {
    console.log(`   ✅ Session active for: ${username}`);
    return true;
  }

  console.log('   ⚠️  Not logged in. Please log in manually in the browser window.');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await wait(3000);
    if (page.url().toLowerCase().includes('grok.com/imagine')) {
      console.log(`   ✅ Login detected! Session saved for: ${username}`);
      return true;
    }
    console.log(`   Waiting for login... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
  }
  console.log('   [ERR] Login timeout.');
  return false;
}

// ── Type prompt ───────────────────────────────────────────────────────────────

async function typePrompt(page: import('playwright').Page, prompt: string): Promise<void> {
  await page.waitForSelector('[contenteditable="true"], textarea', { timeout: 20_000 });

  const el =
    await page.$('textarea') ??
    await page.$('[contenteditable="true"]') ??
    await page.$('div[role="textbox"]');

  if (!el) throw new Error('Prompt input not found');

  await el.scrollIntoViewIfNeeded();
  await el.click({ force: true });
  await humanDelay(400, 800);

  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await humanDelay(300, 500);

  try {
    await page.evaluate(async (t: string) => navigator.clipboard.writeText(t), prompt);
    await page.keyboard.press('Control+V');
  } catch {
    await page.keyboard.insertText(prompt);
  }

  console.log('   📋 Prompt pasted');
  await humanDelay(800, 1200);
  await page.keyboard.press('Enter');
  console.log('   ↵  Submitted');
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface GrokVideoParams {
  title: string;
  chromeProfile: string;
  timestamp: string;
  prompt1: string;
  prompt2: string;
  prompt3: string;
  prompt4: string;
}

export interface GrokVideoResult {
  clip0: string | null;
  clip1: string | null;
  clip2: string | null;
  clip3: string | null;
  listPath: string;
}

export async function generateGrokVideos(params: GrokVideoParams): Promise<GrokVideoResult> {
  const { title, chromeProfile, timestamp, prompt1, prompt2, prompt3, prompt4 } = params;

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  fs.mkdirSync(SESSION_ROOT, { recursive: true });

  const account = findAccount(chromeProfile);
  if (!account) throw new Error(`Account "${chromeProfile}" not found in accounts-youtube.json`);

  const username   = String(account.username || account['Account Name'] || chromeProfile);
  const sessionDir = sessionDirFor(username);
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`   📁 Session: ${sessionDir}`);

  const ctx  = await createContext(sessionDir);
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);

  try {
    if (!await ensureLoggedIn(page, username)) {
      throw new Error(`Login timeout for "${chromeProfile}"`);
    }

    if (!page.url().includes('grok.com/imagine')) {
      await page.goto(GROK_VIDEO_URL, { waitUntil: 'domcontentloaded' });
      await wait(3000);
    }

    const prompts = [prompt1, prompt2, prompt3, prompt4];

    for (let i = 0; i < prompts.length; i++) {
      console.log(`\n   ========== PROMPT ${i + 1} / 4 ==========`);
      await typePrompt(page, prompts[i]);
      const waitMs = i === prompts.length - 1 ? 30_000 : 20_000;
      console.log(`   ⏳ Waiting ${waitMs / 1000}s...`);
      await wait(waitMs);
    }

    // Download each video
    const safeTitle  = (title || 'video').replace(/[\\/:*?"<>|]/g, '_').trim();
    const thumbnails = await page.$$('button.snap-center.relative.flex-shrink-0');
    console.log(`   🎬 Found ${thumbnails.length} thumbnail(s)`);

    const clips: string[] = [];

    for (let i = 0; i < Math.min(thumbnails.length, 4); i++) {
      const clipPath = path.join(DOWNLOAD_DIR, `${safeTitle}_${timestamp}_${i + 1}.mp4`);

      await thumbnails[i].click();
      console.log(`   🖱️  Clicked thumbnail ${i + 1}`);
      await wait(1500);

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        page.click('button[aria-label="Download"]'),
      ]);
      await download.saveAs(clipPath);
      console.log(`   ✅ Saved: ${clipPath}`);
      clips.push(clipPath);
      await wait(2000);
    }

    // Write list.txt for FFmpeg
    const listPath    = path.join(DOWNLOAD_DIR, 'list.txt');
    const listContent = clips.map(c => `file '${c.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listPath, listContent, 'utf8');
    console.log('   ✅ list.txt written');

    await page.goto('about:blank').catch(() => {});
    await ctx.close().catch(() => {});

    return {
      clip0: clips[0] ?? null,
      clip1: clips[1] ?? null,
      clip2: clips[2] ?? null,
      clip3: clips[3] ?? null,
      listPath,
    };

  } catch (err) {
    await page.goto('about:blank').catch(() => {});
    await ctx.close().catch(() => {});
    throw err;
  }
}
