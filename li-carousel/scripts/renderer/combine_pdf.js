// Combine a folder of slide_NN.png files into a single LinkedIn-uploadable PDF.
// Usage: node scripts/renderer/combine_pdf.js --folder=images/enhanced_carousel_X --output=images/carousel_X.pdf

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const folder = args.folder;
const outPath = args.output;
const w = parseInt(args.width ?? '1080', 10);
const h = parseInt(args.height ?? '1350', 10);

if (!folder || !fs.existsSync(folder)) {
  console.error(`Missing or non-existent --folder: ${folder}`);
  process.exit(1);
}
if (!outPath) {
  console.error('Missing --output');
  process.exit(1);
}

const slides = fs.readdirSync(folder)
  .filter(f => /^slide_\d+\.png$/i.test(f))
  .sort();

if (!slides.length) {
  console.error('No slide_NN.png files found.');
  process.exit(1);
}

console.log(`Combining ${slides.length} slides into PDF...`);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: w, height: h },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();

const imgTags = slides.map((f) => {
  const buf = fs.readFileSync(path.join(folder, f));
  const b64 = buf.toString('base64');
  return `<div class="slide"><img src="data:image/png;base64,${b64}" /></div>`;
}).join('');

const html = `<!DOCTYPE html><html><head><style>
  @page { size: ${w}px ${h}px; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #0A0A0A; }
  .slide { width: ${w}px; height: ${h}px; page-break-after: always; overflow: hidden;
           display: flex; align-items: center; justify-content: center; background: #0A0A0A; }
  .slide:last-child { page-break-after: auto; }
  .slide img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
</style></head><body>${imgTags}</body></html>`;

await page.setContent(html, { waitUntil: 'load' });
await page.pdf({
  path: outPath,
  width: `${w}px`,
  height: `${h}px`,
  printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
});

await ctx.close();
await browser.close();
console.log(`PDF saved: ${outPath}`);
