/**
 * test-li-share-click.ts
 * Diagnostic script — finds & clicks the Share button in LinkedIn's post action bar
 * Run: node --import=tsx test-li-share-click.ts <nickname>
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';

const nickname = process.argv[2] || 'default';
const SESSION_ROOT = path.resolve('li-sessions');
const sessionDir = path.join(SESSION_ROOT, String(nickname).replace(/[^a-z0-9_-]/gi, '_'));
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`\n🔍 LinkedIn Share Button Diagnostic — account: ${nickname}`);
  console.log(`   Session dir: ${sessionDir}\n`);

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: CHROME_PATH,
    viewport: { width: 1280, height: 800 },
  });

  const page = context.pages()[0] || await context.newPage();

  // ── Go to feed ─────────────────────────────────────────────────────────────
  console.log('📄 Navigating to LinkedIn feed...');
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await sleep(3000);

  // ── Audit all action bar buttons on first post ─────────────────────────────
  console.log('\n🔎 Scanning action bar buttons on first post...');
  const buttons = await page.evaluate(() => {
    // Find the action bar container by looking for the div that has like/comment/repost/share
    const allButtons = Array.from(document.querySelectorAll('button, a[role="button"], a[aria-label]'));
    return allButtons
      .filter(el => {
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const text = (el.textContent || '').trim().toLowerCase();
        return label.includes('share') || label.includes('send') || text.includes('share') || text.includes('send');
      })
      .map(el => ({
        tag: el.tagName,
        ariaLabel: el.getAttribute('aria-label'),
        text: (el.textContent || '').trim().slice(0, 60),
        svgIds: Array.from(el.querySelectorAll('svg[id]')).map(s => s.id),
        href: el.getAttribute('href'),
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
      }));
  });

  if (buttons.length === 0) {
    console.log('   ❌ No share/send buttons found on the page');
  } else {
    console.log(`   Found ${buttons.length} share/send-related element(s):\n`);
    buttons.forEach((b, i) => {
      console.log(`   [${i}] <${b.tag}>`);
      console.log(`       aria-label : "${b.ariaLabel}"`);
      console.log(`       text       : "${b.text}"`);
      console.log(`       svg ids    : [${b.svgIds.join(', ')}]`);
      console.log(`       href       : "${b.href}"`);
      console.log(`       position   : x=${b.rect.x} y=${b.rect.y} w=${b.rect.w} h=${b.rect.h}`);
      console.log('');
    });
  }

  // ── Try clicking first share button found ─────────────────────────────────
  if (buttons.length > 0) {
    const target = buttons[0];
    console.log(`🖱️  Clicking element [0] at (${target.rect.x}, ${target.rect.y})...`);
    await page.mouse.click(target.rect.x, target.rect.y);
    await sleep(3000);

    // ── Scan for "Copy link to post" popup ────────────────────────────────
    console.log('\n🔎 Scanning for "Copy link to post" in popup...');
    const copyBtn = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span, button, a, li'));
      const el = spans.find(s => (s.textContent || '').trim() === 'Copy link to post');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        text: el.textContent?.trim(),
        rect: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
      };
    });

    if (copyBtn) {
      console.log(`   ✅ Found "Copy link to post" at (${copyBtn.rect.x}, ${copyBtn.rect.y}) — clicking`);
      await page.mouse.click(copyBtn.rect.x, copyBtn.rect.y);
      await sleep(1500);
      console.log('   ✅ Clicked. Check clipboard for URL.');
    } else {
      console.log('   ❌ "Copy link to post" not found in popup');
      console.log('\n🔎 All visible text on page (looking for copy-related text):');
      const pageText = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('span, button, li, a'))
          .filter(el => {
            const t = (el.textContent || '').trim();
            return t.length > 2 && t.length < 60 && (t.toLowerCase().includes('copy') || t.toLowerCase().includes('link'));
          })
          .map(el => `<${el.tagName}> "${el.textContent?.trim()}"`)
          .slice(0, 20);
      });
      pageText.forEach(t => console.log(`   ${t}`));
    }
  }

  console.log('\n⏸️  Browser stays open for 30s for manual inspection...');
  await sleep(30000);
  await context.close();
}

main().catch(console.error);
