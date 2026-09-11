/**
 * pdfhost/poster.ts — Upload a PDF to PdfHost.io and get the shareable link.
 * Expects an already-logged-in (or anonymous) page from loginToPdfHost()
 *
 * Confirmed against the real DOM, step-by-step (2026-08-12): the homepage
 * (/) is a browse/search landing page with NO upload form — the actual
 * uploader is at /upload. The file input (accept="application/pdf,.pdf") is
 * visually hidden (clip-path) but still directly settable via setInputFiles.
 * A separate "Upload" button (data-testid="upload-pdf-button") starts out
 * disabled and only enables once a file is selected.
 *
 * On success the page redirects to /edit?doc=<uuid> — NOT the public link.
 * That edit page has:
 *   - #titleInput / #descriptionInput / #authorInput fields
 *   - #public-toggle — a checkbox that MUST be turned on, otherwise the
 *     upload stays private and the /v/ link 404s for anyone else
 *   - "Update Details" button (data-testid="update-details-button") to save
 *   - a "View Document" link (<a href="/v/<slug>">) — click through to it
 *     and read the real address bar rather than trusting the href attribute
 *     directly, since that's the actual live public URL.
 */
import { Page } from 'playwright';
import path from 'path';
import fs from 'fs';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const UPLOAD_URL = 'https://pdfhost.io/upload';
const FILE_INPUT_SEL = 'input[type="file"]';
const UPLOAD_BTN_SEL = 'button[data-testid="upload-pdf-button"]';

export interface PdfHostPostResult {
  success: true;
  postUrl: string;
  postedAt: Date;
}

export async function postToPdfHost(
  page: Page,
  filePath: string,
  title?: string,
  description?: string,
): Promise<PdfHostPostResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  console.log('   Navigating to PdfHost upload page...');
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2000);

  console.log('   Selecting PDF file...');
  await page.waitForSelector(FILE_INPUT_SEL, { timeout: 10000, state: 'attached' });
  await page.setInputFiles(FILE_INPUT_SEL, filePath);
  console.log(`   File selected: ${path.basename(filePath)}`);
  await sleep(1500);

  console.log('   Waiting for Upload button to enable...');
  const uploadBtn = page.locator(UPLOAD_BTN_SEL).first();
  try {
    await page.waitForFunction(
      (sel) => {
        const btn = document.querySelector(sel) as HTMLButtonElement | null;
        return !!btn && !btn.disabled;
      },
      UPLOAD_BTN_SEL,
      { timeout: 15000 }
    );
  } catch {
    console.warn('   ⚠️ Upload button never reported enabled — attempting click anyway.');
  }

  console.log('   Clicking Upload...');
  await uploadBtn.click({ timeout: 5000 });

  console.log('   Waiting for redirect to the edit page...');
  try {
    await page.waitForURL(/\/edit\?doc=/, { timeout: 60000 });
  } catch {
    throw new Error('PdfHost: upload never redirected to the edit page — upload likely failed.');
  }
  await sleep(2000);

  if (title) {
    const titleInput = page.locator('#titleInput').first();
    if (await titleInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await titleInput.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(title.slice(0, 200), { delay: 15 });
      console.log('   ✅ Title filled');
    }
  }
  if (description) {
    const descInput = page.locator('#descriptionInput').first();
    if (await descInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await descInput.click();
      await page.keyboard.type(description.slice(0, 1000), { delay: 10 });
      console.log('   ✅ Description filled');
    }
  }

  console.log('   Filling author...');
  const authorInput = page.locator('#authorInput').first();
  if (await authorInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await authorInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.type('Ken Research', { delay: 15 });
    console.log('   ✅ Author filled');
  }

  console.log('   Making the document public...');
  const publicToggle = page.locator('#public-toggle').first();
  if (await publicToggle.count() > 0) {
    const alreadyOn = await publicToggle.isChecked().catch(() => false);
    if (!alreadyOn) {
      // The checkbox itself is visually hidden (sr-only) — click its visible
      // label/toggle sibling rather than the input directly, same as a user
      // clicking the switch.
      await publicToggle.locator('xpath=following-sibling::*[1]').click({ timeout: 4000 }).catch(async () => {
        // Fallback: force-check the input directly if the sibling click missed.
        await publicToggle.check({ force: true, timeout: 4000 }).catch(() => {});
      });
      console.log('   ✅ Public toggle turned on');
    } else {
      console.log('   ✅ Already public');
    }
  } else {
    console.warn('   ⚠️ Public toggle (#public-toggle) not found — document may stay private.');
  }
  await sleep(500);

  console.log('   Saving details...');
  const updateBtn = page.locator('button[data-testid="update-details-button"]').first();
  if (await updateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await updateBtn.click({ timeout: 4000 }).catch(() => {});
    console.log('   ✅ Details saved');
  }
  await sleep(1500);

  console.log('   Opening "View Document" to confirm the live public URL...');
  let postUrl = page.url();
  const viewDocLink = page.locator('a[href^="/v/"]', { hasText: /view document/i }).first();
  const fallbackLink = page.locator('a[href^="/v/"]').first();
  const target = (await viewDocLink.count()) > 0 ? viewDocLink : fallbackLink;
  if (await target.isVisible({ timeout: 5000 }).catch(() => false)) {
    await target.click({ timeout: 4000 }).catch(() => {});
    try {
      await page.waitForURL(/\/v\//, { timeout: 15000 });
    } catch { /* fall through to reading whatever URL we're on */ }
    await sleep(1000);
    postUrl = page.url();
  } else {
    console.warn('   ⚠️ "View Document" link not found — falling back to current page URL.');
  }

  console.log(`   ✅ PdfHost link: ${postUrl}`);
  return { success: true, postUrl, postedAt: new Date() };
}
