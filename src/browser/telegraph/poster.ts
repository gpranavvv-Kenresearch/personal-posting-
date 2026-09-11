import { chromium } from 'playwright';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Telegraph has no sign-up/login at all — telegra.ph opens directly into a
 * live editor (Title / Your name / Your story...), and clicking Publish
 * mints the page immediately (confirmed live 2026-09-08). No persistent
 * session, no account file — a fresh anonymous browser per post is enough.
 */
function htmlToTelegraphParagraphs(html: string): string[] {
  let text = html || '';
  // Replace <a href="url">label</a> with the raw url so typing it + a space
  // lets Telegraph's own autolink-on-space matcher turn it into a real link
  // (confirmed live: Playwright's locator.fill()/pressSequentially() silently
  // no-op against this Quill-based editor — only real per-keystroke
  // page.keyboard.type() registers, so the link must come from typed text,
  // not from injecting an <a> node into the DOM directly).
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi, '$1');
  const blocks = text.split(/<\/p>|<br\s*\/?>|\n{2,}/i);
  return blocks
    .map(b => b
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
}

export async function postToTelegraph(
  title: string,
  authorName: string,
  bodyHtml: string,
): Promise<{ url: string }> {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  try {
    const page = await browser.newPage();
    await page.goto('https://telegra.ph', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);

    console.log('   Filling title...');
    await page.click('h1[data-placeholder="Title"]');
    await page.keyboard.type(title.slice(0, 256), { delay: 15 });
    await page.keyboard.press('Enter');

    console.log('   Filling author name...');
    await page.keyboard.type(authorName, { delay: 15 });
    await page.keyboard.press('Enter');

    console.log('   Filling story body...');
    const paragraphs = htmlToTelegraphParagraphs(bodyHtml);
    if (paragraphs.length === 0) {
      throw new Error('Telegraph: body content empty after HTML-to-text conversion.');
    }
    for (let i = 0; i < paragraphs.length; i++) {
      // Trailing space after each paragraph gives any URL at the end a
      // chance to trigger Telegraph's autolink matcher before the newline.
      await page.keyboard.type(paragraphs[i] + ' ', { delay: 12 });
      if (i < paragraphs.length - 1) await page.keyboard.press('Enter');
    }
    await sleep(500);

    console.log('   Clicking Publish...');
    await page.click('button:has-text("Publish")');
    await page.waitForURL(/telegra\.ph\/.+/, { timeout: 15000 }).catch(() => {});
    await sleep(1000);

    const url = page.url();
    if (url === 'https://telegra.ph/' || !/^https:\/\/telegra\.ph\/.+/.test(url)) {
      throw new Error(`Telegraph: publish did not navigate to a page URL (still at ${url}) — post likely failed.`);
    }
    console.log(`   ✅ Telegraph page published: ${url}`);
    return { url };
  } finally {
    await browser.close();
  }
}
