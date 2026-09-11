import 'dotenv/config';
import {
  getRowsForContinuousFbPosting,
  getRowsForContinuousLiPosting,
  saveUnifiedFbResult,
  saveUnifiedLinkedInResult,
} from './src/sheets/sheets.js';
import { __debugGenerateWithV2Prompt } from './src/agents/contentAgentNew.js';

async function main() {
  const fbRows = await getRowsForContinuousFbPosting(1);
  const fbRow = fbRows[0];
  if (fbRow && !(fbRow.fbPost || '').trim()) {
    console.log(`[FB] Row ${fbRow.rowIndex}: ${fbRow.title}`);
    const post = await __debugGenerateWithV2Prompt(1, 'fb', { url: fbRow.targetUrl, title: fbRow.title });
    console.log(post);
    await saveUnifiedFbResult(fbRow, { post, postUrl: '', status: 'Generated', error: '' });
    console.log('[FB] Saved.\n');
  } else if (fbRow) {
    console.log(`[FB] Row ${fbRow.rowIndex} already has content — skipping.\n`);
  } else {
    console.log('[FB] No pending row.\n');
  }

  const liRows = await getRowsForContinuousLiPosting(1);
  const liRow = liRows[0];
  if (liRow && !(liRow.linkedinPost || '').trim()) {
    console.log(`[LI] Row ${liRow.rowIndex}: ${liRow.title}`);
    const post = await __debugGenerateWithV2Prompt(1, 'li', { url: liRow.targetUrl, title: liRow.title });
    console.log(post);
    await saveUnifiedLinkedInResult(liRow, { post, postUrl: '', status: 'Generated', error: '' });
    console.log('[LI] Saved.\n');
  } else if (liRow) {
    console.log(`[LI] Row ${liRow.rowIndex} already has content — skipping.\n`);
  } else {
    console.log('[LI] No pending row.\n');
  }
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});
