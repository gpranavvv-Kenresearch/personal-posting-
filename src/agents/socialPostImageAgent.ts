/**
 * socialPostImageAgent.ts — generate a simple branded social-card image (for
 * an FB/LinkedIn/X TEXT post, not a blog article) via ChatGPT (DALL-E 3),
 * driving the user's own logged-in ChatGPT session, then save it to local
 * disk only. Separate from blogImageAgent.ts, which produces the heavier
 * research-driven editorial cover image used on the blog article itself.
 *
 * Usage:
 *   const localPath = await generateSocialPostImageLocalOnly({
 *     title: 'India Cold Storage Market',
 *     reportUrl: 'https://www.kenresearch.com/industry-reports/india-cold-storage-market',
 *   });
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { sessionDirForAccount, recordChatGptFailure, recordChatGptSuccess } from '../config/chatGptAccountTracker.js';
import { killChromeForProfile } from '../utils/killChrome.js';
import { pasteIntoChatGptComposer, dismissBlockingModals } from '../utils/chatgptComposer.js';

const COMPOSER_SELECTOR = '#prompt-textarea';
const LOGIN_BUTTON_SELECTOR = 'button:has-text("Log in"), a:has-text("Log in")';
const MANUAL_LOGIN_TIMEOUT_MS = 120_000;

// Dedicated account for this flow, separate from blogGenAgent.ts (default),
// blogImageAgent.ts (account2), and any others already in rotation — so all
// can run concurrently in their own Chrome profiles without fighting over
// one login/session. Log into it once via:
//   npx tsx src/tools/loginChatGpt.ts social-image
const DEFAULT_ACCOUNT = 'social-image';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const DEFAULT_OUTPUT_DIR = path.resolve('generated_images/social-post-cards');
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label*="Send"]',
];

// Premium editorial-consulting stat card (McKinsey/BCG-style executive insight
// card), not a marketing infographic. Since the flow only supplies a report
// title + URL, the "MARKET INPUTS" fields are filled in by ChatGPT's own
// research directive up front rather than being pre-typed placeholders — same
// self-research pattern blogImageAgent.ts uses for its cover image.
function buildSocialPostImagePrompt(title: string, reportUrl: string): string {
  return `Act as a senior editorial designer creating a premium market intelligence visual for Ken Research, a global market research and consulting firm.

Create a square LinkedIn executive insight card (1080x1080 px) inspired by consulting reports from McKinsey, BCG, and investor research publications.

The design must feel like a strategic business insight, not a marketing infographic.

RESEARCH FIRST (do this before designing — do not display the research itself in the image):
Using the report below, independently research and determine every field listed under MARKET INPUTS. Use the Reference Report URL as the primary source; if more detail is needed, use only official government/regulatory bodies or industry associations. Never fabricate a number, and never cite or name any competitor market-research or consulting firm as a source. If no reliable figure can be verified, use a concise qualitative trend statement instead of inventing one.

Report Title: "${title}"
${reportUrl ? `Reference Report URL: "${reportUrl}"` : ''}

MARKET INPUTS (determine each of these yourself from the research above):

Market:
the market/report name

Region:
the market's geographic scope

Industry Theme:
the sector/category this market belongs to

Headline:
one sharp, executive-style main insight headline (not a repeat of the title)

Supporting Statement:
one secondary insight sentence

Primary Statistic:
the single most important verified number (market size, CAGR, or forecast value)

Statistic Context:
a short explanation of what that number means (e.g. "Market size by 2034")

Supporting Metrics:
2-3 small verified supporting data points

Accent Color:
pick per the Color Rule below, matched to the Industry Theme

Visual Metaphor:
an industry-appropriate hero visual concept (see examples below)

---

DESIGN STYLE:

Create a premium editorial consulting layout.

Background:
- Soft ivory / warm white paper background
- Minimal texture
- Clean premium appearance
- Large negative space

Typography:
- Large elegant serif headline
- Dark navy text
- Editorial magazine style
- Sentence case
- Strong hierarchy

Headline placement:
- Left aligned
- Upper left section
- Occupy approximately 35-40% of canvas
- Maximum 4 lines

Supporting text:
- Smaller modern sans-serif
- Positioned below headline
- Clear and minimal

Hero visual:
- Place industry-relevant image on the right side
- Use realistic photography mixed with editorial illustration
- Soft fade into background
- Premium consulting report style

Examples:
Healthcare:
hospital, medical device, diagnostics, wearable technology

Automotive:
factory, robotics, vehicles, manufacturing floor

Logistics:
ports, warehouse, trucks, supply chain routes

Fintech:
banking infrastructure, digital payments, financial networks

DATA DESIGN:

Display the primary statistic as the strongest visual element.

Example:

"$4.4 Billion"

with smaller text:

"Market size by 2034"

Do not create charts unless specifically requested.

Avoid:
- dashboards
- multiple cards
- dense tables
- excessive icons

INSIGHT BOX:

Add a thin bordered bottom section containing the Key Business Takeaway (one sentence, determined from your research above).

Style:
- Minimal
- Executive summary feeling
- Dark navy text
- Small accent highlight

COLOR RULE:

Change accent colors according to industry.

Healthcare:
teal / medical green

Automotive:
red / orange

Logistics:
blue / cyan

Energy:
orange / green

Technology:
purple / electric blue

BRANDING:

Add only:
"KEN RESEARCH"

Small placement:
bottom right corner.

No other logos.
No competitor names.
No watermarks.

QUALITY RULES:

The image should look like a CEO LinkedIn post.

Prioritize:
- clarity within 3 seconds
- premium consulting aesthetic
- strong typography
- whitespace
- one memorable insight

Avoid:
- Canva template feeling
- generic stock graphics
- crowded layouts
- colorful infographic style
- excessive text

Output:
1080x1080 high-resolution professional social media graphic. Return only the completed image — no explanation, no research table, no design rationale.`;
}

async function findGeneratedImage(page: Page, timeout = 3 * 60 * 1000): Promise<{ src: string; naturalWidth: number; naturalHeight: number }> {
  const deadline = Date.now() + timeout;
  const started = Date.now();
  let lastLogAt = 0;
  while (Date.now() < deadline) {
    const found = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const candidates = imgs.filter((img: any) => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
      if (!candidates.length) return null;
      const target = candidates[candidates.length - 1] as any;
      return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
    });

    if (found && found.src) {
      console.log(`   Image found: ${found.naturalWidth}x${found.naturalHeight}`);
      return found;
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed - lastLogAt >= 20) {
      console.log(`   Waiting for image... (${elapsed}s elapsed)`);
      lastLogAt = elapsed;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error('Generated image not found after timeout (no img with naturalWidth/Height >= 800)');
}

async function trySendClick(page: Page): Promise<boolean> {
  for (const sel of SEND_SELECTORS) {
    if (await page.locator(sel).last().isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.locator(sel).last().click();
      return true;
    }
  }
  return false;
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
}

async function minimizeToTaskbar(context: BrowserContext, page: Page): Promise<void> {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await (cdp as any).send('Browser.getWindowForTarget');
    await (cdp as any).send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore if CDP unavailable */ }
}

async function waitUntilLoggedIn(page: Page): Promise<boolean> {
  if (await isLoggedIn(page)) {
    console.log('   ✅ ChatGPT: already logged in (session restored)');
    return true;
  }
  const loginBtn = page.locator(LOGIN_BUTTON_SELECTOR).first();
  if (await loginBtn.isVisible().catch(() => false)) await loginBtn.click().catch(() => {});
  console.log(`   ⚠️  ChatGPT: no active session — restore the minimized Chrome window from the taskbar and log in manually (waiting up to ${MANUAL_LOGIN_TIMEOUT_MS / 1000}s)...`);
  try {
    await page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: MANUAL_LOGIN_TIMEOUT_MS });
    console.log('   ✅ ChatGPT: manual login detected — session saved for future runs');
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a simple branded social-card image via ChatGPT (DALL-E 3) for a
 * text post (FB/LinkedIn/X), and save it to local disk only. Returns the
 * absolute local path — no upload, matching the "write local path to sheet"
 * flow this feeds.
 */
export async function generateSocialPostImageLocalOnly(params: {
  title: string;
  reportUrl?: string;
  accountHandle?: string;
  outputDir?: string;
}): Promise<string> {
  const accountName = params.accountHandle || DEFAULT_ACCOUNT;
  const outputDir = params.outputDir || DEFAULT_OUTPUT_DIR;
  const prompt = buildSocialPostImagePrompt(params.title, params.reportUrl || '');

  fs.mkdirSync(outputDir, { recursive: true });

  const sessionDir = sessionDirForAccount(accountName);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await minimizeToTaskbar(context, page);
    await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    if (!(await waitUntilLoggedIn(page))) {
      throw new Error(`ChatGPT (account "${accountName}"): not logged in and manual login was not completed in time.`);
    }

    console.log(`   [social-image:${accountName}] Sending social-card prompt for: "${params.title}"...`);
    await pasteIntoChatGptComposer(page, prompt);
    await page.waitForTimeout(1000);

    await dismissBlockingModals(page);
    let sendClicked = false;
    try {
      sendClicked = await trySendClick(page);
    } catch {
      await dismissBlockingModals(page);
      await page.waitForTimeout(1000);
      sendClicked = await trySendClick(page);
    }
    if (!sendClicked) await page.keyboard.press('Enter');

    const generatedImage = await findGeneratedImage(page);

    console.log('   Stability wait (15s)...');
    await page.waitForTimeout(15 * 1000);

    const finalImage = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const candidates = imgs.filter((img: any) => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
      if (!candidates.length) return null;
      const target = candidates[candidates.length - 1] as any;
      return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
    });
    const imgSrc = finalImage?.src || generatedImage.src;
    if (!imgSrc) throw new Error('Could not resolve final image src after stability wait');

    console.log('   Downloading generated image...');
    const base64Data: string = await page.evaluate(async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      const blob = await response.blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, imgSrc);

    const imageBuffer = Buffer.from(base64Data, 'base64');
    const publicId = `${params.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 55)}-${Math.floor(Date.now() / 1000)}`;
    const localPath = path.resolve(path.join(outputDir, `${publicId}.png`));
    fs.writeFileSync(localPath, imageBuffer);
    console.log(`   Saved locally: ${localPath}`);

    recordChatGptSuccess();
    return localPath;
  } catch (err: any) {
    const { rotated, account } = recordChatGptFailure();
    if (rotated) err.message = `${err.message} (rotated out — next attempt uses "${account}")`;
    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}
