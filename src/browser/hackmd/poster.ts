import { Page } from 'playwright';
import { createRequire } from 'module';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';
const require = createRequire(import.meta.url);
const TurndownService = require('turndown') as { new(options?: any): { turndown(html: string): string } };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function paste(page: Page, text: string): Promise<void> {
  await page.keyboard.insertText(text);
  await sleep(300);
}

async function highlightClick(page: Page, selector: string, opts?: { force?: boolean }): Promise<boolean> {
  const el = await page.$(selector);
  if (!el) return false;
  await el.click({ force: opts?.force, delay: 150 }).catch(() => {});
  return true;
}

export async function postToHackMD(
  page: Page,
  title: string,
  htmlContent: string,
  description?: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.HackMD);

  const turndown = new TurndownService();
  const markdown = turndown.turndown(htmlContent);

  // Minimize browser window
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore */ }

  console.log('   Navigating to HackMD new note...');
  await page.goto('https://hackmd.io/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(
      () => !window.location.href.includes('/new') && window.location.href !== 'https://hackmd.io/',
      { timeout: 10000 }
    );
  } catch { /* fall back */ }
  const noteUrl = page.url();
  console.log(`   Note URL captured: ${noteUrl}`);
  await sleep(3000);

  // Ensure the CodeMirror editor is present
  if (!(await page.$('.CodeMirror'))) {
    const createBtn = await page.$('div.create-note');
    if (createBtn) {
      await createBtn.click();
      await page.waitForSelector('.CodeMirror', { timeout: 10000 });
    }
  }

  try {
    // Set title via paste
    console.log('   Setting title...');
    const titleInput = await page.$('.ui-note-meta-title');
    if (titleInput) {
      await titleInput.click();
      await page.keyboard.press('Control+A');
      await paste(page, title);
    }

    // Set markdown body via CodeMirror API
    console.log('   Pasting markdown content...');
    await page.click('.CodeMirror');
    await page.evaluate((md: string) => {
      const cm = (document.querySelector('.CodeMirror') as any)?.CodeMirror;
      if (cm) cm.setValue(md);
    }, markdown);
    await sleep(1000);

    // Open note settings
    console.log('   Opening note settings...');
    await highlightClick(page, "div[data-original-title='Note settings']");
    await sleep(2000);

    try {
      // Fill title
      await highlightClick(page, 'input[placeholder="Untitled"]');
      await page.keyboard.press('Control+A');
      await paste(page, title);

      // Fill description
      const descText = (description || '').trim() || title;
      const descField = await page.$('textarea[placeholder*="What is the note about?"]');
      if (descField) {
        await descField.click();
        await page.keyboard.press('Control+A');
        await paste(page, descText);
      }

      // Click Update up to 3 times
      const updateBtn = await page.$('button.ui-meta-title-description-edit-submit');
      if (updateBtn) {
        await highlightClick(page, 'button.ui-meta-title-description-edit-submit');
        console.log('   Clicked Update (1st)');
        await sleep(800);

        const still2 = await updateBtn.isEnabled().catch(() => false);
        if (still2) {
          await highlightClick(page, 'button.ui-meta-title-description-edit-submit');
          console.log('   Clicked Update (2nd)');
          await sleep(800);
        }

        const still3 = await updateBtn.isEnabled().catch(() => false);
        if (still3) {
          await highlightClick(page, 'button.ui-meta-title-description-edit-submit');
          console.log('   Clicked Update (3rd)');
          await sleep(1000);

          // Click CodeMirror to close modal
          const editor = await page.$('.CodeMirror');
          if (editor) {
            const box = await editor.boundingBox();
            if (box) {
              console.log('   Clicking CodeMirror to close modal...');
              await page.mouse.click(box.x + 50, box.y + 50);
              await sleep(1500);
            }
          }

          // Discard dialog — click via JS
          const hasDiscard = await page.evaluate(() =>
            !!Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Discard')
          ).catch(() => false);

          if (hasDiscard) {
            await page.evaluate(() => {
              const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Discard') as HTMLElement | null;
              if (btn) btn.click();
            }).catch(() => {});
            console.log('   Discard clicked');
            await sleep(1500);

            // Click CodeMirror again to fully close
            if (editor) {
              const box = await editor.boundingBox();
              if (box) {
                console.log('   Clicking CodeMirror again...');
                await page.mouse.click(box.x + 50, box.y + 50);
                await sleep(1000);
              }
            }
          }
        }
        console.log('   ✅ Settings done');
      }
    } catch (e: any) {
      console.warn('   ⚠️ Note settings step failed:', e.message);
    }

    // Share → set visibility to Everyone
    console.log('   Setting visibility to Everyone...');
    let publicUrl = noteUrl;
    try {
      await highlightClick(page, 'button.ui-sharing');
      await sleep(1200);

      await highlightClick(page, 'button.menuitem-dropdown-trigger');
      await sleep(800);

      await highlightClick(page, 'a.ui-note-read-everyone');
      await sleep(1000);
    } catch (e: any) {
      console.warn('   ⚠️ Visibility setting failed:', e.message);
    }

    // Publish
    console.log('   Publishing note...');
    try {
      await highlightClick(page, 'button.ui-publish-tab-link');
      await sleep(1200);

      await highlightClick(page, 'input[type="checkbox"]');
      await sleep(800);

      await highlightClick(page, 'button.unpublish');
      await sleep(1500);

      // Grab public permalink from copy-link button
      const copyBtn = await page.$('button.ui-share-copy');
      if (copyBtn) {
        const permalink = await copyBtn.getAttribute('data-permalink');
        if (permalink) publicUrl = permalink;
      }
    } catch (e: any) {
      console.warn('   ⚠️ Publish step failed:', e.message);
    }

    console.log(`   ✅ HackMD note posted: ${publicUrl}`);

    return {
      success: true,
      postUrl: publicUrl,
      postText: markdown,
      postedAt: new Date(),
    };

  } catch (err: any) {
    console.warn(`   ⚠️ Post-navigation step failed: ${err.message}`);
    return {
      success: true,
      postUrl: noteUrl || page.url() || 'https://hackmd.io/',
      postText: markdown,
      postedAt: new Date(),
    };
  }
}
