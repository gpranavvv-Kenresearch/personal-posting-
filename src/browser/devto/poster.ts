import { Page } from 'playwright';
import TurndownService from 'turndown';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 800;

/**
 * Convert HTML to Markdown for Dev.to editor
 * Preserves images, links, headings, lists
 */
function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });

  td.addRule('images', {
    filter: 'img',
    replacement: (content, node: any) => {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      return src ? `![${alt}](${src})\n\n` : '';
    },
  });

  return td.turndown(html || '');
}

/**
 * Post to Dev.to (expects logged-in page)
 * Content Format: HTML (converted to Markdown)
 */
export async function postToDevto(
  page: Page,
  title: string,
  htmlContent: string,
): Promise<{ success: true; postUrl: string; postedAt: Date }> {
  console.log('   Navigating to Dev.to...');
  await page.goto('https://dev.to/', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Devto);

  // Convert HTML to Markdown
  console.log('   Converting HTML to Markdown...');
  const markdownContent = htmlToMarkdown(htmlContent);

  // Click create post button
  console.log('   Clicking create post button...');
  try {
    await page.click('.js-policy-article-create');
    await page.waitForTimeout(2000);
  } catch {
    throw new Error('Create post button not found');
  }

  // Fill title
  console.log('   Filling title...');
  try {
    await page.click('#article-form-title');
    await page.fill('#article-form-title', title);
    await page.waitForTimeout(SMALL_DELAY);
  } catch {
    throw new Error('Title field not found or not writable');
  }

  // Click Code toolbar button to enable markdown editor
  console.log('   Activating markdown editor...');
  try {
    await page.click('button[aria-label="Code"].toolbar-btn');
    await page.waitForTimeout(2000);
  } catch {
    throw new Error('Code toolbar button not found');
  }

  // Fill content via clipboard
  console.log('   Pasting markdown content...');
  try {
    const editor = await page.waitForSelector('#article_body_markdown', { timeout: 15000 });
    await editor.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(300);

    // Insert markdown directly — no clipboard
    await page.keyboard.insertText(markdownContent);
    await page.waitForTimeout(2000);
  } catch {
    throw new Error('Content editor not found or not writable');
  }

  // Click Publish button
  console.log('   Clicking Publish button...');
  try {
    const publishBtn = page
      .locator('button.c-btn.c-btn--primary')
      .filter({ hasText: /^publish$/i })
      .first();

    await publishBtn.waitFor({ state: 'visible', timeout: 10000 });
    await publishBtn.click();
    await page.waitForTimeout(3000);
  } catch {
    throw new Error('Publish button not found');
  }

  // Get published URL from address bar
  const publishedUrl = page.url();
  console.log(`   ✅ Post published. URL: ${publishedUrl}`);

  return {
    success: true,
    postUrl: publishedUrl,
    postedAt: new Date(),
  };
}
