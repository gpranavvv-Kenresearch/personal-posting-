/**
 * instagramBatchAgentNew.ts — Instagram Batch Agent
 *
 * Pipeline per row (reads from "instagram" tab of BLOG_SHEET_ID):
 *   1. Read row: Image URL + Description
 *   2. Download image from URL to temp file
 *   3. Login to Instagram via Playwright (persistent Chrome profile)
 *   4. Post image + caption
 *   5. Save result back to instagram sheet
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import type { InstagramRow } from '../sheets/sheets.js';
import { loginToInstagram, closeInstagramBrowser, getInstagramAccountByNickname, getInstagramAccounts } from '../browser/instagram/login.js';
import { postToInstagram } from '../browser/instagram/poster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMP_DIR = 'C:\\temp';

// ── Account rotation ──────────────────────────────────────────────────────────

let _igAccountIndex = 0;

function pickInstagramAccount(): string {
  const accounts = getInstagramAccounts().filter((a: any) => a.active);
  if (accounts.length === 0) throw new Error('No active Instagram accounts in accounts-instagram.json');
  const acc = accounts[_igAccountIndex % accounts.length];
  _igAccountIndex++;
  return acc.nickname;
}

// ── Image downloader ──────────────────────────────────────────────────────────

function downloadImage(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        downloadImage(response.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        reject(new Error(`Image download failed: HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
    }).on('error', (err) => {
      fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// ── Batch result ──────────────────────────────────────────────────────────────

export interface InstagramBatchResult {
  processed: number;
  posted:    number;
  failed:    number;
  results: Array<{
    imageUrl: string;
    success:  boolean;
    error?:   string;
  }>;
}

// ── Main batch function ───────────────────────────────────────────────────────

export async function runInstagramBatchAgent(params: {
  rows: InstagramRow[];
  batchLabel?: string;
}): Promise<InstagramBatchResult> {
  const result: InstagramBatchResult = { processed: 0, posted: 0, failed: 0, results: [] };
  const batchLabel = params.batchLabel ?? 'Batch 1';

  for (const row of params.rows) {
    result.processed++;
    console.log(`\n   📸 Processing Instagram row ${row.rowIndex}: ${row.imageUrl.slice(0, 60)}...`);

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const ext       = row.imageUrl.split('.').pop()?.split('?')[0] ?? 'jpg';
    const tempPath  = `${TEMP_DIR}\\ig_${timestamp}.${ext}`;
    const nickname  = pickInstagramAccount();

    try {
      // ── Step 1: Download image ────────────────────────────────────────────
      console.log(`   ⬇️  Downloading image...`);
      await downloadImage(row.imageUrl, tempPath);
      console.log(`   ✅ Image saved: ${tempPath}`);

      // ── Step 2: Login to Instagram ────────────────────────────────────────
      const account = getInstagramAccountByNickname(nickname);
      if (!account) throw new Error(`Instagram account not found: ${nickname}`);

      console.log(`   👤 Instagram account: ${account.username}`);
      const page = await loginToInstagram(account);

      // ── Step 3: Post ──────────────────────────────────────────────────────
      const postResult = await postToInstagram(page, {
        filePath:    tempPath,
        description: row.description,
      });

      // ── Step 4: Close browser ─────────────────────────────────────────────
      await Promise.race([
        page.goto('about:blank'),
        new Promise(r => setTimeout(r, 2000)),
      ]).catch(() => {});
      await closeInstagramBrowser();

      // ── Step 5: Save result to sheet ──────────────────────────────────────
      const { saveInstagramResult } = await import('../sheets/sheets.js');
      await saveInstagramResult(row, {
        instagramStatus: postResult.success ? 'Posted' : 'Error',
        instagramBatch:  batchLabel,
        instagramError:  postResult.error ?? '',
      });

      if (postResult.success) {
        result.posted++;
        result.results.push({ imageUrl: row.imageUrl, success: true });
        console.log(`   ✅ Posted successfully`);
      } else {
        throw new Error(postResult.error ?? 'Post flow failed');
      }

    } catch (err: any) {
      console.error(`   ❌ Failed row ${row.rowIndex}: ${err.message}`);
      await closeInstagramBrowser().catch(() => {});

      try {
        const { saveInstagramResult } = await import('../sheets/sheets.js');
        await saveInstagramResult(row, {
          instagramStatus: 'Error',
          instagramBatch:  batchLabel,
          instagramError:  err.message,
        });
      } catch (sheetErr: any) {
        console.warn(`   ⚠️  Could not update sheet: ${sheetErr.message}`);
      }

      result.failed++;
      result.results.push({ imageUrl: row.imageUrl, success: false, error: err.message });
    } finally {
      // Clean up temp image
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }

  return result;
}
