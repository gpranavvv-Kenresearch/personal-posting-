/**
 * blogGenLoop.ts — autorun: picks "New Logic" rows that have a Target URL
 * but no Blog Content yet, generates the article and cover image
 * CONCURRENTLY in two separate Chrome windows (blogGenAgent.ts /
 * blogImageAgent.ts each launch their own persistent context — see those
 * files), writes the result back, then re-reads that same cell from the
 * sheet to verify it actually landed with real content (and the image URL,
 * if requested) before moving on to the next row. One bad write can't
 * silently pass as "generated."
 *
 * Deliberately NOT wired into scheduler-new.ts's node-cron jobs: each row
 * takes ~12-15 min (blog) / up to ~9 min (image) of real ChatGPT generation
 * time through visible, logged-in Chrome windows — running that inside the
 * same process as the tightly-timed 10:30-18:00 posting cron would block or
 * collide with posting batches. Run this as its own long-lived process.
 */

import { generateBlogViaChatGpt } from '../agents/blogGenAgent.js';
import { generateBlogCoverImage } from '../agents/blogImageAgent.js';
import { runBlogSanityChecks } from '../agents/blogSanityAgent.js';
import { getContentPoolRowsNeedingGeneration, saveGeneratedBlogToPool, getSheetRowByIndex } from '../sheets/sheets.js';

/** Force the cover image into the article HTML — replaces a model-written <img> if any, else prepends one. */
function injectCoverImage(html: string, imageUrl: string, altText: string): string {
  if (!imageUrl) return html;
  const alt = altText.replace(/"/g, '&quot;');
  const imgTag = `<img src="${imageUrl}" alt="${alt} market research"/>`;
  return /<img\b[^>]*>/i.test(html) ? html.replace(/<img\b[^>]*>/i, imgTag) : `${imgTag}\n${html}`;
}

const MIN_WORDS = 400; // real articles are 1,450-1,600 words — this is a "did anything land at all" floor, not a quality bar

/** Re-read the row from the sheet and confirm the write actually took (content present). A missing cover
 * image is NOT a failure — the text is still good and stays in the sheet; we just note it. */
async function verifyWrite(rowIndex: number, expectImage: boolean): Promise<{ ok: boolean; reason?: string }> {
  const fresh = await getSheetRowByIndex(rowIndex, 'newLogic');
  if (!fresh) return { ok: false, reason: 'row disappeared on re-read' };

  const html = fresh.blogContent || '';
  const wordCount = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS) return { ok: false, reason: `Blog Content only ~${wordCount} words after write` };

  if (expectImage && !/<img\b[^>]*src=["']https?:\/\//i.test(html)) {
    return { ok: true, reason: 'no cover image, but text content is fine — accepting' };
  }

  return { ok: true };
}

export interface BlogGenBatchOptions {
  limit?: number;
  withImage?: boolean;
  imagePromptChoice?: '1' | '2';
  blogAccountHandle?: string;
  imageAccountHandle?: string;
  /** Retry once if the post-write verification fails (default true). */
  retryOnVerifyFail?: boolean;
}

/** One pass: generate up to `limit` pending Content Pool rows, verifying each write before moving on. */
export async function runBlogGenBatch(opts: BlogGenBatchOptions = {}): Promise<{ attempted: number; generated: number; failed: number }> {
  const limit = opts.limit ?? 3;
  const retryOnVerifyFail = opts.retryOnVerifyFail ?? true;
  const rows = await getContentPoolRowsNeedingGeneration(limit, 'newLogic');

  if (rows.length === 0) {
    console.log('[BLOG GEN] No New Logic rows need generation (Target URL set + Blog Content empty).');
    return { attempted: 0, generated: 0, failed: 0 };
  }

  console.log(`[BLOG GEN] ${rows.length} row(s) need generation.`);
  let generated = 0;
  let failed = 0;

  for (const row of rows) {
    const title = row.title || row.targetUrl;
    console.log(`\n[BLOG GEN] Row ${row.rowIndex}: "${title}"`);

    let attemptsLeft = retryOnVerifyFail ? 2 : 1;
    let rowOk = false;

    while (attemptsLeft > 0 && !rowOk) {
      attemptsLeft--;
      try {
        let coverImageUrl = '';
        let blog: { title: string; description: string; html: string };

        if (opts.withImage) {
          // Blog (Chrome window #1) and cover image (Chrome window #2) run
          // concurrently — two separate, independent browser contexts.
          console.log(`   Opening 2 parallel Chrome windows (blog + image)...`);
          const [imgResult, blogResult] = await Promise.all([
            generateBlogCoverImage({
              marketName: title,
              reportUrl: row.targetUrl,
              promptChoice: opts.imagePromptChoice ?? '1',
              accountHandle: opts.imageAccountHandle,
            }).catch((imgErr: any) => {
              console.log(`   ⚠️ Cover image failed — continuing without one: ${imgErr.message}`);
              return '';
            }),
            generateBlogViaChatGpt({ title, url: row.targetUrl, accountHandle: opts.blogAccountHandle }),
          ]);
          coverImageUrl = imgResult;
          blog = blogResult;
        } else {
          blog = await generateBlogViaChatGpt({ title, url: row.targetUrl, accountHandle: opts.blogAccountHandle });
        }

        const htmlWithImage = coverImageUrl ? injectCoverImage(blog.html, coverImageUrl, title) : blog.html;

        const sanity = runBlogSanityChecks(htmlWithImage, { title });
        if (sanity.changes.length > 0) {
          console.log(`   [BLOG SANITY] Applied: ${sanity.changes.join(', ')}`);
        }

        await saveGeneratedBlogToPool(row, { title: blog.title, description: blog.description, html: sanity.html }, 'newLogic');

        console.log(`   Verifying write for row ${row.rowIndex}...`);
        const verdict = await verifyWrite(row.rowIndex, !!opts.withImage);
        if (verdict.ok) {
          console.log(`   ✅ Row ${row.rowIndex} verified.${verdict.reason ? ` (${verdict.reason})` : ''}`);
          rowOk = true;
          generated++;
        } else {
          console.log(`   ⚠️ Verification failed: ${verdict.reason}${attemptsLeft > 0 ? ' — retrying this row...' : ' — giving up on this row.'}`);
        }
      } catch (err: any) {
        console.log(`   ❌ Row ${row.rowIndex} failed: ${err.message}${attemptsLeft > 0 ? ' — retrying...' : ' — giving up on this row.'}`);
      }
    }

    if (!rowOk) failed++;
  }

  console.log(`\n[BLOG GEN] Pass complete: ${generated} generated, ${failed} failed, out of ${rows.length}.`);
  return { attempted: rows.length, generated, failed };
}

/**
 * Continuous loop — generate a pass, wait `intervalSeconds`, repeat forever.
 * Meant to be run as its own long-lived process (see src/index.ts's
 * "run-blog-gen-loop" mode), not called from inside the cron daemon.
 */
export async function runBlogGenLoop(opts: BlogGenBatchOptions & { intervalSeconds?: number } = {}): Promise<void> {
  const intervalSeconds = opts.intervalSeconds ?? 1800; // 30 min default
  console.log(`[BLOG GEN] Starting continuous loop (checking every ${intervalSeconds}s)...`);
  for (;;) {
    try {
      await runBlogGenBatch(opts);
    } catch (err: any) {
      console.log(`[BLOG GEN] Pass errored: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }
}
