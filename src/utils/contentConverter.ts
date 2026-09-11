/**
 * contentConverter.ts — Convert HTML blog content to PDF
 * Uses Playwright for PDF generation.
 */

import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { injectUTM, UTM_PARAMS } from './utm.js';

const PDF_DIR = path.resolve('.generated/pdf');

function ensureDirs() {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

export function makeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ──── HTML → PDF ────────────────────────────────────────────────────────────

function buildPdfHtml(htmlContent: string): string {
  const $ = cheerio.load(htmlContent);

  // Extract title
  const title = $('h1').first().text().trim() || $('title').first().text().trim() || 'Ken Research Report';

  // Extract all headings for TOC
  const tocItems: { level: number; text: string }[] = [];
  $('h1, h2, h3').each((_i, el) => {
    const tag = (el as any).tagName?.toLowerCase() ?? 'h2';
    const level = tag === 'h1' ? 1 : tag === 'h2' ? 2 : 3;
    const text = $(el).text().trim();
    if (text) tocItems.push({ level, text });
  });

  // Remove h1 from TOC (it's the title — already on cover)
  const tocList = tocItems.filter(t => t.level >= 2);

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const tocRows = tocList.map((t, i) =>
    `<div class="toc-item toc-level-${t.level}">
      <span class="toc-num">${i + 1}.</span>
      <span class="toc-text">${t.text}</span>
    </div>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
  /* ── Page setup ── */
  @page {
    size: A4;
    margin: 0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Inter', sans-serif;
    font-size: 11pt;
    color: #222;
    background: #fff;
  }

  /* ── Cover Page ── */
  .cover-page {
    width: 210mm;
    min-height: calc(297mm - 36mm);
    background: #1A1A2E;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 20mm 18mm;
    page-break-after: always;
    break-after: always;
    position: relative;
    overflow: hidden;
  }
  .cover-accent {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 6mm;
    background: #CC2936;
  }
  .cover-accent-bottom {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: 3mm;
    background: #CC2936;
  }
  .cover-logo {
    font-family: 'Montserrat', sans-serif;
    font-size: 13pt;
    font-weight: 800;
    letter-spacing: 3px;
    color: #CC2936;
    margin-bottom: 18mm;
  }
  .cover-title {
    font-family: 'Montserrat', sans-serif;
    font-size: 24pt;
    font-weight: 700;
    color: #ffffff;
    line-height: 1.35;
    margin-bottom: 8mm;
  }
  .cover-subtitle {
    font-family: 'Inter', sans-serif;
    font-size: 12pt;
    font-weight: 500;
    color: #aaaacc;
    margin-bottom: 20mm;
  }
  .cover-date {
    font-family: 'Inter', sans-serif;
    font-size: 10pt;
    color: #888899;
  }
  .cover-url {
    font-family: 'Inter', sans-serif;
    font-size: 9pt;
    color: #CC2936;
    margin-top: 4mm;
  }

  /* ── TOC Page ── */
  .toc-page {
    width: 210mm;
    height: calc(297mm - 36mm);
    padding: 10mm 18mm 10mm 18mm;
    page-break-after: always;
    break-after: always;
    background: #fff;
    display: flex;
    flex-direction: column;
  }
  .toc-header {
    font-family: 'Montserrat', sans-serif;
    font-size: 20pt;
    font-weight: 700;
    color: #1A1A2E;
    padding-bottom: 4mm;
    border-bottom: 2px solid #CC2936;
    margin-bottom: 6mm;
    flex-shrink: 0;
  }
  .toc-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 0;
  }
  .toc-item {
    display: flex;
    align-items: baseline;
    gap: 3mm;
    padding: 3mm 2mm;
    border-bottom: 1px solid #f0f0f0;
  }
  .toc-item:last-child { border-bottom: none; }
  .toc-level-2 { padding-left: 0; }
  .toc-level-3 {
    padding-left: 8mm;
    font-size: 10pt;
    color: #555;
  }
  .toc-num {
    font-family: 'Montserrat', sans-serif;
    font-size: 10pt;
    font-weight: 700;
    color: #CC2936;
    min-width: 8mm;
    flex-shrink: 0;
  }
  .toc-text {
    font-family: 'Inter', sans-serif;
    font-size: 11pt;
    color: #222;
    line-height: 1.5;
    flex: 1;
  }

  /* ── Content Page ── */
  .content-page {
    width: 210mm;
    padding: 18mm 18mm 20mm 18mm;
    background: #fff;
  }

  /* ── Typography ── */
  h1 {
    font-family: 'Montserrat', sans-serif;
    font-size: 22pt;
    font-weight: 700;
    color: #1A1A2E;
    line-height: 1.3;
    margin-bottom: 6mm;
    padding-bottom: 3mm;
    border-bottom: 2px solid #CC2936;
    page-break-after: avoid;
  }
  h2 {
    font-family: 'Montserrat', sans-serif;
    font-size: 16pt;
    font-weight: 700;
    color: #1A1A2E;
    margin-top: 2mm;
    margin-bottom: 3mm;
    padding-left: 3mm;
    border-left: 4px solid #CC2936;
    page-break-after: avoid;
    break-after: avoid;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  h2 + p, h2 + ul, h2 + ol, h2 + table, h2 + blockquote {
    page-break-before: avoid;
    break-before: avoid;
  }
  h3 {
    font-family: 'Montserrat', sans-serif;
    font-size: 13pt;
    font-weight: 600;
    color: #333;
    margin-top: 5mm;
    margin-bottom: 2mm;
    page-break-after: avoid;
    break-after: avoid;
  }
  h3 + p, h3 + ul, h3 + ol {
    page-break-before: avoid;
    break-before: avoid;
  }
  p {
    font-family: 'Inter', sans-serif;
    font-size: 11pt;
    line-height: 1.75;
    color: #333;
    margin-bottom: 4mm;
  }
  ul, ol {
    padding-left: 6mm;
    margin-bottom: 4mm;
  }
  li {
    font-family: 'Inter', sans-serif;
    font-size: 11pt;
    line-height: 1.7;
    color: #333;
    margin-bottom: 1.5mm;
  }
  ul li::marker { color: #CC2936; }
  ol li::marker { color: #CC2936; font-weight: 600; }
  a { color: #CC2936; text-decoration: none; }
  strong, b { font-weight: 600; color: #1A1A2E; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 5mm;
    font-size: 10pt;
  }
  th {
    background: #1A1A2E;
    color: #fff;
    font-family: 'Montserrat', sans-serif;
    font-weight: 600;
    padding: 2.5mm 3mm;
    text-align: left;
  }
  td {
    padding: 2mm 3mm;
    border-bottom: 1px solid #e8e8e8;
    color: #333;
  }
  tr:nth-child(even) td { background: #f9f9f9; }
  blockquote {
    border-left: 4px solid #CC2936;
    padding: 3mm 5mm;
    margin: 4mm 0;
    background: #fafafa;
    font-style: italic;
    color: #555;
  }
  img {
    max-width: 100%;
    width: 100%;
    height: auto;
    display: block;
    margin: 4mm 0;
    border-radius: 2mm;
  }
  figure {
    margin: 4mm 0;
    display: block;
    width: 100%;
  }
  figure img { margin: 0 auto; }
  figcaption {
    font-size: 9pt;
    color: #888;
    text-align: center;
    margin-top: 2mm;
    font-style: italic;
  }

  /* ── Footer on content pages ── */
  .content-page::after {
    content: 'kenresearch.com';
    display: block;
    text-align: center;
    font-family: 'Inter', sans-serif;
    font-size: 8pt;
    color: #aaa;
    margin-top: 10mm;
    padding-top: 3mm;
    border-top: 1px solid #eee;
  }
</style>
</head>
<body>

<!-- Cover Page -->
<div class="cover-page">
  <div class="cover-accent"></div>
  <div class="cover-accent-bottom"></div>
  <div class="cover-logo">KEN RESEARCH</div>
  <div class="cover-title">${title}</div>
  <div class="cover-subtitle">Market Research Report</div>
  <div class="cover-date">${today}</div>
  <div class="cover-url"><a href="https://www.kenresearch.com${UTM_PARAMS.PDF}" style="color:#CC2936;text-decoration:none;">www.kenresearch.com</a></div>
</div>

<!-- Table of Contents -->
<div class="toc-page">
  <div class="toc-header">Table of Contents</div>
  <div class="toc-body">
    ${tocRows || '<p style="color:#888;font-size:10pt;">No sections found.</p>'}
  </div>
</div>

<!-- Blog Content -->
<div class="content-page">
  ${htmlContent}
</div>

</body>
</html>`;
}

export async function htmlToPdf(htmlContent: string, slug: string, rowIndex: number): Promise<string> {
  ensureDirs();

  const fileName = `${slug}-${rowIndex}.pdf`;
  const filePath = path.join(PDF_DIR, fileName);

  const wrappedHtml = buildPdfHtml(injectUTM(htmlContent, UTM_PARAMS.PDF));

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(wrappedHtml, { waitUntil: 'networkidle' });

    // Wrap each h2/h3 + its immediately following sibling in a break-inside:avoid
    // container so the heading never orphans at the bottom of a page.
    await page.evaluate(() => {
      document.querySelectorAll('h2, h3').forEach(heading => {
        const next = heading.nextElementSibling;
        if (!next) return;
        const wrapper = document.createElement('div');
        wrapper.style.cssText = [
          'break-inside:avoid',
          'page-break-inside:avoid',
          'display:block',
          'padding-top:10mm',    // breathing room when this block lands at top of a new page
          'margin-top:0',
        ].join(';');
        heading.parentNode!.insertBefore(wrapper, heading);
        wrapper.appendChild(heading);
        wrapper.appendChild(next);
      });
    });

    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '0', right: '0' },
    });
  } finally {
    await browser.close();
  }

  return path.resolve(filePath);
}

