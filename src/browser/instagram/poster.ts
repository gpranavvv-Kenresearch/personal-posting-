import { Page } from 'playwright';

// ── Selectors (from original script) ─────────────────────────────────────────

const ACTION_BUTTON_SELECTOR =
  'div.x1i10hfl.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.xdl72j9.x2lah0s.x3ct3a4.xdj266r.x14z9mp.xat24cr.x1lziwak.x2lwn1j.xeuugli.x1hl2dhg.xggy1nq.x1ja2u2z.x1t137rt.x1q0g3np.x1a2a7pz.x6s0dn4.xjyslct.x1ejq31n.x18oe1m7.x1sy0etr.xstzfhl.x9f619.x1ypdohk.x1f6kntn.xl56j7k.x17ydfre.x2b8uid.xlyipyv.x87ps6o.x14atkfc.x5c86q.x18br7mf.x1i0vuye.xl0gqc1.xr5sc7.xlal1re.x14jxsvd.xt0b8zv.xjbqb8w.xr9e8f9.x1e4oeot.x1ui04y5.x6en5u8.x972fbf.x10w94by.x1qhh985.x14e42zd.xt0psk2.xt7dq6l.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1n2onr6.x1n5bzlp';

const CAPTION_SELECTOR =
  'div[aria-label="Write a caption..."][contenteditable="true"]';

const CROP_BUTTON_SELECTOR =
  'svg[aria-label="Select crop"]';

const POPUP_SECOND_BUTTON_SELECTOR =
  'div.xdj266r.x14z9mp.xat24cr.xexx8yu.x18d9i69.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1diwwjn.x11lfxj5.x135b78x.x1n2onr6.x1plvlek.xryxfnj.x1iyjqo2.x2lwn1j.xeuugli.x1q0g3np.xqjyukv.x6s0dn4.x1oa3qoh.x1nhvcw1';

const CLOSE_BUTTON_SELECTOR = 'svg[aria-label="Close"]';

// ── Timings ───────────────────────────────────────────────────────────────────

const FIRST_CLICK_DELAY    = 2000;
const BETWEEN_CLICKS       = 1000;
const AFTER_SECOND_CLICK   = 3000;
const AFTER_THIRD_CLICK    = 5000;
const NEXT_TIMEOUT         = 15000;
const SHARE_TIMEOUT        = 20000;
const CLOSE_TIMEOUT        = 10000;
const WAIT_BEFORE_CLOSE    = 7000;

// ── Post result ───────────────────────────────────────────────────────────────

export interface InstagramPostResult {
  success: boolean;
  error?: string;
}

// ── Post to Instagram ─────────────────────────────────────────────────────────

export async function postToInstagram(
  page: Page,
  params: { filePath: string; description: string }
): Promise<InstagramPostResult> {
  const { filePath, description } = params;

  try {
    await page.waitForTimeout(FIRST_CLICK_DELAY);

    // Step 1: Click + (create) icon
    const plusIcon = page.locator('path[d="M21 11h-8V3a1 1 0 1 0-2 0v8H3a1 1 0 1 0 0 2h8v8a1 1 0 1 0 2 0v-8h8a1 1 0 1 0 0-2Z"]').first();
    await plusIcon.waitFor({ state: 'visible', timeout: 10000 });
    await plusIcon.click();
    console.log('   Clicked + icon');

    await page.waitForTimeout(BETWEEN_CLICKS);

    // Step 2: Click popup action button (Post option)
    const popupBtn = page.locator(
      'div.xdj266r.x14z9mp.xat24cr.x1lziwak.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.xv54qhq.xf7dkkf.xwib8y2.x1y1aw1k.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.xn3w4p2'
    ).first();
    await popupBtn.waitFor({ state: 'visible', timeout: 10000 });
    await popupBtn.click();
    console.log('   Clicked popup action button');

    await page.waitForTimeout(AFTER_SECOND_CLICK);

    // Step 3: Click "Select from computer" — set up file chooser first
    const fileChooserPromise = page.waitForEvent('filechooser');
    const selectBtn = page.locator('button._aswp._aswr._aswu._asw_._asx2:has-text("Select from computer")').first();
    await selectBtn.waitFor({ state: 'visible', timeout: 10000 });
    await selectBtn.click();
    console.log('   Clicked "Select from computer"');

    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);
    console.log(`   Selected file: ${filePath}`);

    await page.waitForTimeout(AFTER_THIRD_CLICK);

    // Step 4: Crop + popup after crop
    try {
      const cropIcon = page.locator(CROP_BUTTON_SELECTOR).first();
      await cropIcon.waitFor({ state: 'visible', timeout: NEXT_TIMEOUT });
      await cropIcon.click();
      console.log('   Clicked crop icon');

      await page.waitForTimeout(BETWEEN_CLICKS);

      const cropPopupBtn = page.locator(POPUP_SECOND_BUTTON_SELECTOR).first();
      await cropPopupBtn.waitFor({ state: 'visible', timeout: NEXT_TIMEOUT });
      await cropPopupBtn.click();
      console.log('   Clicked crop popup option');

      await page.waitForTimeout(BETWEEN_CLICKS);
    } catch {
      console.log('   Crop step skipped (not visible)');
    }

    // Step 5: Next → Next
    for (let i = 1; i <= 2; i++) {
      const nextBtn = page.locator(`${ACTION_BUTTON_SELECTOR}:has-text("Next")`).first();
      await nextBtn.waitFor({ state: 'visible', timeout: NEXT_TIMEOUT });
      await nextBtn.click();
      console.log(`   Clicked Next (${i}/2)`);
      await page.waitForTimeout(BETWEEN_CLICKS);
    }

    // Step 6: Fill caption
    if (description) {
      const caption = page.locator(CAPTION_SELECTOR).first();
      await caption.waitFor({ state: 'visible', timeout: NEXT_TIMEOUT });
      await caption.click();
      await caption.fill(description);
      console.log('   Filled caption');
      await page.waitForTimeout(BETWEEN_CLICKS);
    }

    // Step 7: Share
    const shareBtn = page.locator(`${ACTION_BUTTON_SELECTOR}:has-text("Share")`).first();
    await shareBtn.waitFor({ state: 'visible', timeout: SHARE_TIMEOUT });
    await shareBtn.click();
    console.log('   Clicked Share');
    await page.waitForTimeout(2000);

    // Step 8: Close dialog
    await page.waitForTimeout(WAIT_BEFORE_CLOSE);
    try {
      const closeBtn = page.locator(CLOSE_BUTTON_SELECTOR).first();
      await closeBtn.waitFor({ state: 'visible', timeout: CLOSE_TIMEOUT });
      await closeBtn.click();
      console.log('   Clicked Close');
      await page.waitForTimeout(BETWEEN_CLICKS);
    } catch {
      console.log('   Close step skipped (not visible)');
    }

    return { success: true };

  } catch (err: any) {
    console.error(`   ❌ Instagram post failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}
