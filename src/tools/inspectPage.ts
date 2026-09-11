/**
 * inspectPage.ts — Dump real button/input/textarea DOM from an authenticated
 * platform page, so poster.ts selectors can be fixed against ground truth
 * instead of guessed. Reuses the saved session (must already be logged in).
 *
 * Usage:
 *   npx tsx src/tools/inspectPage.ts --platform instapaper --nickname pranav
 */
import 'dotenv/config';

const TARGETS: Record<string, { url: (title: string, targetUrl: string) => string }> = {
  instapaper: { url: () => `https://www.instapaper.com/edit?url=${encodeURIComponent('https://www.kenresearch.com/blog/test')}&title=${encodeURIComponent('Test Title')}` },
  raindrop: { url: () => 'https://app.raindrop.io/my/0' },
  mastodon: { url: () => 'https://mastodon.social/publish' },
  pdfhost: { url: () => 'https://pdfhost.io/upload' },
};

async function dumpInteractiveElements(page: any, label: string) {
  console.log(`\n──── ${label}: current URL ────`);
  console.log(page.url());

  // Passed as a STRING (not a function reference) — tsx/esbuild's dev
  // transform injects a `__name(...)` helper call around functions for
  // stack-trace name-keeping, and Playwright ships evaluate() functions to
  // the browser via .toString(), where that helper doesn't exist → crashes
  // with "__name is not defined". A raw string body sidesteps the transform
  // entirely since tsx never touches string literal contents.
  const EVAL_SRC = `
    (() => {
      const keepAttrs = ['id', 'class', 'name', 'type', 'aria-label', 'placeholder', 'data-testid', 'role', 'href'];
      const describe = (el) => {
        const attrs = Array.from(el.attributes).filter(a => keepAttrs.includes(a.name)).map(a => a.name + '="' + (a.value || '').slice(0, 80) + '"').join(' ');
        const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        const tag = el.tagName.toLowerCase();
        return '<' + tag + ' ' + attrs + '>' + text + '</' + tag + '>';
      };
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a[class*="button" i], a[class*="btn" i]')).slice(0, 40).map(describe);
      const inputs = Array.from(document.querySelectorAll('input, textarea')).slice(0, 40).map(describe);
      return { buttons, inputs };
    })()
  `;
  const dump = await page.evaluate(EVAL_SRC);

  console.log(`\n── Buttons/clickable (${dump.buttons.length}) ──`);
  dump.buttons.forEach((b: string) => console.log('  ' + b));
  console.log(`\n── Inputs/textareas (${dump.inputs.length}) ──`);
  dump.inputs.forEach((i: string) => console.log('  ' + i));
}

async function main() {
  const args = process.argv.slice(2);
  const platform = args[args.indexOf('--platform') + 1];
  const nickname = args[args.indexOf('--nickname') + 1] || 'pranav';
  const target = TARGETS[platform];

  if (!target) {
    console.error(`Usage: npx tsx src/tools/inspectPage.ts --platform <${Object.keys(TARGETS).join('|')}> --nickname <name>`);
    process.exit(1);
  }

  console.log(`\n🔍 Inspecting ${platform} (account: ${nickname})...\n`);

  try {
    switch (platform) {
      case 'instapaper': {
        const { loginToInstapaper, closeInstapaperBrowser } = await import('../browser/instapaper/login.js');
        const page = await loginToInstapaper({ nickname });
        await page.goto(target.url('', ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));
        await dumpInteractiveElements(page, 'Instapaper add-bookmark page');
        await closeInstapaperBrowser();
        break;
      }
      case 'raindrop': {
        const { loginToRaindrop, closeRaindropBrowser } = await import('../browser/raindrop/login.js');
        const page = await loginToRaindrop({ nickname });
        await page.goto(target.url('', ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        await dumpInteractiveElements(page, 'Raindrop home (before clicking Add)');

        const addBtn = page.locator('div[role="button"]').filter({ hasText: /^Add$/ }).first();
        if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await addBtn.click();
          await new Promise(r => setTimeout(r, 1500));
          await dumpInteractiveElements(page, 'Raindrop AFTER clicking Add');

          const urlBox = page.locator('textarea[placeholder="https://"]').first();
          if (await urlBox.isVisible({ timeout: 3000 }).catch(() => false)) {
            await urlBox.click();
            await page.keyboard.type('https://www.kenresearch.com/blog/inspect-test-url', { delay: 15 });
            await new Promise(r => setTimeout(r, 2000));
            await dumpInteractiveElements(page, 'Raindrop AFTER typing URL (before submit)');
          }
        } else {
          console.log('\n⚠️ "Add" button (div[role=button]:text-is("Add")) not found.');
        }
        await closeRaindropBrowser();
        break;
      }
      case 'mastodon': {
        const { loginToMastodon, closeMastodonBrowser } = await import('../browser/mastodon/login.js');
        const page = await loginToMastodon({ nickname });
        await page.goto(target.url('', ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
        await dumpInteractiveElements(page, 'Mastodon home');
        await closeMastodonBrowser();
        break;
      }
      case 'pdfhost': {
        const { loginToPdfHost, closePdfHostBrowser } = await import('../browser/pdfhost/login.js');
        const page = await loginToPdfHost({ nickname });
        await page.goto(target.url('', ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2500));
        await dumpInteractiveElements(page, 'PdfHost home');

        const extra = await page.evaluate(`
          (() => {
            const fileInputs = Array.from(document.querySelectorAll('input[type="file"]')).map(el => el.outerHTML.slice(0, 200));
            const uploadish = Array.from(document.querySelectorAll('[class*="upload" i], [id*="upload" i], [data-testid*="upload" i], label')).slice(0, 20).map(el => el.outerHTML.slice(0, 200));
            return { fileInputs, uploadish };
          })()
        `);
        console.log('\n── input[type=file] anywhere in DOM ──');
        (extra as any).fileInputs.forEach((s: string) => console.log('  ' + s));
        console.log('\n── elements with "upload" in class/id/testid, or <label> ──');
        (extra as any).uploadish.forEach((s: string) => console.log('  ' + s));

        const links = await page.evaluate(`
          Array.from(document.querySelectorAll('a')).slice(0, 40).map(el => el.getAttribute('href') + ' :: ' + (el.textContent||'').trim().slice(0,40))
        `);
        console.log('\n── all <a> links on the page ──');
        (links as any).forEach((s: string) => console.log('  ' + s));

        await closePdfHostBrowser();
        break;
      }
    }
    process.exit(0);
  } catch (err: any) {
    console.error(`\n❌ Inspect failed: ${err.message}\n`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
