// run_pipeline.js
// Full carousel pipeline for ONE market at a time:
//   1. Get next pending row from sheet (col Y empty)
//   2. Match to brief files in images/briefs/
//   3. Generate 7 slide images via ChatGPT (generate_image.js)
//   4. Organize into slug/ folder as slide_01.png ... slide_07.png
//   5. Combine into PDF (combine_pdf.js)
//   6. Write PDF path + caption to sheet (carousel_sheet.js write)
//
// Usage:
//   node scripts/run_pipeline.js
//       → auto-picks next pending row, matches slug from URL
//
//   node scripts/run_pipeline.js --slug=germany-nutraceuticals --row=394
//       → runs specific market (row number from sheet, 1-indexed)
//
//   node scripts/run_pipeline.js --loop
//       → keeps running until no pending rows remain

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, '..');
const BRIEFS_DIR = path.join(ROOT, 'images', 'briefs');
const IMAGES_DIR = path.join(ROOT, 'images');
const DATE       = '2026-06-27';

// Parse CLI args
const cliArgs = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
const LOOP = !!cliArgs.loop;

// ─────────────────────────────────────────────
// Helper: run shell command, stream output
// ─────────────────────────────────────────────
function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`Command failed (exit ${r.status}): ${cmd}`);
}

// ─────────────────────────────────────────────
// Helper: get next pending row from sheet
// ─────────────────────────────────────────────
function getNextRow() {
  const out = execSync('node scripts/carousel_sheet.js next', { cwd: ROOT, encoding: 'utf8' }).trim();
  return JSON.parse(out);
}

// ─────────────────────────────────────────────
// Helper: find matching brief slug
// Strategy: list all slugs from brief filenames, find best match for URL slug
// ─────────────────────────────────────────────
function findBriefSlug(title, url) {
  if (!fs.existsSync(BRIEFS_DIR)) return null;

  // Extract unique slugs from brief files (pattern: creative_DATE_SLUG_slideNN.txt)
  const briefFiles = fs.readdirSync(BRIEFS_DIR).filter(f => f.endsWith('.txt'));
  const slugSet = new Set();
  for (const f of briefFiles) {
    const m = f.match(/^creative_\d{4}-\d{2}-\d{2}_(.+)_slide\d+\.txt$/);
    if (m) slugSet.add(m[1]);
  }
  const knownSlugs = [...slugSet];

  // Also try to derive candidate from URL last segment
  const urlSlug = (url || '').split('/').pop().toLowerCase().replace(/[^a-z0-9-]/g, '');

  // Try exact match first
  if (knownSlugs.includes(urlSlug)) return urlSlug;

  // Try: URL slug starts with brief slug (strongest prefix signal)
  // e.g. url=europe-ivd-market matches slug=europe-ivd before slug=central-eastern-europe-otc-drugs
  const byPrefix = knownSlugs.filter(s => urlSlug.startsWith(s + '-') || urlSlug === s);
  if (byPrefix.length === 1) return byPrefix[0];
  // Among multiple prefix matches, pick the longest (most specific)
  if (byPrefix.length > 1) {
    byPrefix.sort((a, b) => b.length - a.length);
    return byPrefix[0];
  }

  // Try: known slug is contained within the URL slug (prefix or subset)
  // Only use if unambiguous — exclude slugs that share just a generic word like "europe"
  const byContainment = knownSlugs.filter(s => urlSlug.includes(s) || s.includes(urlSlug));
  if (byContainment.length === 1) return byContainment[0];

  // Try: plural/singular normalization (strip trailing 's' from both sides)
  const stemUrl = urlSlug.replace(/s(-|$)/g, '$1');
  const byStem = knownSlugs.filter(s => {
    const stemS = s.replace(/s(-|$)/g, '$1');
    return stemUrl.includes(stemS) || stemS.includes(stemUrl) ||
           urlSlug.includes(stemS) || stemS.includes(urlSlug);
  });
  if (byStem.length === 1) return byStem[0];

  // Score against both title words AND URL slug words (combined for disambiguation)
  const titleWords = title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/);
  const urlWords   = urlSlug.split('-');
  const scores = knownSlugs.map(s => {
    const slugWords = s.split('-');
    const titleHits = slugWords.filter(w => titleWords.includes(w)).length;
    const urlHits   = slugWords.filter(w => urlWords.some(uw => uw === w || uw.replace(/s$/, '') === w || w.replace(/s$/, '') === uw)).length;
    // Bonus: slug words that are all present in URL (high specificity)
    const allUrlMatch = slugWords.every(w => urlWords.includes(w) || urlWords.some(uw => uw.replace(/s$/, '') === w));
    return { slug: s, score: titleHits * 3 + urlHits * 2 + (allUrlMatch ? 5 : 0) };
  });
  scores.sort((a, b) => b.score - a.score);

  if (scores[0] && scores[0].score > 0) return scores[0].slug;
  return null;
}

// ─────────────────────────────────────────────
// Helper: count brief files for a slug
// ─────────────────────────────────────────────
function getBriefFiles(slug) {
  const files = [];
  for (let i = 1; i <= 7; i++) {
    const num = String(i).padStart(2, '0');
    const file = path.join(BRIEFS_DIR, `creative_${DATE}_${slug}_slide${num}.txt`);
    if (fs.existsSync(file)) files.push({ slide: num, file });
  }
  return files;
}

// ─────────────────────────────────────────────
// Main pipeline for one market
// ─────────────────────────────────────────────
async function runMarket(slug, row) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MARKET: ${slug}  |  ROW: ${row}`);
  console.log('='.repeat(60));

  const briefFiles = getBriefFiles(slug);
  if (!briefFiles.length) {
    throw new Error(`No brief files found for slug "${slug}" in ${BRIEFS_DIR}`);
  }
  console.log(`Found ${briefFiles.length} brief files.`);

  // Step 1: Generate images
  const slideDir = path.join(IMAGES_DIR, slug);
  fs.mkdirSync(slideDir, { recursive: true });

  for (const { slide, file } of briefFiles) {
    const slideSlug = `${slug}_slide${slide}`;
    const imgOut    = path.join(IMAGES_DIR, `image_${DATE}_${slideSlug}.png`);
    const destFile  = path.join(slideDir, `slide_${slide}.png`);

    if (fs.existsSync(destFile)) {
      console.log(`Slide ${slide}: already exists, skipping.`);
    } else {
      console.log(`\nGenerating slide ${slide}/${briefFiles.length} for ${slug}...`);

      // Retry once on failure (transient ChatGPT timeout / rate limit)
      let attempts = 0;
      let slideOk = false;
      while (attempts < 2) {
        try {
          run(`node scripts/generate_image.js --prompt-file="${file}" --slug="${slideSlug}"`);
          slideOk = true;
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 2) {
            console.warn(`  WARNING: Slide ${slide} failed after 2 attempts — skipping and continuing.`);
            break;
          }
          console.log(`  Slide ${slide} failed (attempt ${attempts}), retrying in 30s...`);
          await new Promise(r => setTimeout(r, 30000));
        }
      }

      if (slideOk) {
        if (!fs.existsSync(imgOut)) {
          console.warn(`  WARNING: generate_image.js did not produce ${imgOut} — skipping slide.`);
        } else {
          fs.copyFileSync(imgOut, destFile);
          console.log(`Saved → ${destFile}`);
        }
      }
    }
  }

  // Step 2: Combine into PDF
  const pdfPath = path.join(IMAGES_DIR, `${slug}.pdf`);
  console.log(`\nCombining ${briefFiles.length} slides into PDF...`);
  run(`node scripts/renderer/combine_pdf.js --folder="${slideDir}" --output="${pdfPath}"`);
  console.log(`PDF ready: ${pdfPath}`);

  // Step 3: Write to sheet
  const captionFile = `C:/tmp/caption_${slug}.txt`;
  if (!fs.existsSync(captionFile)) {
    throw new Error(`Caption file not found: ${captionFile}`);
  }
  console.log(`\nWriting to sheet (row ${row})...`);
  run(`node scripts/carousel_sheet.js write --row=${row} --path="${pdfPath}" --caption-file="${captionFile}"`);

  console.log(`\nDone: ${slug} (row ${row})`);
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────
async function main() {
  let slug = cliArgs.slug ?? null;
  let row  = cliArgs.row  ? parseInt(cliArgs.row, 10) : null;

  do {
    if (!slug || !row) {
      // Auto-detect next pending market
      const next = getNextRow();
      if (!next.row) {
        console.log('\nAll rows processed. Queue empty.');
        break;
      }
      row  = next.row;
      slug = findBriefSlug(next.title, next.targetUrl);
      if (!slug) {
        console.error(`Could not match slug for row ${row}: "${next.title}" (${next.targetUrl})`);
        console.error('Generate brief files for this market first, then re-run.');
        process.exit(1);
      }
      console.log(`\nPicked row ${row}: "${next.title}" → slug: ${slug}`);
    }

    await runMarket(slug, row);

    // Reset for next iteration (loop mode)
    slug = null;
    row  = null;

  } while (LOOP);
}

main().catch(err => {
  console.error(`\nPipeline error: ${err.message}`);
  process.exit(1);
});
