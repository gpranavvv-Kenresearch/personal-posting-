/**
 * pulsePasteOnly.ts
 * Paste table content into already-open LinkedIn Pulse article
 */

import { chromium } from 'playwright';
import path from 'path';

const SESSION_DIR = path.resolve('.sessions/chrome-linkedin-shrey');

const TABLE_HTML = `<table style="width:100%;border-collapse:collapse;margin:20px 0;">
  <thead>
    <tr style="background:#f0f4f8;border-bottom:2px solid #2563eb;">
      <th style="padding:12px;text-align:left;font-weight:700;color:#1e40af;">Metric</th>
      <th style="padding:12px;text-align:right;font-weight:700;color:#1e40af;">Value</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Market Size 2026</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">EUR 66B</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Forecast 2030</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">EUR 72-75B</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Growth Rate CAGR</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">2-3%</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">5G Coverage</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">75-80%</td>
    </tr>
    <tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:10px 12px;">Fiber Access</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">50-55%</td>
    </tr>
    <tr>
      <td style="padding:10px 12px;">Enterprise IoT Growth</td>
      <td style="padding:10px 12px;text-align:right;font-weight:600;">8-12%</td>
    </tr>
  </tbody>
</table>`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  // Connect to existing context
  const browserContext = await chromium.connectOverCDP(`http://127.0.0.1:9222`).catch(async () => {
    // If CDP fails, launch persistent context
    return await chromium.launchPersistentContext(SESSION_DIR, {
      headless: false,
      channel: 'chrome',
    });
  });

  const pages = await browserContext.pages();
  const page = pages[pages.length - 1] || (await browserContext.newPage());

  console.log('Rendering table in temp page and copying...');
  const tempPage = await browserContext.newPage();
  try {
    await tempPage.setContent(TABLE_HTML, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await sleep(2000);
    await tempPage.keyboard.press('Control+A');
    await sleep(200);
    await tempPage.keyboard.press('Control+C');
    await sleep(500);
    console.log('Table copied to clipboard.');
  } finally {
    await tempPage.close();
  }

  console.log('Clicking into article body and pasting table...');
  await page.click('p.article-editor-paragraph[aria-label*="Write here"]').catch(() => {});
  await sleep(400);
  await page.keyboard.press('Control+V');
  await sleep(3000);
  console.log('✅ Table pasted into article. Browser open for review.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
