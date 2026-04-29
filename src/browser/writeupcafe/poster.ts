import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const CLICK_DELAY = 2000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function jsClick(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    if (el) el.click();
  }, selector);
}

export async function postToWriteupCafe(
  page: Page,
  title: string,
  htmlContent: string,
  nickname?: string,
  description?: string,
  seedKeyword?: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.WriteupCafe);

  // Step 1: Navigate directly to write page
  console.log('   Navigating to WriteupCafe post editor...');
  await page.goto('https://writeupcafe.com/post-writeup', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(CLICK_DELAY);

  // Step 2: Click title field and type
  console.log('   Typing title...');
  await jsClick(page, '#write-title');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(String(title).trim(), { delay: 50 });
  console.log('   ✅ Title typed');

  // Step 3: Insert HTML content via CKEditor API → fallback to clipboard paste
  console.log('   Inserting content via CKEditor API...');
  await sleep(CLICK_DELAY);
  const inserted = await page.evaluate((html) => {
    try {
      const ck = (window as any).CKEDITOR;
      if (ck) {
        const keys = Object.keys(ck.instances);
        if (keys.length > 0) {
          ck.instances[keys[0]].setData(html);
          return true;
        }
      }
      return false;
    } catch { return false; }
  }, htmlContent);

  if (!inserted) {
    console.warn('   ⚠️ CKEditor API not found — trying clipboard paste...');
    const tempPage = await page.context().newPage();
    try {
      await tempPage.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await tempPage.waitForTimeout(2000);
      await tempPage.keyboard.press('Control+A');
      await tempPage.waitForTimeout(300);
      await tempPage.keyboard.press('Control+C');
      await tempPage.waitForTimeout(500);
    } finally {
      await tempPage.close();
    }
    await jsClick(page, '.ck.ck-content.ck-editor__editable');
    await sleep(CLICK_DELAY);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Control+V');
  }
  console.log('   ✅ Content inserted');

  // Step 4: Excerpt / description
  console.log('   Typing excerpt...');
  await sleep(CLICK_DELAY);
  await jsClick(page, '#excerpt');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const excerptText = (description || title).slice(0, 490);
  await page.keyboard.type(excerptText, { delay: 30 });
  console.log('   ✅ Excerpt typed');

  // Step 5: Seed / focus keyword
  console.log('   Typing focus keyword...');
  await sleep(CLICK_DELAY);
  await jsClick(page, '#focus_keyword');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const keyword = (seedKeyword || title).slice(0, 110);
  await page.keyboard.type(keyword, { delay: 30 });
  console.log('   ✅ Focus keyword typed');

  // Step 6: Meta description
  console.log('   Typing meta description...');
  await sleep(CLICK_DELAY);
  await jsClick(page, '#meta_description');
  await sleep(CLICK_DELAY);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const metaDesc = (description || title).slice(0, 290);
  await page.keyboard.type(metaDesc, { delay: 30 });
  console.log('   ✅ Meta description typed');

  // Step 7: Pause for captcha — user solves it, then presses Enter
  await new Promise<void>(resolve => {
    process.stdout.write('\n⏸  All fields filled. Solve the captcha in the browser, then type y and press Enter to publish: ');
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  // Step 8: Click Publish
  console.log('   Clicking Publish...');
  await jsClick(page, '#btn-publish');
  await sleep(4000);

  const postUrl = page.url();
  console.log(`   ✅ Posted: ${postUrl}`);

  return {
    success: true,
    postUrl,
    postText: htmlContent,
    postedAt: new Date(),
  };
}
