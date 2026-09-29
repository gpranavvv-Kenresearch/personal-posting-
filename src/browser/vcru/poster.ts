import { Page } from 'playwright';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Post an article to vc.ru.
 *
 * Flow (from real selectors supplied by the user):
 * 1. Click the header "pen" write button — opens the editor as an in-page
 *    popup (not a full navigation, despite its /editor href).
 * 2. Click the popup's maximize/restore toggle to bring it to full screen.
 * 3. Fill the title field (contenteditable, placeholder "Заголовок").
 * 4. Paste the HTML content into the body field (contenteditable,
 *    placeholder "В уездном городе N было...") via the same
 *    render-then-clipboard-copy technique used for Note.com.
 * 5. Press Enter to accept the browser's paste-permission popup.
 * 6. Click the footer "share" (bookmark/reply icon) button.
 * 7. Click "Копировать ссылку" (Copy Link) in the context menu that opens —
 *    this copies the published post's URL to the clipboard.
 */
export async function postToVcru(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postText: string; postedAt: Date }> {
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Vcru);

  // 1. Open the editor popup via the header pen/write button
  console.log('   Opening vc.ru editor...');
  const writeBtn = page.locator('a[href="/editor"] button:has(svg.icon--pen), button:has(svg.icon--pen)').first();
  await writeBtn.click({ delay: 150 });
  await sleep(2500);

  // 2. Maximize the popup to full screen
  console.log('   Maximizing editor popup...');
  const maximizeBtn = page.locator('button:has(svg.icon--minimize)').first();
  await maximizeBtn.click({ delay: 150 }).catch(() => {});
  await sleep(1500);

  // 3. Fill title
  console.log('   Filling title...');
  const titleField = page.locator('div[data-placeholder="Заголовок"][contenteditable="true"]').first();
  await titleField.click({ delay: 150 });
  await sleep(300);
  await page.keyboard.insertText(title);
  await sleep(1000);

  // 4. Convert HTML -> paste into the body editor via clipboard, same
  // technique as the Note poster (renders the HTML in a scratch page,
  // copies it, then pastes into vc.ru's rich-text body field).
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

  await sleep(1000);
  const bodyField = page.locator('div.editor-text-tool[contenteditable="true"]').first();
  await bodyField.click({ delay: 150 });
  await sleep(500);
  await page.keyboard.press('Control+V');
  await sleep(1500);

  // 5. Accept the browser's paste-permission popup, if it appears
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(3000);

  // 6. Click the footer share button
  console.log('   Opening share menu...');
  const shareBtn = page.locator('button.content-footer-button.bookmark-button:has(svg.icon--reply)').first();
  await shareBtn.click({ delay: 150 });
  await sleep(1500);

  // 7. Click "Копировать ссылку" (Copy Link) — copies the post URL to clipboard
  console.log('   Copying post URL...');
  const copyLinkOption = page.locator('[data-gtm-click*="Copy Link"], div.context-list-option:has-text("Копировать ссылку")').first();
  await copyLinkOption.click({ delay: 150 });
  await sleep(1500);

  let postUrl = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  if (!postUrl || !postUrl.includes('vc.ru')) {
    postUrl = await page.$eval('link[rel="canonical"]', el => el.getAttribute('href') ?? '').catch(() => '');
  }

  console.log(`   ✅ vc.ru post published: ${postUrl}`);
  return {
    success: true,
    postUrl,
    postText: title,
    postedAt: new Date(),
  };
}
