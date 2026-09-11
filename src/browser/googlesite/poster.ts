import { Page } from 'playwright';
import * as cheerio from 'cheerio';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 800;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function gotoWithRetry(page: Page, url: string, expectedDomain: string, retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { /* timeout — check URL anyway */ }
    const landed = page.url();
    if (landed !== 'about:blank' && landed !== '' && landed.includes(expectedDomain)) return;
    console.log(`   ⚠️ Navigation to ${url} landed on "${landed}" (attempt ${attempt}/${retries}) — retrying...`);
    await sleep(3000);
  }
  const final = page.url();
  if (final === 'about:blank' || final === '' || !final.includes(expectedDomain)) {
    throw new Error(`Failed to navigate to ${url} after ${retries} attempts. Landed on: ${final}`);
  }
}

/**
 * Post to Google Sites (expects logged-in page)
 * Content Format: HTML with UTM parameters injected
 */
export async function postToGoogleSite(
  page: Page,
  title: string,
  htmlContent: string,
  seedKeyword?: string,
  accountUtm?: string,
): Promise<{ success: true; slug: string; postUrl: string; postedAt: Date }> {
  // Minimize browser at start — stays minimized throughout
  try {
    const cdpMain = await page.context().newCDPSession(page);
    const { windowId } = await cdpMain.send('Browser.getWindowForTarget');
    await cdpMain.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdpMain.detach().catch(() => {});
  } catch { /* ignore */ }

  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.GoogleSite);

  console.log('   Navigating to Google Sites...');
  await gotoWithRetry(page, 'https://sites.google.com/', 'sites.google.com');

  // Inject UTM parameters into HTML links if provided
  let contentWithUtm = htmlContent;
  if (accountUtm) {
    const $ = cheerio.load(htmlContent);
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.includes('utm_')) return;
      $(el).attr('href', href + (href.includes('?') ? '&' : '?') + accountUtm);
    });
    contentWithUtm = $.html();
  }

  // Generate slug from seed keyword or title
  const slugSource = seedKeyword || title;
  const rawSlug = slugSource
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]/g, '');
  const MAX_SLUG_LEN = 30;
  const baseSlug = rawSlug.slice(0, MAX_SLUG_LEN);

  // Numeric suffix variants only — avoids duplicates when base is already 30 chars
  function buildSlugVariants(base: string): string[] {
    const variants: string[] = [base];
    for (let i = 1; i <= 30; i++) {
      const suffix = `-${i}`;
      const candidate = base.slice(0, MAX_SLUG_LEN - suffix.length) + suffix;
      if (!variants.includes(candidate)) variants.push(candidate);
    }
    return variants;
  }

  // Short fallback: first letter of each word (for length errors)
  function shortSlug(): string {
    const abbr = rawSlug.split('-').map(w => w[0] || '').join('');
    return abbr.slice(0, MAX_SLUG_LEN);
  }

  console.log('   Clicking create blank site button...');
  try {
    await page.locator('img[src*="sites-blank-googlecolors.png"]').click();
    await page.waitForTimeout(9000);
  } catch {
    throw new Error('Create blank site button not found');
  }

  // Fill title — type character by character (no paste)
  console.log('   Filling title...');
  try {
    const titleSpan = page.locator('span.C9DxTc:has-text("Your page title")');
    await titleSpan.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(title, { delay: 50 });
  } catch {
    throw new Error('Title field not found or not writable');
  }

  // Fill site slug via paste
  console.log('   Filling site slug...');
  try {
    const slugInput = page.locator('input[aria-label="Site name"]');
    await slugInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText(baseSlug);
  } catch {
    throw new Error('Slug field not found or not writable');
  }

  // Render HTML in temp page → copy to clipboard → paste into Sites editor
  console.log('   Rendering HTML and copying to clipboard...');
  try {
    const tempPage = await page.context().newPage();
    await tempPage.setContent(contentWithUtm, { waitUntil: 'networkidle', timeout: 20000 }).catch(() =>
      tempPage.setContent(contentWithUtm, { waitUntil: 'domcontentloaded', timeout: 10000 })
    );
    await tempPage.waitForTimeout(2000);
    await tempPage.keyboard.press('Control+A');
    await tempPage.waitForTimeout(300);
    await tempPage.keyboard.press('Control+C');
    await tempPage.waitForTimeout(500);
    await tempPage.close();
    console.log('   ✅ HTML rendered and copied');
  } catch (err: any) {
    console.warn(`   ⚠️ Could not render/copy HTML: ${err.message}`);
  }

  console.log('   Adding HTML content...');
  try {
    await page.locator('div[jscontroller="eKvtYd"]', { hasText: 'Text box' }).first().click();
    await page.waitForTimeout(2500);
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(SMALL_DELAY);
  } catch {
    throw new Error('Could not add content to page');
  }

  // Publish with slug collision handling
  console.log('   Publishing site...');
  let finalSlug = baseSlug;

  try {
    await page.locator('div[jsname="kCRcob"]').click();
    await page.waitForTimeout(4000);

    const webAddr = page.locator('input.poFWNe.zHQkBf');

    let variants = buildSlugVariants(baseSlug);
    let usedShort = false;
    let slugFound = false;

    for (let i = 0; i < variants.length; i++) {
      const s = variants[i];

      // fill() reliably clears + sets value without keyboard events
      await webAddr.fill('');
      await page.waitForTimeout(300);
      await webAddr.fill(s);

      // Wait 4s for Google Sites server-side slug validation to complete
      await page.waitForTimeout(4000);

      // Detect errors via aria-invalid on input + body text scan
      const slugState = await page.evaluate((inputSel: string) => {
        const input = document.querySelector(inputSel) as HTMLInputElement | null;
        const bodyText = document.body.innerText || '';
        return {
          invalid: input?.getAttribute('aria-invalid') === 'true',
          takenInText: bodyText.includes('already taken'),
          tooLongInText: bodyText.includes('use up to 30'),
        };
      }, 'input.poFWNe.zHQkBf').catch(() => ({ invalid: false, takenInText: false, tooLongInText: false }));

      const takenErr  = slugState.invalid || slugState.takenInText;
      const lengthErr = slugState.tooLongInText;

      if (lengthErr && !usedShort) {
        console.log(`   ⚠️ Slug too long — switching to abbreviation`);
        variants = buildSlugVariants(shortSlug());
        usedShort = true;
        i = -1;
        continue;
      }

      if (takenErr) {
        console.log(`   ⚠️ Slug taken: ${s} – trying next...`);
        continue;
      }

      finalSlug = await webAddr.inputValue();
      console.log(`   ✅ Slug available: ${finalSlug}`);

      // dispatchEvent bypasses Playwright's aria-disabled check while still
      // firing through the browser's real event system
      await page.locator('div[jsname="kCRcob"]').dispatchEvent('click').catch(() => {});
      const publishBtn = page.getByRole('button', { name: 'Publish', exact: true });
      await publishBtn.dispatchEvent('click');
      await page.waitForTimeout(5000);
      slugFound = true;
      break;
    }

    if (!slugFound) {
      throw new Error(`All slug variants exhausted for "${baseSlug}"`);
    }
  } catch (err: any) {
    throw new Error(`Publish process failed: ${err.message}`);
  }

  const postUrl = `https://sites.google.com/view/${finalSlug}`;
  console.log(`   ✅ Post published. URL: ${postUrl}`);

  return {
    success: true,
    slug: finalSlug,
    postUrl,
    postedAt: new Date(),
  };
}
