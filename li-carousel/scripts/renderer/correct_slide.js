// In-place slide corrector.
//
// After a slide renders, Claude reads it multimodally and identifies specific
// errors (wrong number, lifted phrase, fabricated source, misspelled brand,
// missing chart annotation, palette drift, etc.). This script dispatches the
// correction to GPT-4o image editing: uploads the slide + a surgical correction
// prompt, downloads the corrected output.
//
// This is the GPT-edit path for fixing things in-place. For small text/number
// patches, use a manual composite (paint a clean rectangle + render the right
// text on top) — that's more deterministic but limited to text patches.
//
// Usage:
//   node scripts/renderer/correct_slide.js \
//     --input=images/enhanced_2026-05-22_qcomm-s3.png \
//     --correction="Change the value '+Rs 37 Cr' in the Blinkit endpoint pill to '+Rs 37 Cr Q4 FY26'. Leave every other element unchanged: same composition, same palette, same typography, same other data points." \
//     --slug=qcomm-s3
//
// Or supply the correction prompt from a file (for longer briefs):
//   --correction-file=path/to/prompt.txt
//
// Output: images/corrected_[YYYY-MM-DD]_[slug].png

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pasteIntoChatGPTComposer } from '../chatgpt_composer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_DIR = path.join(ROOT, '.auth', 'chatgpt-profile');
const IMAGES_DIR = path.join(ROOT, 'images');
const CHATGPT_URL = 'https://chatgpt.com';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const inputPath = args.input;
let correction = args.correction;
if (args['correction-file']) {
  correction = fs.readFileSync(args['correction-file'], 'utf8').trim();
}
const slug = args.slug ?? 'untitled';

if (!inputPath || !fs.existsSync(inputPath)) {
  console.error(`Missing or non-existent --input: ${inputPath}`);
  process.exit(1);
}
if (!correction) {
  console.error('Missing --correction or --correction-file');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const outPath = path.join(IMAGES_DIR, `corrected_${today}_${slug}.png`);
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Wrap the user's correction in a strict preservation envelope so GPT only
// changes the named element. Past experience: unprompted GPT image-edits drift
// — palette shifts, typography changes, other text gets rewritten. The
// envelope keeps the surface area of the change small.
const CORRECTION_PROMPT = `You are doing a SURGICAL correction on an existing image. The image you receive is mostly correct — only a specific element needs fixing.

THE FIX REQUESTED:
${correction}

═══ NON-NEGOTIABLE PRESERVATION RULES ═══

1. Output the SAME image with only the named element changed
2. Preserve EXACTLY: composition, layout, palette, typography, font weights, all other text content, all other numbers, every chart line, every data point, every brand element, the Ken Research safe zone, the source line, the pagination chevron
3. Do NOT "improve" anything else while you're at it
4. Do NOT change the register / mood / style
5. Do NOT add atmospheric elements (glows, gradients, particles) that were not in the original
6. Do NOT redraw anything from scratch

If you cannot make the requested change WITHOUT changing other elements, render the image exactly as received and add a small red caption at the bottom saying: "CANNOT APPLY CORRECTION — manual fix needed".

═══ OUTPUT ═══

- Same dimensions as input (preserve aspect ratio exactly)
- PNG, LinkedIn-ready quality`;

console.log(`Input:      ${inputPath}`);
console.log(`Output:     ${outPath}`);
console.log(`Correction: ${correction.slice(0, 100)}${correction.length > 100 ? '...' : ''}`);
console.log('Launching Chrome ...');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const page = context.pages()[0] ?? await context.newPage();

try {
  console.log('Opening ChatGPT...');
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const isLoggedIn = async () => {
    try {
      const loginBtn = page.locator('button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up"), a:has-text("Sign up for free")').first();
      if (await loginBtn.isVisible({ timeout: 1500 }).catch(() => false)) return false;
      const profileSelectors = [
        '[data-testid="profile-button"]',
        '[data-testid="accounts-profile-button"]',
        'button[aria-label*="user menu" i]',
        'button[aria-label*="open profile" i]',
        'button[aria-label*="account" i]',
        'img[alt*="user" i]',
      ];
      for (const sel of profileSelectors) {
        if (await page.locator(sel).first().isVisible({ timeout: 1000 }).catch(() => false)) return true;
      }
      const cookies = await context.cookies();
      const sessionCookie = cookies.find(c => c.name.includes('__Secure-next-auth.session-token') || c.name === 'session');
      if (sessionCookie) return true;
    } catch {}
    return false;
  };

  if (!(await isLoggedIn())) {
    throw new Error('NOT logged in. Run `npm run auth` first, log into ChatGPT, then re-run.');
  }
  console.log('Logged in.');

  // Fresh chat
  await page.goto(`${CHATGPT_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Attach the slide
  console.log('Attaching slide...');
  let attached = false;
  try {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(inputPath);
      attached = true;
      console.log('Slide attached.');
    }
  } catch (e) {
    console.log(`Direct input failed: ${e.message}`);
  }
  if (!attached) {
    const attachSelectors = [
      '[data-testid="composer-plus-btn"]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="upload" i]',
      'button[aria-label*="add" i]',
      'button[aria-label*="file" i]',
      '[data-testid="composer-attach-button"]',
    ];
    for (const sel of attachSelectors) {
      const btn = page.locator(sel).first();
      if (!(await btn.isVisible({ timeout: 2000 }).catch(() => false))) continue;
      const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
      await btn.click().catch(() => {});
      const uploadMenuItem = page.locator('text=/upload|photos.*files|attach/i').first();
      if (await uploadMenuItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        await uploadMenuItem.click().catch(() => {});
      }
      const fileChooser = await fileChooserPromise;
      if (fileChooser) {
        await fileChooser.setFiles(inputPath);
        attached = true;
        break;
      }
      const fi = page.locator('input[type="file"]').first();
      if (await fi.count() > 0) {
        await fi.setInputFiles(inputPath);
        attached = true;
        break;
      }
    }
  }
  if (!attached) throw new Error('Could not attach image. ChatGPT UI may have changed.');
  await page.waitForTimeout(3000);

  // Paste the correction prompt
  console.log('Pasting correction prompt...');
  await pasteIntoChatGPTComposer(page, CORRECTION_PROMPT);
  await page.waitForTimeout(1000);

  // Snapshot existing images so we detect only the NEW one
  const preSendImageSrcs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img'))
      .filter(img => img.naturalWidth > 50)
      .map(img => img.src);
  });

  // Send
  console.log('Sending...');
  const sendSelectors = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'button:has(svg)[data-disabled="false"]',
    'form button[type="submit"]',
  ];
  let sendClicked = false;
  for (const sel of sendSelectors) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click();
      sendClicked = true;
      break;
    }
  }
  if (!sendClicked) await page.keyboard.press('Enter');

  // Wait for the corrected image (up to 3 min)
  console.log('Waiting for corrected image (up to 3 min)...');
  const generatedImage = await waitForNewAssistantImage(page, new Set(preSendImageSrcs), 3 * 60 * 1000);

  await generatedImage.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);

  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const large = imgs.filter(i => i.naturalWidth > 100 && i.naturalHeight > 100);
    const last = large[large.length - 1];
    return last && last.complete && last.naturalWidth >= 800;
  }, { timeout: 120000 });

  console.log('Stability wait (20s)...');
  await page.waitForTimeout(20 * 1000);

  // Download
  const imgSrc = await generatedImage.getAttribute('src');
  if (!imgSrc) throw new Error('Could not get image src');
  const base64Data = await page.evaluate(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }, imgSrc);
  fs.writeFileSync(outPath, Buffer.from(base64Data, 'base64'));

  const stats = fs.statSync(outPath);
  console.log(`Saved: ${outPath} (${(stats.size / 1024).toFixed(1)} KB)`);
  console.log(JSON.stringify({ status: 'success', savedPath: outPath, slug }));

} catch (err) {
  console.error(`Error: ${err.message}`);
  try {
    const debugPath = path.join(IMAGES_DIR, `error_correct_${slug}_${Date.now()}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    console.log(`Debug screenshot: ${debugPath}`);
  } catch {}
  console.log(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
} finally {
  await context.close();
}

// ---------- helpers ----------

async function waitForNewAssistantImage(page, prevSet, timeout) {
  const strongSelectors = [
    'img[src*="oaidalleapiprodscus"]',
    'img[src*="dalle"]',
    'img[src*="files.oaiusercontent.com"]',
    'div[data-testid="generated-image"] img',
    '[data-message-author-role="assistant"] img',
  ];
  const deadline = Date.now() + timeout;
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    for (const sel of strongSelectors) {
      const imgs = page.locator(sel);
      const count = await imgs.count();
      for (let i = count - 1; i >= 0; i--) {
        const loc = imgs.nth(i);
        const src = await loc.getAttribute('src').catch(() => null);
        if (!src || prevSet.has(src)) continue;
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width > 200 && box.height > 200) {
          console.log(`New corrected image via "${sel}" (${Math.round(box.width)}x${Math.round(box.height)})`);
          return loc;
        }
      }
    }
    const allImgs = page.locator('main img');
    const count = await allImgs.count();
    for (let i = count - 1; i >= 0; i--) {
      const loc = allImgs.nth(i);
      const src = await loc.getAttribute('src').catch(() => null);
      if (!src || prevSet.has(src)) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width > 300 && box.height > 300) {
        return loc;
      }
    }
    const elapsed = Math.round((Date.now() - (deadline - timeout)) / 1000);
    if (elapsed - lastLogAt >= 15) {
      console.log(`Still waiting... (${elapsed}s elapsed)`);
      lastLogAt = elapsed;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('No corrected image appeared in 3 min.');
}
