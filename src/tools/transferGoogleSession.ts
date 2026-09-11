/**
 * transferGoogleSession.ts — copy Google-domain cookies from an existing,
 * already-authenticated automation profile (Google Sites) into a fresh
 * target platform's session profile, so that platform's "Continue with
 * Google" arrives pre-authenticated instead of triggering a brand-new OAuth
 * flow from an anonymous automated browser (which is what got a prior
 * platform's whole domain blocked).
 *
 * Usage:
 *   npx tsx src/tools/transferGoogleSession.ts <nickname> <targetPlatform>
 *   e.g. npx tsx src/tools/transferGoogleSession.ts pranav pdfhost
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { killChromeForProfile } from '../utils/killChrome.js';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function main() {
  const [nickname, targetPlatform] = process.argv.slice(2);
  if (!nickname || !targetPlatform) {
    console.error('Usage: npx tsx src/tools/transferGoogleSession.ts <nickname> <targetPlatform>');
    process.exit(1);
  }

  const sourceDir = path.resolve(`.sessions/googlesite/${nickname}`);
  const targetDir = path.resolve(`.sessions/${targetPlatform}/${nickname}`);

  if (!fs.existsSync(sourceDir)) {
    console.error(`No Google Sites session found for "${nickname}" at ${sourceDir}`);
    process.exit(1);
  }
  fs.mkdirSync(targetDir, { recursive: true });

  console.log(`   Reading Google cookies from googlesite/${nickname}...`);
  await killChromeForProfile(sourceDir);
  const sourceContext = await chromium.launchPersistentContext(sourceDir, {
    headless: true,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    channel: fs.existsSync(CHROME_PATH) ? undefined : 'chrome',
    viewport: null,
  });
  const allCookies = await sourceContext.cookies();
  const googleCookies = allCookies.filter(c => c.domain.includes('google.com'));
  console.log(`   Found ${googleCookies.length} Google-domain cookies (of ${allCookies.length} total).`);
  await sourceContext.close();

  if (googleCookies.length === 0) {
    console.error('   No Google cookies found — is this Google Sites session actually logged in?');
    process.exit(1);
  }

  console.log(`   Seeding them into ${targetPlatform}/${nickname}...`);
  await killChromeForProfile(targetDir);
  const targetContext = await chromium.launchPersistentContext(targetDir, {
    headless: true,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    channel: fs.existsSync(CHROME_PATH) ? undefined : 'chrome',
    viewport: null,
  });
  await targetContext.addCookies(googleCookies);
  console.log(`   ✅ Seeded ${googleCookies.length} Google cookies into ${targetDir}`);
  await targetContext.close();
}

main().catch(err => { console.error(err); process.exit(1); });
