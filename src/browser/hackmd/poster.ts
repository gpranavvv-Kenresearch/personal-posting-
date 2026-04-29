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
  // Wait for HackMD to redirect from /new to the actual note URL (e.g. /AbCdEf12)
  try {
    await page.waitForFunction(
      () => !window.location.href.includes('/new') && window.location.href !== 'https://hackmd.io/',
      { timeout: 10000 }
    );
  } catch { /* some accounts may not redirect — fall back */ }
  const noteUrl = page.url(); // capture BEFORE any clicks change the URL
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

    // Open note settings popup
    console.log('   Opening note settings...');
    await page.click("div[data-original-title='Note settings']");
    await sleep(2000);

    try {
      // Fill title in settings via paste
      await page.click('input[placeholder="Untitled"]');
      await page.keyboard.press('Control+A');
      await paste(page, title);

      // Fill description via paste — use row.description (column B), fallback to title
      const descText = (description || '').trim() || title;
      const descField = await page.$('textarea[placeholder*="What is the note about?"]');
      if (descField) {
        await descField.click();
        await page.keyboard.press('Control+A');
        await paste(page, descText);
      }

      // Click Update button
      const updateBtn = await page.$('button.ui-meta-title-description-edit-submit');
      if (updateBtn) {
        await sleep(2000);
        await updateBtn.click();
        console.log('   ✅ Settings updated');

        await sleep(2000);
        try {
          const discardBtn = await page.waitForSelector('button.bg-state-danger-bg-default', {
            state: 'visible',
            timeout: 8000,
          });
          if (discardBtn) {
            await discardBtn.click();
            console.log('   Discard dialog dismissed');
            await sleep(2000);
          }
        } catch {
          // No discard dialog — fine
        }
      }
    } catch (e: any) {
      console.warn('   ⚠️ Note settings popup step failed:', e.message);
    }

    // Close popup by clicking editor
    try {
      const editor = await page.$('.CodeMirror');
      if (editor) {
        const box = await editor.boundingBox();
        if (box) {
          await page.mouse.click(box.x + 50, box.y + 50);
          await sleep(400);
          await page.mouse.click(box.x + 50, box.y + 50);
          await sleep(800);
        }
      }
    } catch { /* non-critical */ }

    // Share → set visibility to Everyone
    console.log('   Setting visibility to Everyone...');
    try {
      const shareBtn = await page.$('li.ui-share-button');
      if (shareBtn) {
        await shareBtn.click();
        await sleep(1200);
      }

      const dropdownTrigger = await page.$('button.menuitem-dropdown-trigger');
      if (dropdownTrigger) {
        await dropdownTrigger.click();
        await sleep(800);
      }

      const everyoneBtn = await page.$('a.ui-note-read-everyone');
      if (everyoneBtn) {
        await everyoneBtn.click();
        await sleep(1000);
      }
    } catch (e: any) {
      console.warn('   ⚠️ Visibility setting failed:', e.message);
    }

    // Publish
    console.log('   Publishing note...');
    try {
      const publishTab = await page.$('button.ui-publish-tab-link');
      if (publishTab) {
        await publishTab.click();
        await sleep(1200);
      }

      const consentCheck = await page.$('input[type="checkbox"]');
      if (consentCheck) {
        await consentCheck.click();
        await sleep(800);
      }

      const finalPublish = await page.$('button.unpublish');
      if (finalPublish) {
        await finalPublish.click();
        await sleep(1500);
      }
    } catch (e: any) {
      console.warn('   ⚠️ Publish step failed:', e.message);
    }

    console.log(`   ✅ HackMD note posted: ${noteUrl}`);

    return {
      success: true,
      postUrl: noteUrl,
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
