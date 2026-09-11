/**
 * index.ts — Entry Point
 *
 * NEW ARCHITECTURE: Cron-Driven Platform-Specific Batch Scheduling
 *
 * Modes:
 *   npm run dev                             → start cron scheduler daemon
 *   npm run dev -- run-x-batch              → run X batch once now
 *   npm run dev -- run-fb-batch             → run FB batch once now
 *   npm run dev -- run-tumblr-batch         → run Tumblr batch once now
 *   npm run dev -- run-li-batch             → run LI batch once now
 *   npm run dev -- run-group-batch <Group4|Group4b>
 *                                            → claim rows from Content Pool + run Medium/Google Site once now
 *   npm run dev -- run-blog-gen [count] [--no-image]
 *                                            → generate up to [count] Content Pool rows that have a Target URL but
 *                                              no Blog Content yet — blog + cover image by default (two parallel
 *                                              Chrome windows), pass --no-image to skip the image step, then exit
 *   npm run dev -- run-blog-gen-loop [count] [--no-image] [--interval SECONDS]
 *                                            → same, but runs forever (default: every 1800s) — start this as its
 *                                              own long-lived process, separate from the posting cron daemon
 *   npm run dev -- run-medium-batch         → run Medium batch once now
 *   npm run dev -- run-linkmate-batch       → run Linkmate batch once now
 *   npm run dev -- run-devto-batch          → run Dev.to batch once now
 *   npm run dev -- run-googlesite-batch     → run Google Sites batch once now
 *   npm run dev -- run-linkedin-pulse-batch → run LinkedIn Pulse batch once now
 *   npm run dev -- run-calisthenics-batch   → run Calisthenics batch once now
 *   npm run dev -- run-substack-batch       → run Substack batch once now
 *   npm run dev -- run-hackmd-batch         → run HackMD batch once now
 *   npm run dev -- save-medium-session <nickname> → login & save Medium cookies
 *   npm run dev -- save-linkmate-session <nickname> → login & save Linkmate cookies
 *   npm run dev -- save-googlesite-session <nickname> → login & save Google Sites session
 *   npm run dev -- save-calisthenics-session <nickname> → login & save Calisthenics session
 *   npm run dev -- save-substack-session <nickname> → login & save Substack session
 *   npm run dev -- save-hackmd-session <nickname>     → login & save HackMD session
 *   npm run dev -- save-x-session <nickname>          → login & save X session
 *   npm run dev -- save-fb-session <nickname>         → login & save Facebook session
 *   npm run dev -- save-li-session <nickname>         → login & save LinkedIn session
 *   npm run dev -- save-patreon-session <nickname>    → login & save Patreon session
 *   npm run dev -- save-notion-session <nickname>     → login & save Notion session
 *   npm run dev -- save-naver-session <nickname>      → login & save Naver session
 *   npm run dev -- save-velog-session <nickname>      → login & save Velog session
 *   npm run dev -- save-coda-session <nickname>       → login & save Coda session
 *   npm run dev -- save-paragraph-session <nickname> → login & save Paragraph session
 *   npm run dev -- run-paragraph-batch               → run Paragraph batch once now
 *   npm run dev -- run-patreon-batch                  → run Patreon batch once now
 *   npm run dev -- run-notion-batch                   → run Notion batch once now
 *   npm run dev -- run-naver-batch                    → run Naver batch once now
 *   npm run dev -- run-velog-batch                    → run Velog batch once now
 *   npm run dev -- run-coda-batch                     → run Coda batch once now
 *   npm run dev -- tracker                  → daily posting tracker (posted/failed/pending per platform)
 *   npm run dev -- status                   → show current sheet stats
 *   npm run dev -- monitor                  → run one monitor cycle (for Claude CLI /loop)
 */

import 'dotenv/config';
import fs from 'fs';
import { initErrorInterceptor } from './errorInterceptor.js';
import { startCoordinatorDaemon } from './scheduler-new.js';

// Patch console.error/warn to stream to logs/runtime.log for monitor
initErrorInterceptor();

// Catch uncaught crashes that would otherwise kill the process silently
process.on('uncaughtException', (err) => {
  const msg = `[FATAL uncaughtException] ${err.stack || err.message}`;
  console.error(msg);
  try { fs.appendFileSync('logs/runtime.log', JSON.stringify({ level: 'FATAL', ts: new Date().toISOString(), msg }) + '\n'); } catch {}
  // Don't exit — keep the scheduler alive
});
process.on('unhandledRejection', (reason: any) => {
  const msg = `[FATAL unhandledRejection] ${reason?.stack || reason}`;
  console.error(msg);
  try { fs.appendFileSync('logs/runtime.log', JSON.stringify({ level: 'FATAL', ts: new Date().toISOString(), msg }) + '\n'); } catch {}
});

const mode = process.argv[2];

async function main() {
  console.log('🔐 X Posting Agent v2.0 — Cron-Driven Batch Scheduling\n');

  if (mode === 'monitor') {
    const { runMonitorCycle } = await import('./monitor.js');
    const result = await runMonitorCycle();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === 'run-x-batch') {
    console.log('▶ Running X batch now...\n');
    const { runXBatch } = await import('./coordinator/masterCoordinator.js');
    await runXBatch();
    console.log('\n✅ X batch complete');
    return;
  }

  if (mode === 'run-fb-batch') {
    console.log('▶ Running FB batch now...\n');
    const { runFbBatch } = await import('./coordinator/masterCoordinator.js');
    await runFbBatch();
    console.log('\n✅ FB batch complete');
    return;
  }

  if (mode === 'run-tumblr-batch') {
    console.log('▶ Running Tumblr batch now...\n');
    const { runTumblrBatch } = await import('./coordinator/masterCoordinator.js');
    await runTumblrBatch();
    console.log('\n✅ Tumblr batch complete');
    return;
  }

  if (mode === 'run-li-batch') {
    console.log('▶ Running LI batch now...\n');
    const { runLiBatch } = await import('./coordinator/masterCoordinator.js');
    await runLiBatch({ manual: true }, 1);
    console.log('\n✅ LI batch complete');
    return;
  }

  if (mode === 'run-group-batch') {
    const groupName = process.argv[3];
    if (!groupName) {
      console.error('Usage: npm run dev -- run-group-batch <Group1|Group2|Group3|Group4|Group1b|Group2b|Group3b|Group4b>');
      return;
    }
    const { runGroupBatch, GROUP_DEFS } = await import('./coordinator/masterCoordinator.js');
    const def = GROUP_DEFS[groupName];
    if (!def) {
      console.error(`Unknown group "${groupName}". Valid: ${Object.keys(GROUP_DEFS).join(', ')}`);
      return;
    }
    console.log(`▶ Running group batch "${groupName}" now...\n`);
    await runGroupBatch(groupName, def.platforms, def.accountCount, def.batchNum);
    console.log(`\n✅ Group batch "${groupName}" complete`);
    return;
  }

  if (mode === 'run-blog-gen') {
    const limit = Number(process.argv[3]) || 3;
    const withImage = !process.argv.includes('--no-image'); // full generation (blog + image) is the default
    console.log(`▶ Running one blog-gen pass (limit ${limit}, image: ${withImage})...\n`);
    const { runBlogGenBatch } = await import('./coordinator/blogGenLoop.js');
    const result = await runBlogGenBatch({ limit, withImage });
    console.log(`\n✅ Blog-gen pass complete: ${result.generated}/${result.attempted} generated`);
    return;
  }

  if (mode === 'run-blog-gen-loop') {
    const limit = Number(process.argv[3]) || 3;
    const withImage = !process.argv.includes('--no-image'); // full generation (blog + image) is the default
    const intervalArgIdx = process.argv.indexOf('--interval');
    const intervalSeconds = intervalArgIdx !== -1 ? Number(process.argv[intervalArgIdx + 1]) : undefined;
    console.log(`▶ Starting continuous blog-gen loop (limit ${limit}/pass, image: ${withImage}, interval ${intervalSeconds ?? 1800}s)...\n`);
    const { runBlogGenLoop } = await import('./coordinator/blogGenLoop.js');
    await runBlogGenLoop({ limit, withImage, intervalSeconds }); // never returns — Ctrl+C to stop
    return;
  }

  if (mode === 'run-medium-batch') {
    console.log('▶ Running Medium batch now...\n');
    const { runMediumBatch } = await import('./coordinator/masterCoordinator.js');
    await runMediumBatch();
    console.log('\n✅ Medium batch complete');
    return;
  }

  if (mode === 'run-linkmate-batch') {
    console.log('▶ Running Linkmate batch now...\n');
    const { runLinkmateBatch } = await import('./coordinator/masterCoordinator.js');
    await runLinkmateBatch();
    console.log('\n✅ Linkmate batch complete');
    return;
  }

  if (mode === 'run-devto-batch') {
    console.log('▶ Running Dev.to batch now...\n');
    const { runDevtoBatch } = await import('./coordinator/masterCoordinator.js');
    await runDevtoBatch();
    console.log('\n✅ Dev.to batch complete');
    return;
  }

  if (mode === 'run-wordpress-batch') {
    console.log('▶ Running WordPress batch now...\n');
    const { runWordpressBatch } = await import('./coordinator/masterCoordinator.js');
    await runWordpressBatch();
    console.log('\n✅ WordPress batch complete');
    return;
  }

  if (mode === 'run-blogger-batch') {
    console.log('▶ Running Blogger batch now...\n');
    const { runBloggerBatch } = await import('./coordinator/masterCoordinator.js');
    await runBloggerBatch();
    console.log('\n✅ Blogger batch complete');
    return;
  }

  if (mode === 'run-note-batch') {
    console.log('▶ Running Note batch now...\n');
    const { runNoteBatch } = await import('./coordinator/masterCoordinator.js');
    await runNoteBatch(1);
    return;
  }

  if (mode === 'run-googlesite-batch') {
    console.log('▶ Running Google Sites batch now...\n');
    const { runGoogleSiteBatch } = await import('./coordinator/masterCoordinator.js');
    await runGoogleSiteBatch();
    console.log('\n✅ Google Sites batch complete');
    return;
  }

  if (mode === 'run-linkedin-pulse-batch') {
    console.log('▶ Running LinkedIn Pulse batch now...\n');
    const { runLinkedinPulseBatch } = await import('./coordinator/masterCoordinator.js');
    await runLinkedinPulseBatch();
    console.log('\n✅ LinkedIn Pulse batch complete');
    return;
  }

  if (mode === 'run-calisthenics-batch') {
    console.log('▶ Running Calisthenics batch now...\n');
    const { runCalisthenicsNBatch } = await import('./coordinator/masterCoordinator.js');
    await runCalisthenicsNBatch();
    console.log('\n✅ Calisthenics batch complete');
    return;
  }

  if (mode === 'run-substack-batch') {
    console.log('▶ Running Substack batch now...\n');
    const { runSubstackBatch } = await import('./coordinator/masterCoordinator.js');
    await runSubstackBatch();
    console.log('\n✅ Substack batch complete');
    return;
  }

  if (mode === 'run-hackmd-batch') {
    console.log('▶ Running HackMD batch now...\n');
    const { runHackmdBatch } = await import('./coordinator/masterCoordinator.js');
    await runHackmdBatch();
    console.log('\n✅ HackMD batch complete');
    return;
  }

  if (mode === 'run-patreon-batch') {
    console.log('▶ Running Patreon batch now...\n');
    const { runPatreonBatch } = await import('./coordinator/masterCoordinator.js');
    await runPatreonBatch();
    console.log('\n✅ Patreon batch complete');
    return;
  }

  if (mode === 'run-notion-batch') {
    console.log('▶ Running Notion batch now...\n');
    const { runNotionBatch } = await import('./coordinator/masterCoordinator.js');
    await runNotionBatch();
    console.log('\n✅ Notion batch complete');
    return;
  }

  if (mode === 'run-naver-batch') {
    console.log('▶ Running Naver batch now...\n');
    const { runNaverBatch } = await import('./coordinator/masterCoordinator.js');
    await runNaverBatch();
    console.log('\n✅ Naver batch complete');
    return;
  }

  if (mode === 'run-velog-batch') {
    console.log('▶ Running Velog batch now...\n');
    const { runVelogBatch } = await import('./coordinator/masterCoordinator.js');
    await runVelogBatch();
    console.log('\n✅ Velog batch complete');
    return;
  }

  if (mode === 'run-coda-batch') {
    console.log('▶ Running Coda batch now...\n');
    const { runCodaBatch } = await import('./coordinator/masterCoordinator.js');
    await runCodaBatch();
    console.log('\n✅ Coda batch complete');
    return;
  }

  if (mode === 'run-paragraph-batch') {
    console.log('▶ Running Paragraph batch now...\n');
    const { runParagraphBatch } = await import('./coordinator/masterCoordinator.js');
    await runParagraphBatch();
    console.log('\n✅ Paragraph batch complete');
    return;
  }

  if (mode === 'run-ameba-batch') {
    console.log('▶ Running Ameba batch now...\n');
    const { runAmebaBatch } = await import('./coordinator/masterCoordinator.js');
    await runAmebaBatch();
    console.log('\n✅ Ameba batch complete');
    return;
  }

  if (mode === 'save-x-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-x-session <nickname>');
      process.exit(1);
    }
    const { getAccountByHandle } = await import('./config/accounts.js');
    const { loginToX } = await import('./browser/twitter/login.js');
    const account = getAccountByHandle(nickname);
    if (!account) { console.error(`❌ No X account found for: ${nickname}`); process.exit(1); }
    console.log(`\n🌐 Opening browser for X login — @${nickname}`);
    await loginToX(account);
    console.log('\n✅ X session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-fb-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-fb-session <nickname>');
      process.exit(1);
    }
    const { loginToFacebook } = await import('./browser/facebook/login.js');
    console.log(`\n🌐 Opening browser for Facebook login — ${nickname}`);
    await loginToFacebook({ nickname });
    console.log('\n✅ Facebook session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-fb-session-manual') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-fb-session-manual <nickname>');
      process.exit(1);
    }
    const { loginToFacebook } = await import('./browser/facebook/login.js');
    console.log(`\n🌐 Opening browser for MANUAL Facebook login — ${nickname}`);
    console.log('   Browser will open at facebook.com/login — type your credentials yourself.');
    await loginToFacebook({ nickname, manualLogin: true });
    console.log('\n✅ Facebook session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-li-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-li-session <nickname>');
      process.exit(1);
    }
    const { loginToLinkedIn } = await import('./browser/linkedin/login.js');
    console.log(`\n🌐 Opening browser for LinkedIn login — ${nickname}`);
    await loginToLinkedIn({ nickname });
    console.log('\n✅ LinkedIn session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-patreon-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-patreon-session <nickname>');
      process.exit(1);
    }
    const { loginToPatreon } = await import('./browser/patreon/login.js');
    console.log(`\n🌐 Opening browser for Patreon login — ${nickname}`);
    await loginToPatreon({ nickname });
    console.log('\n✅ Patreon session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-notion-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-notion-session <nickname>');
      process.exit(1);
    }
    const { loginToNotion } = await import('./browser/notion/login.js');
    console.log(`\n🌐 Opening browser for Notion login — ${nickname}`);
    await loginToNotion({ nickname, headless: false });
    console.log('\n✅ Notion session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-naver-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-naver-session <nickname>');
      process.exit(1);
    }
    const { loginToNaverInteractive } = await import('./browser/naver/login.js');
    console.log(`\n🌐 Opening browser for Naver login — ${nickname}`);
    await loginToNaverInteractive({ nickname });
    console.log('\n✅ Naver session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-velog-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-velog-session <nickname>');
      process.exit(1);
    }
    const { loginToVelog } = await import('./browser/velog/login.js');
    console.log(`\n🌐 Opening browser for Velog login — ${nickname}`);
    await loginToVelog({ nickname });
    console.log('\n✅ Velog session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-coda-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-coda-session <nickname>');
      process.exit(1);
    }
    const { loginToCoda } = await import('./browser/coda/login.js');
    console.log(`\n🌐 Opening browser for Coda login — ${nickname}`);
    await loginToCoda({ nickname });
    console.log('\n✅ Coda session saved. Press Ctrl+C to exit.');
    await new Promise(() => {});
    return;
  }

  if (mode === 'save-note-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-note-session <nickname>');
      console.error('   Example: npm run dev -- save-note-session aniket');
      process.exit(1);
    }
    const { saveNoteSession } = await import('./coordinator/masterCoordinator.js');
    await saveNoteSession(nickname);
    return;
  }

  if (mode === 'save-medium-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-medium-session <nickname>');
      console.error('   Example: npm run dev -- save-medium-session pranav');
      process.exit(1);
    }
    const { saveMediumSession } = await import('./coordinator/masterCoordinator.js');
    await saveMediumSession(nickname);
    return;
  }

  if (mode === 'save-linkmate-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-linkmate-session <nickname>');
      console.error('   Example: npm run dev -- save-linkmate-session pranav');
      process.exit(1);
    }
    const { saveLinkMateSession } = await import('./coordinator/masterCoordinator.js');
    await saveLinkMateSession(nickname);
    return;
  }

  if (mode === 'save-devto-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-devto-session <nickname>');
      console.error('   Example: npm run dev -- save-devto-session pranav');
      process.exit(1);
    }
    const { getDevtoAccountByNickname } = await import('./browser/devto/login.js');
    const { chromium } = await import('playwright');
    const path = await import('path');
    const fs = await import('fs');

    const account = getDevtoAccountByNickname(nickname);
    if (!account) {
      console.error(`❌ No Dev.to account found for nickname: ${nickname}`);
      process.exit(1);
    }

    const sessionDir = path.resolve(account.sessionDir);
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    fs.mkdirSync(sessionDir, { recursive: true });

    console.log(`\n🌐 Opening browser for Dev.to login — @${nickname} (${account.email})`);
    console.log(`   Session dir: ${sessionDir}`);
    console.log(`   Log in manually in the browser, then press Enter here to save & close.\n`);

    const ctx = await chromium.launchPersistentContext(sessionDir, {
      headless: true,
      executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
      channel: fs.existsSync(chromePath) ? undefined : 'chrome',
      viewport: { width: 1366, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--disable-infobars'],
    });

    const pages = ctx.pages();
    const page = pages[0] || await ctx.newPage();
    await page.goto('https://dev.to/enter', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for user to press Enter in terminal
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.once('data', () => resolve());
    });

    console.log('\n   Saving session & closing browser...');
    await ctx.close();
    console.log(`✅ Dev.to session saved for @${nickname}\n`);
    return;
  }

  if (mode === 'save-googlesite-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-googlesite-session <nickname>');
      console.error('   Example: npm run dev -- save-googlesite-session aniket');
      process.exit(1);
    }
    const { saveGoogleSiteSession } = await import('./coordinator/masterCoordinator.js');
    await saveGoogleSiteSession(nickname);
    return;
  }

  if (mode === 'save-calisthenics-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-calisthenics-session <nickname>');
      console.error('   Example: npm run dev -- save-calisthenics-session pranav');
      process.exit(1);
    }
    const { saveCalisthenicsSession } = await import('./coordinator/masterCoordinator.js');
    await saveCalisthenicsSession(nickname);
    return;
  }

  if (mode === 'save-substack-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-substack-session <nickname>');
      console.error('   Example: npm run dev -- save-substack-session pranav');
      process.exit(1);
    }
    const path = await import('path');
    const { chromium } = await import('playwright');
    const sessionDir = path.default.resolve(`.sessions/substack/${nickname}`);
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    console.log(`\n🔐 Opening Substack browser for: ${nickname}`);
    console.log(`   Session dir: ${sessionDir}\n`);
    const fs = await import('fs');
    if (!fs.default.existsSync(sessionDir)) fs.default.mkdirSync(sessionDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(sessionDir, {
      headless: true,
      executablePath: chromePath,
      viewport: { width: 1280, height: 720 },
      slowMo: 50,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--start-minimized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
        '--disable-session-crashed-bubble', '--disable-infobars',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ctx.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
      (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
    });
    const pages = ctx.pages();
    const pg = pages[0] || await ctx.newPage();
    await pg.goto('https://substack.com/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
    process.stdout.write('\n✅ Browser open. Log in to Substack (use Continue with Google), then type y and press Enter: ');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    console.log('\n   Saving session & closing browser...');
    await ctx.close();
    console.log(`\n✅ Session saved for ${nickname}! (${sessionDir})`);
    return;
  }

  if (mode === 'save-facebook-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-facebook-session <nickname>');
      console.error('   Example: npm run dev -- save-facebook-session pranav');
      process.exit(1);
    }
    const { loginToFacebook, closeFacebookBrowser } = await import('./browser/facebook/login.js');
    console.log(`\n🔐 Opening Facebook browser for: ${nickname}`);
    console.log('   Log in manually if needed, then close the browser.\n');
    await loginToFacebook({ nickname });
    process.stdout.write('\n✅ Browser open. Log in to Facebook if needed, then type y and press Enter: ');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    console.log(`\n✅ Session saved for ${nickname}!`);
    await closeFacebookBrowser();
    return;
  }

  if (mode === 'save-wordpress-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-wordpress-session <nickname>');
      console.error('   Example: npm run dev -- save-wordpress-session pranav');
      process.exit(1);
    }
    const path = await import('path');
    const { chromium } = await import('playwright');
    const sessionDir = path.default.resolve(`.sessions/wordpress/${nickname}`);
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    console.log(`\n🔐 Opening WordPress browser for: ${nickname}`);
    console.log(`   Session dir: ${sessionDir}\n`);
    const fs = await import('fs');
    if (!fs.default.existsSync(sessionDir)) fs.default.mkdirSync(sessionDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(sessionDir, {
      headless: true,
      executablePath: chromePath,
      viewport: { width: 1366, height: 900 },
      slowMo: 50,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--start-minimized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
        '--disable-session-crashed-bubble', '--disable-infobars',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ctx.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
      (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
    });
    const pages = ctx.pages();
    const pg = pages[0] || await ctx.newPage();
    // Force window to top-left via CDP
    try {
      const cdp = await ctx.newCDPSession(pg);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1366, height: 900, windowState: 'normal' } });
      await cdp.detach().catch(() => {});
    } catch { /* ignore */ }
    await pg.goto('https://wordpress.com/log-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
    process.stdout.write('\n✅ Browser open. Log in to WordPress, then type y and press Enter: ');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    console.log(`\n✅ Session saved for ${nickname}! (${sessionDir})`);
    await ctx.close();
    return;
  }

  if (mode === 'save-blogger-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-blogger-session <nickname>');
      console.error('   Example: npm run dev -- save-blogger-session pranav');
      process.exit(1);
    }
    const path = await import('path');
    const { chromium } = await import('playwright');
    const sessionDir = path.default.resolve(`.sessions/blogger/${nickname}`);
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    console.log(`\n🔐 Opening Blogger browser for: ${nickname}`);
    console.log(`   Session dir: ${sessionDir}\n`);
    const fs = await import('fs');
    if (!fs.default.existsSync(sessionDir)) fs.default.mkdirSync(sessionDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(sessionDir, {
      headless: false,
      executablePath: chromePath,
      viewport: null,
      slowMo: 50,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
        '--disable-session-crashed-bubble', '--disable-infobars',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ctx.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
      (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
    });
    const pages = ctx.pages();
    const pg = pages[0] || await ctx.newPage();
    await pg.goto('https://www.blogger.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    process.stdout.write('\n✅ Browser open. Log in to Blogger, then type y and press Enter: ');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    console.log(`\n✅ Session saved for ${nickname}! (${sessionDir})`);
    await ctx.close();
    return;
  }

  if (mode === 'save-ameba-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-ameba-session <nickname>');
      console.error('   Example: npm run dev -- save-ameba-session pranav');
      process.exit(1);
    }
    const path = await import('path');
    const { chromium } = await import('playwright');
    const sessionDir = path.default.resolve(`.sessions/ameba/${nickname}`);
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    console.log(`\n🔐 Opening Ameba browser for: ${nickname}`);
    console.log(`   Session dir: ${sessionDir}\n`);
    const fs = await import('fs');
    if (!fs.default.existsSync(sessionDir)) fs.default.mkdirSync(sessionDir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(sessionDir, {
      headless: false,
      executablePath: chromePath,
      viewport: null,
      slowMo: 50,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run', '--no-default-browser-check',
        '--disable-session-crashed-bubble', '--disable-infobars',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ctx.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, 'webdriver', { get: () => false });
      (globalThis as any).window.chrome = (globalThis as any).window.chrome || { runtime: {} };
    });
    const pages = ctx.pages();
    const pg = pages[0] || await ctx.newPage();
    await pg.goto('https://www.ameba.jp/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    process.stdout.write('\n✅ Browser open. Log in to Ameba, then type y and press Enter: ');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    console.log(`\n✅ Session saved for ${nickname}! (${sessionDir})`);
    await ctx.close();
    return;
  }

  if (mode === 'save-paragraph-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-paragraph-session <nickname>');
      console.error('   Example: npm run dev -- save-paragraph-session pranav');
      process.exit(1);
    }
    const path = await import('path');
    const { spawn } = await import('child_process');
    const fs = await import('fs');
    const sessionDir = path.default.resolve(`.sessions/paragraph/${nickname}`);
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    console.log(`\n🔐 Opening Paragraph in normal Chrome (no automation) for: ${nickname}`);
    console.log(`   Session dir: ${sessionDir}\n`);
    if (!fs.default.existsSync(sessionDir)) fs.default.mkdirSync(sessionDir, { recursive: true });
    // Plain Chrome — no Playwright, no automation flags → bypasses captcha detection
    const proc = spawn(chromePath, [
      `--user-data-dir=${sessionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://paragraph.com/home',
    ], { detached: true, stdio: 'ignore' });
    proc.unref();
    process.stdout.write('\n✅ Normal Chrome open. Log in to Paragraph, then type y and press Enter: ');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    console.log(`\n✅ Session saved for ${nickname}! (${sessionDir})`);
    console.log('   Close Chrome manually if still open.');
    return;
  }

  if (mode === 'save-hackmd-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-hackmd-session <nickname>');
      console.error('   Example: npm run dev -- save-hackmd-session kamakshi');
      process.exit(1);
    }
    const { saveHackmdSession } = await import('./coordinator/masterCoordinator.js');
    await saveHackmdSession(nickname);
    return;
  }

  if (mode === 'login' || mode === 'save-x-session') {
    const nickname = process.argv[3];
    if (!nickname) {
      console.error('❌ Usage: npm run dev -- save-x-session <nickname>');
      console.error('   Example: npm run dev -- save-x-session aniket');
      process.exit(1);
    }
    const { getAccountByHandle } = await import('./config/accounts.js');
    const { spawn } = await import('child_process');
    const path = await import('path');
    const fs = await import('fs');
    const account = getAccountByHandle(nickname);
    if (!account) {
      console.error(`❌ Account "${nickname}" not found in accounts.json`);
      process.exit(1);
    }
    const sessionDir = path.default.resolve(account.sessionDir || `.sessions/chrome-${account.handle}`);
    fs.default.mkdirSync(sessionDir, { recursive: true });
    const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    console.log(`\n🔐 Opening plain Chrome for: @${account.handle} (${nickname})`);
    console.log(`   Session dir: ${sessionDir}`);
    console.log(`   → Log in to X manually, then come back here and press Enter.\n`);
    const chrome = spawn(chromePath, [
      `--user-data-dir=${sessionDir}`,
      '--new-window',
      'https://x.com/login',
    ], { detached: true, stdio: 'ignore' });
    chrome.unref();
    process.stdout.write('✅ Browser open. Login complete? Press Enter to finish: ');
    await new Promise<void>(resolve => {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
    });
    console.log(`\n✅ Session saved for ${nickname}!`);
    return;
  }

  if (mode === 'tracker') {
    console.log('📊 Running daily posting tracker...\n');
    const { runTracker, printTrackerReport } = await import('./tracker.js');
    const result = await runTracker();
    printTrackerReport(result);
    return;
  }

  if (mode === 'today') {
    const { runTracker, printTodaySummary, postTodaySummaryToTeams } = await import('./tracker.js');
    const result = await runTracker();
    printTodaySummary(result);

    if (process.argv.includes('--no-teams')) return;

    const autoSend = process.argv.includes('--send');
    if (autoSend) {
      await postTodaySummaryToTeams(result);
      return;
    }

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve =>
      rl.question('\nSend this summary to Teams? (y/N): ', a => { rl.close(); resolve(a); })
    );
    if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
      await postTodaySummaryToTeams(result);
    } else {
      console.log('Skipped Teams post.');
    }
    return;
  }

  if (mode === 'status') {
    console.log('📊 Fetching sheet stats...\n');
    const { getUnassignedRows, getRowsReadyForFb, getRowsReadyForLi } = await import('./sheets/sheets.js');
    const unassigned = await getUnassignedRows();
    const fbReady    = await getRowsReadyForFb(999);
    const liReady    = await getRowsReadyForLi(999);
    console.log(`  Unassigned (no SEO rank yet):  ${unassigned.length} rows`);
    console.log(`  Ready for FB (rank set, no FB post): ${fbReady.length} rows`);
    console.log(`  Ready for LI (rank set, no LI post): ${liReady.length} rows`);
    return;
  }

  if (mode === 'reset-medium-posts') {
    console.log('🔄 Resetting Medium posts...\n');
    const { resetMediumPosts } = await import('./coordinator/masterCoordinator.js');
    await resetMediumPosts();
    return;
  }

  // ── Retry a specific row on a specific platform ─────────────────────────────
  //   npm run dev -- row 15 googlesite
  //   npm run dev -- row 22 hackmd
  //   npm run dev -- row 8 devto
  if (mode === 'row') {
    const rowArg = process.argv[3];
    const platformArg = process.argv[4];
    if (!rowArg || !platformArg) {
      console.error('❌ Usage: npm run dev -- row <rowNumber> <platform>');
      console.error('   Example: npm run dev -- row 15 googlesite');
      console.error('   Platforms: googlesite, hackmd, devto, medium, linkmate, linkedin-pulse, calisthenics, substack, wordpress, naver');
      process.exit(1);
    }
    const rowIndex = parseInt(rowArg, 10);
    if (isNaN(rowIndex) || rowIndex < 2) {
      console.error(`❌ Row number must be a number ≥ 2 (row 1 is the header). Got: ${rowArg}`);
      process.exit(1);
    }
    const { runRetryRow } = await import('./coordinator/masterCoordinator.js');
    await runRetryRow(rowIndex, platformArg);
    return;
  }

  // ── Retry a row range on one platform, sequentially ──────────────────────
  //   npm run dev -- rows 10 20 x
  //   npm run dev -- rows 32 46 hackmd
  if (mode === 'rows' || mode === 'row-range') {
    const fromArg = process.argv[3];
    const toArg = process.argv[4];
    const platformArg = process.argv[5];
    if (!fromArg || !toArg || !platformArg) {
      console.error('❌ Usage: npm run dev -- rows <fromRow> <toRow> <platform>');
      console.error('   Example: npm run dev -- rows 10 20 x');
      console.error('   Platforms: googlesite, hackmd, devto, medium, linkmate, linkedin-pulse, calisthenics, substack, wordpress, blogger, x, facebook, linkedin');
      process.exit(1);
    }

    const fromRow = parseInt(fromArg, 10);
    const toRow = parseInt(toArg, 10);
    if (isNaN(fromRow) || isNaN(toRow) || fromRow < 2 || toRow < 2 || fromRow > toRow) {
      console.error(`❌ Row range must be valid sheet rows ≥ 2 and fromRow <= toRow. Got: ${fromArg} ${toArg}`);
      process.exit(1);
    }

    const { runRetryRow } = await import('./coordinator/masterCoordinator.js');
    console.log(`\n🔁 Running rows ${fromRow}-${toRow} on ${platformArg}\n`);
    for (let rowIndex = fromRow; rowIndex <= toRow; rowIndex++) {
      console.log(`\n──────── Row ${rowIndex}/${toRow} ────────`);
      await runRetryRow(rowIndex, platformArg);
    }
    console.log(`\n✅ Row range complete: ${fromRow}-${toRow} on ${platformArg}`);
    return;
  }

  // Default: start cron scheduler daemon
  await startCoordinatorDaemon();

  // RSS feed of recently-published reports, for faster search-engine
  // discovery — see src/rss/server.ts.
  const { startRssServer } = await import('./rss/server.js');
  startRssServer();

  // Keep the process alive for cron jobs to fire
  await new Promise(() => {});
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  console.error(err);
  process.exit(1);
});

