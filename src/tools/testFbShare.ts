/**
 * testFbShare.ts — Test Share button locators one by one
 * Run: npx tsx src/tools/testFbShare.ts --account pranav
 */

import 'dotenv/config';
import { loginToFacebook, closeFacebookBrowser, getFacebookAccounts, getFacebookAccountByNickname } from '../browser/facebook/login.js';
import { humanDelay } from '../browser/stagehand.js';

async function tryClick(label: string, fn: () => Promise<void>, page: any) {
  try {
    await fn();
    console.log(`✅ ${label} — CLICKED`);
    await humanDelay(1500, 2000);
    await page.screenshot({ path: `screenshots/fb-after-${label.replace(/\s+/g,'_')}.png` });
    return true;
  } catch (err: any) {
    console.log(`❌ ${label} — FAILED: ${err.message?.slice(0, 80)}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const accountIdx = args.indexOf('--account');
  const nickname = accountIdx !== -1 ? args[accountIdx + 1] : undefined;

  const account = nickname
    ? getFacebookAccountByNickname(nickname)
    : getFacebookAccounts().find(a => a.active) ?? null;

  if (!account) {
    console.error(`❌ No account found`);
    process.exit(1);
  }

  console.log(`\n🧪 FB Share Button Test — ${account.nickname ?? account.email}\n`);
  const page = await loginToFacebook({ nickname: account.nickname });

  try {
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
    await humanDelay(3000, 4000);

    let shareClicked = false;

    // ── Locator 1: aria-label on the parent button div
    if (!shareClicked) {
      shareClicked = await tryClick('Locator1_aria-label', async () => {
        await page.locator('div[aria-label="Send this to friends or post it on your profile."][role="button"]').first().click({ timeout: 3000 });
      }, page);
    }

    // ── Locator 2: JS — bg-image URL + position on <i> → click closest role=button
    if (!shareClicked) {
      shareClicked = await tryClick('Locator2_bgimage_js', async () => {
        const found = await page.evaluate(() => {
          const icons = Array.from(document.querySelectorAll('i[data-visualcompletion="css-img"]'));
          const icon = icons.find((el: any) =>
            el.style.backgroundImage?.includes('Fv2SXGWpLpB') &&
            el.style.backgroundPosition?.includes('-844px')
          ) as HTMLElement | undefined;
          if (!icon) return false;
          const btn = icon.closest('[role="button"]') as HTMLElement;
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!found) throw new Error('icon not found in DOM');
      }, page);
    }

    // ── Locator 3: specific class combo on <i> → closest role=button
    if (!shareClicked) {
      shareClicked = await tryClick('Locator3_class_combo', async () => {
        const found = await page.evaluate(() => {
          const el = document.querySelector('i.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1b0d499.x1d69dk1') as HTMLElement;
          if (!el) return false;
          const btn = el.closest('[role="button"]') as HTMLElement;
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!found) throw new Error('element not found');
      }, page);
    }

    // ── Locator 4: role=none data-visualcompletion=ignore with border-radius → parent button
    if (!shareClicked) {
      shareClicked = await tryClick('Locator4_role_none_wrapper', async () => {
        const found = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('[role="none"][data-visualcompletion="ignore"]'));
          const el = els.find((e: any) => e.style.borderRadius === '4px') as HTMLElement;
          if (!el) return false;
          const btn = el.closest('[role="button"]') as HTMLElement;
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!found) throw new Error('wrapper not found');
      }, page);
    }

    // ── Locator 5: generic aria-label contains Share
    if (!shareClicked) {
      shareClicked = await tryClick('Locator5_aria_contains_share', async () => {
        await page.locator('[aria-label*="Share"][role="button"]').first().click({ timeout: 3000 });
      }, page);
    }

    if (!shareClicked) {
      console.log('\n❌ All locators failed');
      await page.screenshot({ path: 'screenshots/fb-share-all-failed.png' });
      return;
    }

    // ── Try Copy Link
    console.log('\n→ Trying Copy Link...');
    await humanDelay(1000, 1500);

    const copySelectors = [
      'span:has-text("Copy link")',
      '[role="menuitem"]:has-text("Copy link")',
      '[role="menuitem"]:has-text("Copy")',
      'a:has-text("Copy link")',
    ];

    let copyDone = false;
    for (const sel of copySelectors) {
      try {
        await page.locator(sel).first().click({ timeout: 2000 });
        console.log(`✅ Copy Link clicked with: ${sel}`);
        copyDone = true;
        break;
      } catch {
        console.log(`❌ Copy Link failed: ${sel}`);
      }
    }

    if (copyDone) {
      await humanDelay(800, 1000);
      const url = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      console.log(url?.includes('facebook.com') ? `\n✅ Post URL: ${url}` : `\n⚠️  Clipboard: ${url}`);
    }

  } catch (err: any) {
    console.error(`\n❌ Fatal: ${err.message}`);
    await page.screenshot({ path: 'screenshots/fb-share-error.png' }).catch(() => {});
  } finally {
    await closeFacebookBrowser();
  }
}

main();
