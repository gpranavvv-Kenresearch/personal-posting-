import { Page } from 'playwright';
import TurndownService from 'turndown';
import { injectUTM, UTM_PARAMS } from '../../utils/utm.js';

const SMALL_DELAY = 800;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function gotoWithRetry(page: Page, url: string, expectedDomain: string, retries = 3): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { /* timeout — check URL anyway */ }
    const landed = page.url();
    if (landed !== 'about:blank' && landed !== '' && landed.includes(expectedDomain)) return;
    console.log(`   ⚠️ Navigation to ${url} landed on "${landed}" (attempt ${attempt}/${retries}) — retrying...`);
    await sleep(3000);
  }
  const final = page.url();
  if (final === 'about:blank' || final === '' || !final.includes(expectedDomain)) {
    throw new Error(`Failed to navigate to ${url} after ${retries} attempts. Landed on: ${final}`);
  }
}

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
  // UTM safety net — ensure correct UTMs before posting
  htmlContent = injectUTM(htmlContent, UTM_PARAMS.Devto);

  // Convert HTML to Markdown
  console.log('   Converting HTML to Markdown...');
  const markdownContent = htmlToMarkdown(htmlContent);

  // Navigate directly to new post page
  console.log('   Navigating to Dev.to new post...');
  await gotoWithRetry(page, 'https://dev.to/new', 'dev.to');
  await sleep(2000);

  // Fill title
  console.log('   Filling title...');
  try {
    const titleSel = 'textarea#article-form-title, input#article-form-title, textarea[placeholder*="title" i], textarea[aria-label*="title" i]';
    await page.waitForSelector(titleSel, { timeout: 15000 });
    await page.click(titleSel);
    await sleep(300);
    await page.fill(titleSel, title);
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

  // Wait for navigation to published article URL
  let publishedUrl = page.url();
  try {
    await page.waitForURL(
      url => url.startsWith('https://dev.to/') && !url.includes('/new') && !url.includes('about:blank') && url.split('/').length >= 5,
      { timeout: 30000 }
    );
    publishedUrl = page.url();
  } catch {
    // fallback 1: look for canonical link in page head
    try {
      const canonical = await page.$eval('link[rel="canonical"]', (el: any) => el.href).catch(() => '');
      if (canonical && canonical.startsWith('https://dev.to/') && !canonical.includes('/new')) {
        publishedUrl = canonical;
      }
    } catch { /* ignore */ }

    // fallback 2: look for "View post" or article link — exclude share/social links
    if (!publishedUrl || publishedUrl.includes('/new')) {
      try {
        const links = await page.$$('a[href^="https://dev.to/"]');
        for (const link of links) {
          const href = await link.getAttribute('href') || '';
          if (
            href.startsWith('https://dev.to/') &&
            !href.includes('/new') &&
            !href.includes('/settings') &&
            !href.includes('twitter.com') &&
            !href.includes('intent') &&
            href.split('/').length >= 5
          ) {
            publishedUrl = href;
            break;
          }
        }
      } catch { /* keep existing url */ }
    }
  }
  if (!publishedUrl || publishedUrl === 'about:blank' || publishedUrl.includes('/new')) publishedUrl = page.url();
  console.log(`   ✅ Post published. URL: ${publishedUrl}`);

  return {
    success: true,
    postUrl: publishedUrl,
    postedAt: new Date(),
  };
}
