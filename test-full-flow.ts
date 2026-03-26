/**
 * test-full-flow.ts
 * Full pipeline: SEO check → content generation → X post
 * No Anthropic API required.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { runSeoAnalysis } from './src/agents/seoAgent.js';
import { generateTweetFromSheetRow } from './src/agents/contentGenerator.js';
import { runXAgent } from './src/agents/xAgentNew.js';
import { getPendingRows, saveUnifiedSeoData, savePostingResult } from './src/sheets/sheets.js';

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  FULL FLOW: SEO → Content → Post');
  console.log('='.repeat(60));

  // ── Read first pending row from sheet ──────────────────────────────────
  console.log('Reading first pending row from sheet (insta tab)...');
  const rows = await getPendingRows();

  if (rows.length === 0) {
    console.log('❌ No pending rows found in sheet');
    process.exit(1);
  }

  const sheetRow   = rows[0];
  const REPORT_URL = sheetRow.targetUrl;
  const TITLE      = sheetRow.title;
  const ACCOUNT    = sheetRow.name;

  console.log(`  Row     : ${sheetRow.rowIndex}`);
  console.log(`  URL     : ${REPORT_URL}`);
  console.log(`  Title   : ${TITLE}`);
  console.log(`  Account : @${ACCOUNT}`);
  console.log('='.repeat(60));
  console.log('');

  // ── Step 1: SEO Analysis ─────────────────────────────────────────────────
  console.log('STEP 1 — SEO Analysis');
  console.log('-'.repeat(40));

  const seo = await runSeoAnalysis(REPORT_URL, TITLE);

  console.log(`  Index status : ${seo.indexStatus}`);
  console.log(`  Rank page    : ${seo.rankPage}`);
  console.log(`  Rank position: ${seo.rankPosition}`);
  console.log(`  Platforms    : ${seo.platforms.join(', ')}`);
  console.log(`  Keywords     : ${seo.keywords.slice(0, 3).join(', ')}`);
  console.log('');

  // Write SEO results to sheet
  await saveUnifiedSeoData(sheetRow, {
    indexStatus: seo.indexStatus,
    rankPage: seo.rankPage,
    rankPosition: seo.rankPosition,
    keywords: seo.keywords,
    platforms: seo.platforms,
  });
  console.log('  ✅ SEO data written to sheet');

  // Only post to X if in platforms list
  if (!seo.platforms.includes('x')) {
    console.log('⚠️  X not in platforms for this URL — skipping post');
    return;
  }

  // ── Step 2: Generate Tweet ────────────────────────────────────────────────
  console.log('STEP 2 — Generate Tweet');
  console.log('-'.repeat(40));

  const tweet = await generateTweetFromSheetRow({
    targetUrl: REPORT_URL,
    title: TITLE,
  });

  console.log('');
  console.log('  Generated tweet:');
  console.log(`  "${tweet}"`);
  console.log(`  Length: ${tweet.length} chars`);
  console.log('');

  if (!tweet || tweet.trim().length === 0) {
    console.error('❌ Tweet generation failed — empty result');
    process.exit(1);
  }

  // ── Step 3: Post to X ────────────────────────────────────────────────────
  console.log('STEP 3 — Post to X');
  console.log('-'.repeat(40));

  const result = await runXAgent({
    tweetText: tweet,
    accountHandle: ACCOUNT,
  });

  console.log('');
  console.log('='.repeat(60));

  // Write posting result to sheet
  await savePostingResult(sheetRow, {
    xPost: tweet,
    xPostUrl: result.tweetUrl ?? '',
    xStatus: result.success ? 'posted' : 'failed',
    xError: result.error,
    messageStatus: result.success ? 'posted' : `failed: ${result.error}`,
  });

  if (result.success) {
    console.log('✅ SUCCESS — Tweet posted!');
    console.log(`   URL: ${result.tweetUrl}`);
    console.log('   ✅ Sheet updated');
  } else {
    console.log('❌ FAILED');
    console.log(`   Error: ${result.error}`);
    console.log('   ✅ Error written to sheet');
  }

  console.log('='.repeat(60));
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
