import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function postToCoda(
  page: Page,
  title: string,
  htmlContent: string,
  docUrl?: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Coda);

  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  // Step 1: Navigate to the account's target doc (falls back to docs home)
  const target = docUrl || 'https://coda.io/docs';
  console.log(`   Navigating to Coda doc: ${target}...`);
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch { /* timeout ok */ }
  await sleep(4000);

  // Step 2: Click "New page" (+ button in the doc's page tree) if we're
  // already inside a doc (docUrl was provided), or "New doc" if we're on the
  // docs home page. We deliberately do NOT fall back to opening an existing
  // doc from the recent-docs list — that previously caused posts to land
  // inside an already-published doc instead of a fresh one (see incident:
  // title/content got typed into a doc that had already been posted).
  console.log('   Clicking New page / New doc button...');
  let newPageClicked = false;
  const newPageSelectors = [
    '[aria-label="New page"]',
    '[aria-label*="Add page" i]',
  ];
  const newDocSelectors = [
    // Exact "New doc" button on the docs home page, identified from live
    // inspection — no stable aria-label/data-id on this element, so match
    // on its full class list plus role.
    'span.Tie_K1V4.QuZsUaXW.dBDkKmiC.eVb7DBLp.LMycHfdJ[role="button"]',
    '[aria-label="New doc"]',
    '[aria-label*="New doc" i]',
    '[aria-label*="Create doc" i]',
    'button:has-text("New doc")',
    'button:has-text("New Doc")',
    '[data-coda-ui-id="create-doc-button"]',
  ];
  const isHomePage = !docUrl;
  const selectorsToTry = isHomePage ? newDocSelectors : newPageSelectors;
  for (const sel of selectorsToTry) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      newPageClicked = true;
      console.log(`   ✅ ${isHomePage ? 'New doc' : 'New page'} clicked (${sel})`);
      break;
    }
  }
  if (!newPageClicked) {
    console.warn(`   ⚠️ ${isHomePage ? 'New doc' : 'New page'} button not found — aborting rather than risk editing an existing doc`);
    throw new Error(`Coda: could not find ${isHomePage ? 'New doc' : 'New page'} button — refusing to fall back to an existing doc`);
  }
  await sleep(2500);

  // Step 3: Fill title field
  console.log('   Filling title field...');
  const TITLE_SEL = 'textarea[data-coda-ui-id="page-title"]';
  try {
    await page.waitForSelector(TITLE_SEL, { timeout: 10000 });
    const titleEl = page.locator(TITLE_SEL).first();
    await titleEl.click();
    await sleep(500);
    await page.keyboard.type(String(title).trim(), { delay: 20 });
    console.log('   ✅ Title typed');
  } catch (err: any) {
    console.warn(`   ⚠️ Title field not found: ${err.message}`);
  }
  await sleep(1500);

  // Step 4: Render HTML in a temp page → copy to clipboard → paste into canvas body
  console.log('   Rendering HTML in temp page and copying...');
  try {
    const tempPage = await page.context().newPage();
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
  await sleep(1500);

  console.log('   Clicking canvas body and pasting...');
  const CANVAS_SEL = 'div[data-kr-drop-target="true"][data-canvas-placement-block="true"]';
  const canvasEl = page.locator(CANVAS_SEL).first();
  await canvasEl.click({ timeout: 5000 }).catch(async () => {
    await page.mouse.click(640, 450);
    console.warn('   ⚠️ Canvas body selector not found — used mouse click fallback');
  });
  await sleep(1000);
  await page.keyboard.press('Control+V');
  console.log('   ✅ Content pasted');
  await sleep(2000);

  const draftUrl = page.url();

  // Step 5: Open Share panel
  console.log('   Waiting before opening Share panel...');
  await sleep(3500);
  console.log('   Clicking Share button...');
  const SHARE_SEL = '[data-coda-ui-id="sharing-button"]';
  let shareOpened = false;
  try {
    await page.waitForSelector(SHARE_SEL, { timeout: 8000 });
    await page.locator(SHARE_SEL).first().click({ timeout: 4000 });
    shareOpened = true;
    console.log('   ✅ Share panel opened');
  } catch (err: any) {
    console.warn(`   ⚠️ Share button not found: ${err.message} — using draft URL`);
  }
  if (!shareOpened) {
    return { success: true, postUrl: draftUrl, postedAt: new Date() };
  }
  await sleep(2000);

  // Step 6: Open the access-level control (Globe icon) in the share panel.
  console.log('   Opening access-level control (Globe icon)...');
  let dropdownOpened = false;
  try {
    const shareDialog = page.locator('[role="dialog"]').last();
    const globeIcon = shareDialog.locator('svg[data-icon="Globe"]').first();
    await globeIcon.waitFor({ state: 'visible', timeout: 5000 });
    await globeIcon.click({ timeout: 4000, force: true });
    dropdownOpened = true;
    console.log('   ✅ Access-level control opened (Globe icon)');
  } catch (err: any) {
    console.warn(`   ⚠️ Globe icon not found: ${err.message}`);
  }
  await sleep(1500);

  // Step 7: Confirm "Anyone with the link" access. No stable aria-label on
  // this element, so match on its exact class list; the tooltip span is a
  // fallback in case the button itself isn't the hit target.
  if (dropdownOpened) {
    console.log('   Confirming "Anyone with the link" access...');
    const accessOptionSelectors = [
      'span.utd9D74T.QuZsUaXW.eVb7DBLp[role="button"]',
      'span.C9cn7gCQ.EA0SBqHo.HcHsL0rQ',
    ];
    let accessConfirmed = false;
    for (const sel of accessOptionSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click({ timeout: 4000, force: true });
        accessConfirmed = true;
        console.log(`   ✅ Access option confirmed (${sel})`);
        break;
      }
    }
    if (!accessConfirmed) {
      console.warn('   ⚠️ Could not confirm access option');
    }
    await sleep(2000);
  }

  // Step 7b: Click "Publish doc"
  console.log('   Clicking Publish doc...');
  try {
    const publishBtn = page.locator('[data-coda-ui-id="publish-dialog-publish-button"]').first();
    await publishBtn.waitFor({ state: 'visible', timeout: 5000 });
    await publishBtn.click({ timeout: 4000, force: true });
    console.log('   ✅ Publish doc clicked');
  } catch (err: any) {
    console.warn(`   ⚠️ Publish doc button not found: ${err.message}`);
  }
  await sleep(3000);

  // Step 8: Copy the published link
  console.log('   Copying public link...');
  let publicUrl = draftUrl;
  try {
    const copyLinkSelectors = [
      'span.Tie_K1V4.e6IwyBed.DgTD0n6q.QuZsUaXW.eVb7DBLp[role="button"]',
      'button:has-text("Copy link")',
      '[aria-label*="copy" i]',
      'button[aria-label*="Copy" i]',
    ];
    let linkCopied = false;
    for (const sel of copyLinkSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        // force: true — a transient dialog layer sits on top of this button
        // and blocks the normal actionability check even though the button
        // itself is the correct, visible target.
        await el.click({ timeout: 4000, force: true });
        linkCopied = true;
        console.log(`   ✅ Copy link clicked (${sel})`);
        break;
      }
    }
    if (!linkCopied) {
      console.warn('   ⚠️ Copy link button not found — falling back to draft URL');
    } else {
      await sleep(1500);
      try {
        // Read the OS clipboard directly via PowerShell rather than
        // navigator.clipboard.readText() — the in-page Clipboard API can
        // trigger a native browser permission prompt that never resolves
        // with no one there to click it, hanging the run indefinitely.
        const { execSync } = await import('child_process');
        publicUrl = execSync('powershell -command Get-Clipboard', { timeout: 5000 }).toString().trim();
      } catch (err: any) {
        console.warn(`   ⚠️ Clipboard read failed: ${err.message}`);
      }
      // Coda doc URLs can live on custom domains (e.g. docs.superhuman.com),
      // so just require it to be a real URL rather than checking for coda.io.
      if (!publicUrl || !/^https?:\/\//.test(publicUrl)) {
        publicUrl = draftUrl;
      }
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Copy link failed: ${err.message}`);
    publicUrl = draftUrl;
  }

  await page.keyboard.press('Escape').catch(() => {});
  console.log(`   ✅ Coda page URL: ${publicUrl}`);
  return { success: true, postUrl: publicUrl, postedAt: new Date() };
}
