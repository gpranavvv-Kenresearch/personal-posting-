/**
 * scribd/poster.ts — Upload a PDF to Scribd and get the shareable document link.
 * Expects an already-logged-in page from loginToScribd()
 *
 * Confirmed live (2026-08-18), full flow given directly by the user watching
 * a real upload:
 *   1. /upload-document has TWO hidden input[type="file"] elements — a bare
 *      'input[type="file"]' selector matches both, which trips Playwright's
 *      strict-mode check on setInputFiles(). Target .first() explicitly.
 *   2. After the file is selected, wait ~5s for Scribd to finish its own
 *      upload+processing, which reveals an inline metadata form. The
 *      title/description field IDs embed the new document's numeric ID
 *      (e.g. input#word_document[1075399405][title]), which we don't know
 *      in advance — match by the stable `name` attribute suffix instead
 *      (name$="[title]" / name$="[description]"), not by id.
 *   3. Title: input[name$="[title]"] (placeholder "Enter a title...").
 *   4. Description: textarea[name$="[description]"] (class
 *      "description_input") — this is where the UTM-tagged report URL goes,
 *      same convention as Yumpu/Speaker Deck's "Full report: <url>" line.
 *   5. Submit: button[data-e2e="upload-box-submit-button"] — a real test-id,
 *      the most stable selector on the page.
 *   6. After submit, the final public URL appears in a readonly text input
 *      (input.url_input[aria-label="Document URL"]) — read its `value`
 *      directly rather than clicking any "copy" control and trusting the OS
 *      clipboard (same lesson learned from Issuu's poster.ts).
 *   7. A reCAPTCHA v2 checkbox (not an image challenge) can appear after the
 *      upload or after submit — handleCaptchaIfPresent() clicks it directly
 *      first; only falls back to a human (visible runs) or a hard failure
 *      (headless runs) if that alone doesn't clear it.
 */
import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { createInterface } from 'readline/promises';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';
import { waitForPageReady, pasteText, detectCaptcha, saveDebugSnapshot, clickRecaptchaCheckboxIfPresent, waitForLightboxGone } from '../stagehand.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const UPLOAD_URL = 'https://www.scribd.com/upload-document';
const FILE_INPUT_SEL = 'input[type="file"]';

async function waitForEnter(promptText: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(promptText);
  rl.close();
}

/**
 * After clicking the checkbox (or if there was nothing to click), poll for
 * the actual next-step field (title or description input) to become
 * visible — that's the real signal the captcha cleared and the form behind
 * it is usable, not just "the checkbox looks checked".
 */
async function waitForFormAfterCaptcha(page: Page, timeoutMs: number): Promise<boolean> {
  const target = page.locator('input[name$="[title]"], textarea[name$="[description]"]').first();
  return target.isVisible({ timeout: timeoutMs }).catch(() => false);
}

/**
 * Checks for a captcha at a given step, saves a debug snapshot if found, and:
 *   - for the plain reCAPTCHA checkbox case, clicks it directly and checks
 *     whether the title/description form becomes visible — if so, done, no
 *     human needed;
 *   - otherwise (image challenge, or the checkbox click didn't clear it), in
 *     a visible (HEADLESS=false) browser this pauses for the human to solve
 *     it and confirm via Enter, then re-checks;
 *   - in headless mode (the normal cron/batch path) there is no human to
 *     solve it, so this throws a clearly-labelled, classifiable error
 *     instead of letting the caller hang on some unrelated timeout with no
 *     trace of what actually happened.
 */
async function handleCaptchaIfPresent(page: Page, stepLabel: string): Promise<void> {
  const kind = await detectCaptcha(page);
  if (!kind) return;

  const debugDir = await saveDebugSnapshot(page, 'scribd', `${stepLabel}-detected`);
  console.warn(`   🛑 CAPTCHA detected (${kind}) at step "${stepLabel}". Debug snapshot saved to ${debugDir}`);

  if (kind === 'recaptcha') {
    console.log('   Trying the "I\'m not a robot" checkbox directly...');
    const clicked = await clickRecaptchaCheckboxIfPresent(page);
    if (!clicked) {
      console.warn('   ⚠️ detectCaptcha found a recaptcha anchor frame but clickRecaptchaCheckboxIfPresent didn\'t (page state changed between the two checks?) — falling through.');
    }
    await waitForLightboxGone(page, 8000);
    if (await waitForFormAfterCaptcha(page, 8000)) {
      console.log('   ✅ Checkbox click cleared it — form is visible, continuing.');
      return;
    }
    console.warn('   ⚠️ Checkbox click alone didn\'t clear it (likely escalated to an image challenge).');
  }

  if (process.env.HEADLESS === 'false') {
    await waitForEnter(`   👉 Solve the CAPTCHA in the browser window, then press Enter here to continue... `);
    await waitForLightboxGone(page, 8000);
    if (await waitForFormAfterCaptcha(page, 5000)) return;
    const stillThere = await detectCaptcha(page);
    if (stillThere) {
      throw new Error(`CAPTCHA_UNRESOLVED:scribd — still present at step "${stepLabel}" after manual attempt.`);
    }
    return;
  }

  throw new Error(`CAPTCHA_DETECTED:scribd — a ${kind} challenge appeared at step "${stepLabel}" with no human available to solve it (running headless). Debug snapshot: ${debugDir}`);
}

export interface ScribdPostResult {
  success: true;
  postUrl: string;
  postedAt: Date;
}

export async function postToScribd(
  page: Page,
  filePath: string,
  title: string,
  targetUrl: string,
): Promise<ScribdPostResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const urlWithUtm = injectUTM(targetUrl, UTM_PARAMS.Scribd);
  const description = `Full report: ${urlWithUtm}`;

  console.log('   Navigating to Scribd upload page...');
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForPageReady(page);
  await sleep(1000);

  console.log('   Selecting PDF file...');
  const fileInput = page.locator(FILE_INPUT_SEL).first();
  await fileInput.waitFor({ state: 'attached', timeout: 10000 });
  await fileInput.setInputFiles(filePath);
  console.log(`   File selected: ${path.basename(filePath)}`);

  console.log('   Waiting 5s for the upload to register and the metadata form to appear...');
  await sleep(5000);
  await handleCaptchaIfPresent(page, 'after-upload');

  console.log('   Filling title...');
  const titleInput = page.locator('input[name$="[title]"]').first();
  if (await titleInput.isVisible({ timeout: 15000 }).catch(() => false)) {
    await titleInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(title.slice(0, 150), { delay: 15 });
    console.log('   ✅ Title filled');
  } else {
    console.warn('   ⚠️ Title input (name$="[title]") never appeared — skipping.');
  }
  await sleep(500);

  console.log('   Filling description...');
  const descriptionInput = page.locator('textarea[name$="[description]"]').first();
  if (await descriptionInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await descriptionInput.click();
    await pasteText(page, description.slice(0, 500));
    console.log('   ✅ Description filled');
  } else {
    console.warn('   ⚠️ Description textarea (name$="[description]") never appeared — skipping.');
  }
  await sleep(500);

  console.log('   Submitting...');
  await waitForLightboxGone(page, 5000);
  const submitBtn = page.locator('button[data-e2e="upload-box-submit-button"]').first();
  if (!(await submitBtn.isVisible({ timeout: 10000 }).catch(() => false))) {
    throw new Error('Scribd: submit button (data-e2e="upload-box-submit-button") not found.');
  }
  try {
    await submitBtn.click({ timeout: 8000 });
  } catch (err: any) {
    // A lightbox/overlay intercepting the click is itself a captcha symptom
    // in disguise — handle it the same way and retry once, instead of
    // failing outright on what's really the same underlying problem.
    console.warn(`   ⚠️ Submit click blocked (${err.message.split('\n')[0]}) — checking for a captcha and retrying once...`);
    await handleCaptchaIfPresent(page, 'submit-click-blocked');
    await waitForLightboxGone(page, 5000);
    await submitBtn.click({ timeout: 8000 });
  }
  await waitForPageReady(page);
  await sleep(2000);
  await handleCaptchaIfPresent(page, 'after-submit');

  console.log('   Reading the published document link...');
  let postUrl = page.url();
  const urlField = page.locator('input.url_input[aria-label="Document URL"]').first();
  if (await urlField.isVisible({ timeout: 15000 }).catch(() => false)) {
    const value = await urlField.inputValue().catch(() => '');
    if (value.trim().startsWith('http')) {
      postUrl = value.trim();
    } else {
      console.warn('   ⚠️ Document URL field found but empty — falling back to current page URL.');
    }
  } else {
    console.warn('   ⚠️ Document URL field never appeared — falling back to current page URL.');
  }

  console.log(`   ✅ Scribd document: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
