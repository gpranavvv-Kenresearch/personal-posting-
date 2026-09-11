/**
 * stagehand.ts — Browser utility functions
 */
import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';

export async function humanDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fills a field via clipboard paste (Ctrl+A to select any existing content,
 * Ctrl+V to paste) instead of simulated keystroke typing. Used for URL
 * fields specifically — typing a URL character-by-character into a search/
 * bookmark-add box can trigger the platform's own live autocomplete/search
 * suggestions mid-type, which sometimes intercepts focus or mangles the
 * value. The caller must click/focus the target field first.
 * Requires the browser context to have been launched with
 * permissions: ['clipboard-read', 'clipboard-write'].
 */
export async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+V');
}

/**
 * Same clipboard-paste approach as pasteText(), but pastes as plain text
 * (Ctrl+Shift+V) instead of a normal paste (Ctrl+V). Rich-text composer
 * boxes (Facebook's/LinkedIn's post editor) can otherwise carry over
 * formatting or handle multi-line clipboard content inconsistently — plain
 * paste forces the browser to hand the editor a bare text/plain payload,
 * which these editors reliably split into separate paragraph blocks on
 * each newline. Requires the browser context to have been launched with
 * permissions: ['clipboard-read', 'clipboard-write']. The caller must
 * click/focus the target field first.
 */
export async function pasteTextPlain(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+Shift+V');
}

/**
 * Waits for the page to actually finish loading (document.readyState ===
 * 'complete', i.e. all sub-resources/scripts done, not just the initial
 * HTML parse that 'domcontentloaded' fires on) before the caller proceeds
 * to interact with it. A fixed sleep() after page.goto() is a guess at how
 * long loading takes — on a slow connection or a heavy SPA it can still be
 * mid-render when the sleep ends, so the very next click/type either misses
 * its target or hits a stale one. This waits for a real signal instead.
 * Swallows its own timeout — callers should still guard each subsequent
 * action with waitFor/isVisible; this only removes the "raced past a slow
 * load" failure mode, not the "element never renders at all" one.
 */
export async function waitForPageReady(page: Page, timeoutMs: number = 20000): Promise<void> {
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs }).catch(() => {});
}

/**
 * Waits for an element to be genuinely visible AND clicks it, throwing a
 * clear error naming the selector if it never appears — instead of a blind
 * click (which can hit a not-yet-rendered/disabled element on a slow page)
 * or a swallowed isVisible().catch(() => false) that silently skips a step
 * the caller actually needed to happen.
 */
export async function waitAndClick(
  page: Page,
  selector: string,
  opts?: { timeoutMs?: number; label?: string }
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const label = opts?.label ?? selector;
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  } catch {
    throw new Error(`waitAndClick: "${label}" never became visible within ${timeoutMs}ms — page may still have been loading.`);
  }
  await locator.click({ timeout: 5000 });
}

/**
 * Finds the actual reCAPTCHA checkbox-anchor frame among ALL frames
 * currently attached to the page (not just the first iframe matching a CSS
 * selector). reCAPTCHA typically loads TWO iframes: a small "protected by
 * reCAPTCHA" badge (always present, harmless, no checkbox inside) and the
 * real anchor frame containing #recaptcha-anchor. Which one is first in DOM
 * order isn't guaranteed, so `frameLocator(...).first()` can silently pick
 * the wrong one and miss a real checkbox entirely. Iterating page.frames()
 * and checking each candidate individually is the only reliable way to find
 * the right one. Returns the Frame if found, else null.
 */
/**
 * Checks whether the <iframe> ELEMENT that owns this frame (in the PARENT
 * page's DOM) is actually visible on screen right now. This is the part
 * that matters — Google does not remove/destroy a reCAPTCHA iframe once
 * it's been solved or dismissed, it just hides the <iframe> tag itself (or
 * collapses it to zero size) while leaving the frame and its document fully
 * attached. Checking visibility of something INSIDE the frame's own
 * document (e.g. its <body>) does NOT reflect that outer hidden state —
 * the frame's internal document can still report its own content as
 * "visible" by its own internal styles even while the iframe wrapping it is
 * display:none in the parent page. That mismatch is exactly what caused a
 * stale, already-solved challenge frame to keep being reported as present.
 */
async function isFrameElementVisible(frame: import('playwright').Frame): Promise<boolean> {
  try {
    const handle = await frame.frameElement();
    return await handle.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

async function findRecaptchaAnchorFrame(page: Page): Promise<import('playwright').Frame | null> {
  const candidates = page.frames().filter(f => /recaptcha/i.test(f.url()));
  for (const frame of candidates) {
    try {
      if (!(await isFrameElementVisible(frame))) continue;
      const el = await frame.$('#recaptcha-anchor, .recaptcha-checkbox-border');
      if (el && (await el.isVisible().catch(() => false))) return frame;
    } catch {
      // frame may have detached/navigated mid-check — try the next one
    }
  }
  return null;
}

/**
 * Same "check every frame" approach for the escalated image-challenge frame
 * (Google's "bframe"), which only appears after the checkbox click decides
 * the session looks suspicious enough to need it.
 */
async function findRecaptchaImageChallengeFrame(page: Page): Promise<import('playwright').Frame | null> {
  const candidates = page.frames().filter(f => /recaptcha/i.test(f.url()) && /bframe/i.test(f.url()));
  for (const frame of candidates) {
    try {
      if (!(await isFrameElementVisible(frame))) continue;
      // The challenge frame's own body renders visible content once loaded;
      // a frame that exists but never painted anything isn't a real prompt.
      const hasContent = await frame.locator('body').first().isVisible({ timeout: 1000 }).catch(() => false);
      if (hasContent) return frame;
    } catch {
      // ignore and try the next candidate
    }
  }
  return null;
}

/**
 * Checks the current page for a visible CAPTCHA/bot-challenge (reCAPTCHA,
 * hCaptcha, Cloudflare Turnstile, or generic "verify you are human" text).
 * Returns which kind was found (or null if none), so callers can log/pause/
 * fail with an actual reason instead of just timing out with no trace of
 * what actually happened on screen.
 */
export async function detectCaptcha(page: Page): Promise<string | null> {
  try {
    if (await findRecaptchaAnchorFrame(page)) return 'recaptcha';
    if (await findRecaptchaImageChallengeFrame(page)) return 'recaptcha-image-challenge';

    const hcaptchaHit = await page.locator('iframe[src*="hcaptcha" i], iframe[title*="hcaptcha" i]')
      .first().isVisible({ timeout: 2000 }).catch(() => false);
    if (hcaptchaHit) return 'hcaptcha';

    const cloudflareHit = await page.locator('iframe[src*="challenges.cloudflare.com" i]')
      .first().isVisible({ timeout: 2000 }).catch(() => false);
    if (cloudflareHit) return 'cloudflare-turnstile';

    const textHit = await page.getByText(/verify you are human|i'?m not a robot|complete the captcha|security check/i)
      .first().isVisible({ timeout: 2000 }).catch(() => false);
    if (textHit) return 'text-challenge';

    return null;
  } catch {
    return null;
  }
}

/**
 * Clicks the reCAPTCHA checkbox found via findRecaptchaAnchorFrame — the
 * frame-iteration-safe counterpart to detectCaptcha() finding it. Returns
 * true if a checkbox was found and clicked, false if none was present.
 */
export async function clickRecaptchaCheckboxIfPresent(page: Page): Promise<boolean> {
  const frame = await findRecaptchaAnchorFrame(page);
  if (!frame) return false;
  const el = await frame.$('#recaptcha-anchor, .recaptcha-checkbox-border');
  if (!el) return false;
  await el.click({ timeout: 5000 }).catch(() => {});
  return true;
}

/**
 * Waits for a lightbox/modal overlay (Scribd wraps its recaptcha checkbox —
 * and possibly other popups — in div#lightboxes / div#lightbox_area, which
 * intercepts pointer events on whatever's behind it even after the captcha
 * itself is resolved) to actually disappear before the caller tries to
 * click something that might still be covered by it.
 */
export async function waitForLightboxGone(page: Page, timeoutMs: number = 10000): Promise<void> {
  await page.locator('#lightboxes, #lightbox_area').first()
    .waitFor({ state: 'hidden', timeout: timeoutMs })
    .catch(() => {});
}

/**
 * Captures a screenshot + full HTML dump to debug/captcha-<platform>/ when a
 * captcha (or any other hard-to-reproduce failure) is hit, so it can be
 * inspected after the fact instead of only being visible live in a headed
 * browser window that closes on failure.
 */
export async function saveDebugSnapshot(page: Page, platform: string, label: string): Promise<string> {
  const outDir = path.resolve('debug', `captcha-${platform}`);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(outDir, `${label}-${stamp}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  fs.writeFileSync(`${base}.html`, await page.content().catch(() => ''), 'utf8');
  return outDir;
}
