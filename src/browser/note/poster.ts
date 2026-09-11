import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function postToNote(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Note);

  // Navigate to new note editor
  console.log('   Navigating to Note new article...');
  await page.goto('https://note.com/notes/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Click テキスト if type-selection screen appears
  try {
    const textBtn = page.locator('button:has-text("テキスト"), a:has-text("テキスト")').first();
    if (await textBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await textBtn.click({ delay: 150 });
      await sleep(2000);
    }
  } catch { /* already in editor */ }

  // Fill title
  console.log('   Filling title...');
  await sleep(2000);
  const titleField = page.locator('textarea[placeholder="記事タイトル"], textarea[placeholder="Article Title"]').first();
  await titleField.click({ delay: 150 }).catch(() => {});
  await sleep(500);
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(title);
  await sleep(1000);

  // Convert HTML → paste into ProseMirror body
  console.log('   Pasting content into editor...');
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

  await sleep(2000);
  const bodyField = page.locator('div.ProseMirror.note-common-styles__textnote-body[contenteditable="true"]').first();
  await bodyField.click({ delay: 150 }).catch(() => {});
  await sleep(500);
  await page.keyboard.press('Control+V');
  await sleep(4000);

  // Click "Proceed to public" (outline button — bg-surface-normal)
  console.log('   Clicking Proceed to public...');
  await sleep(2000);
  const proceedBtn = page.locator('button[data-name="Button"][class*="bg-surface-normal"]').first();
  await proceedBtn.click({ delay: 150 }).catch(() => {});
  await sleep(5000);

  // Click 投稿する publish confirm (accent button — bg-custom-accent)
  console.log('   Clicking 投稿する...');
  const publishBtn = page.locator('button[data-name="Button"][class*="bg-custom-accent"]').first();
  await publishBtn.waitFor({ state: 'visible', timeout: 10000 });
  await publishBtn.click({ delay: 150 });
  const reClickWait = 3000 + Math.floor(Math.random() * 1000);
  await sleep(reClickWait);
  console.log('   Clicking 投稿する...');
  await publishBtn.click({ delay: 150 }).catch(() => {});
  await sleep(5000);

  // Copy link for URL — never use address bar
  console.log('   Copying post URL...');
  await sleep(3000);
  const copyLinkBtn = page.locator('button[aria-label="Copy link"], button[aria-label="リンクをコピー"]').first();
  await copyLinkBtn.click({ delay: 150 }).catch(() => {});
  await sleep(2000);
  let postUrl = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  if (!postUrl || !postUrl.includes('note.com')) {
    postUrl = await page.$eval('link[rel="canonical"]', el => el.getAttribute('href') ?? '').catch(() => '');
  }

  console.log(`   ✅ Note article posted: ${postUrl}`);
  return {
    success: true,
    postUrl,
    postText: title,
    postedAt: new Date(),
  };
}
