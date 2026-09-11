import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const NAVER_BLOGHOME_URL = 'https://section.blog.naver.com/BlogHome.naver?directoryNo=0&currentPage=1&groupId=0';
const WRITE_SEL = 'a[href="https://blog.naver.com/GoBlogWrite.naver"]';
// Smart Editor One generates a random id per element/session, so title/body
// fields must be matched on their stable class names, never on #SE-<uuid>.
// Clicking the outer .se-documentTitle wrapper does NOT reliably focus the
// actual contenteditable node inside it — must target the inner paragraph
// directly, or the click silently no-ops and typed text falls through to
// whatever was previously focused (the content body).
const TITLE_SELS = [
  '.se-documentTitle .se-text-paragraph',
  '.se-section-documentTitle .se-text-paragraph',
  '.se-module-text.se-title-text',
  '.se-section-documentTitle',
  '.se-component.se-documentTitle',
];
const BODY_SELS = [
  '.se-placeholder',
  '.se-text-paragraph',
];
// Naver's Smart Editor One CSS-module classnames (publish_btn__m9KHH,
// confirm_btn__WEaBq) are build-hashed and can change on redeploy, so the
// stable attribute (data-click-area / data-testid) is tried first and the
// hashed class kept only as a fallback.
const PUBLISH_SELS = [
  '[data-click-area="tpb.publish"]',
  'button.publish_btn__m9KHH',
];
const CONFIRM_SELS = [
  '[data-testid="seOnePublishBtn"]',
  'button.confirm_btn__WEaBq',
];

export async function postToNaver(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Naver);

  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  // Step 1: Navigate to Naver blog home
  console.log('   Navigating to Naver blog home...');
  try {
    await page.goto(NAVER_BLOGHOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch { /* timeout ok */ }
  await sleep(3000);

  // Step 2: Click "글쓰기" (write) — this opens the Smart Editor in a new tab
  console.log('   Clicking write button (opens new tab)...');
  const context = page.context();
  let editorPage: Page;
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 15000 }),
      page.locator(WRITE_SEL).first().click({ timeout: 5000 }),
    ]);
    editorPage = newPage;
    await editorPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    console.log('   ✅ Editor opened in new tab');
  } catch (err: any) {
    throw new Error(`Naver: could not open write editor: ${err.message}`);
  }
  await sleep(10000);

  // The whole Smart Editor UI (title, body, publish, confirm) lives inside
  // an <iframe id="mainFrame" src="/PostWriteForm.naver">, not the top-level
  // editorPage document — every locator below must go through this frame.
  const frame = editorPage.frameLocator('#mainFrame');

  // Step 3: Click the title field and type the title
  console.log('   Clicking title field...');
  let titleClicked = false;
  for (const sel of TITLE_SELS) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      titleClicked = true;
      console.log(`   ✅ Title field clicked (${sel})`);
      break;
    }
  }
  if (!titleClicked) {
    console.warn('   ⚠️ Title field not found — typing may land in wrong place');
  }
  await sleep(500);
  await editorPage.keyboard.type(String(title).trim(), { delay: 20 });
  console.log('   ✅ Title typed');
  await sleep(1000);

  // Verify by reading the title container's actual text — a CSS
  // "still-showing-placeholder" check is unreliable because that class only
  // appears once something is genuinely focused; if the click above never
  // focused anything at all, the placeholder class doesn't show up "still
  // there" OR "focused" — it just silently never received the click.
  const titleTextSel = '.se-documentTitle, .se-section-documentTitle';
  let titleText = await frame.locator(titleTextSel).first().innerText({ timeout: 2000 }).catch(() => '');
  if (!titleText.trim()) {
    console.warn('   ⚠️ Title still empty after typing — retrying with a forceful click on the inner text node');
    for (const sel of TITLE_SELS) {
      const el = frame.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click({ timeout: 4000, force: true }).catch(() => {});
        break;
      }
    }
    await sleep(500);
    await editorPage.keyboard.type(String(title).trim(), { delay: 20 });
    await sleep(1000);
    titleText = await frame.locator(titleTextSel).first().innerText({ timeout: 2000 }).catch(() => '');
    if (!titleText.trim()) {
      console.warn('   ⚠️ Title still empty after retry — content may end up landing in the title field, or vice versa');
    } else {
      console.log(`   ✅ Title confirmed after retry: "${titleText.trim().slice(0, 60)}"`);
    }
  } else {
    console.log(`   ✅ Title confirmed: "${titleText.trim().slice(0, 60)}"`);
  }

  // Step 4: Click into the content body
  console.log('   Clicking content body...');
  let bodyClicked = false;
  for (const sel of BODY_SELS) {
    const el = frame.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      bodyClicked = true;
      console.log(`   ✅ Content body clicked (${sel})`);
      break;
    }
  }
  if (!bodyClicked) {
    // Enter from the title field drops focus into the first body paragraph
    // on Smart Editor One — used only if none of the body selectors hit.
    await editorPage.keyboard.press('Enter').catch(() => {});
    console.warn('   ⚠️ Content body selector not found — pressed Enter from title to move focus');
  }
  await sleep(500);

  // Step 5: Render HTML in a temp page, copy it, and paste into the editor body
  console.log('   Rendering HTML in temp page and copying...');
  try {
    const tempPage = await context.newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(500);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
      console.log('   ✅ HTML rendered and copied');
    } finally {
      await tempPage.close();
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not render/copy HTML: ${err.message}`);
  }
  await sleep(1000);
  await editorPage.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');
  await sleep(2000);

  // Step 6: Click the publish (발행) button
  console.log('   Clicking publish button...');
  let publishClicked = false;
  for (const sel of PUBLISH_SELS) {
    try {
      const el = frame.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 8000 });
      await el.click({ timeout: 4000 });
      console.log(`   ✅ Publish button clicked (${sel})`);
      publishClicked = true;
      break;
    } catch { /* try next selector */ }
  }
  if (!publishClicked) {
    throw new Error('Naver: publish button not found (tried all known selectors)');
  }
  await sleep(1500);

  // Step 7: Click the confirm-publish button in the resulting dialog
  console.log('   Clicking confirm publish button...');
  let confirmClicked = false;
  for (const sel of CONFIRM_SELS) {
    try {
      const el = frame.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout: 8000 });
      await el.click({ timeout: 4000 });
      console.log(`   ✅ Confirm publish clicked (${sel})`);
      confirmClicked = true;
      break;
    } catch { /* try next selector */ }
  }
  if (!confirmClicked) {
    throw new Error('Naver: confirm publish button not found (tried all known selectors)');
  }

  // Step 8: Wait for the redirect to the published post, then read the URL
  // straight from the address bar.
  await sleep(5000);
  const postUrl = editorPage.url();
  console.log(`   ✅ Naver post URL: ${postUrl}`);
  await editorPage.close().catch(() => {});

  return { success: true, postUrl, postedAt: new Date() };
}
