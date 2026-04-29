/**
 * youtubeBatchAgentNew.ts — YouTube Shorts Batch Agent
 *
 * Pipeline per row (same social sheet as X/FB/LI):
 *   1. Generate 4 professional video prompts (with voiceover)
 *   2. Grok generates 4 clips via direct Playwright
 *   3. FFmpeg: merge 4 clips → final_[timestamp].mp4
 *   4. Upload to YouTube Studio via direct Playwright
 *   5. Save result back to social sheet (YouTube Post URL / YouTube Status)
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SheetRow } from '../sheets/sheets.js';
import { generateGrokVideos } from '../browser/youtube/grokVideo.js';
import { uploadToYoutube } from '../browser/youtube/uploader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Rotate through YouTube accounts for each row
let _ytAccountIndex = 0;
function pickYoutubeAccount(): string {
  const p = path.join(__dirname, '../../.accounts/accounts-youtube.json');
  const accounts: Array<{ 'Account Name'?: string; name?: string; username?: string }> = JSON.parse(readFileSync(p, 'utf8'));
  const valid = accounts.filter(a => a['Account Name'] || a.name || a.username);
  if (valid.length === 0) throw new Error('No YouTube accounts found in accounts-youtube.json');
  const acc = valid[_ytAccountIndex % valid.length];
  _ytAccountIndex++;
  return String(acc['Account Name'] || acc.name || acc.username || '');
}

const FFMPEG_PATH  = 'C:\\ffmpeg\\bin\\ffmpeg.exe';
const TEMP_DIR     = 'C:\\temp';

// ── Prompt generator ──────────────────────────────────────────────────────────

function generatePrompts(title: string, url: string): {
  prompt1: string; prompt2: string; prompt3: string; prompt4: string;
  youtubeTitle: string; youtubeDescription: string;
} {
  // ── PROMPT 1: Market Size & Growth (with voiceover) ─────────────────────────
  const prompt1 = `Generate a 6-second ultra-premium cinematic financial infographic video for YouTube Shorts.

REPORT TITLE: "${title}"
SOURCE URL: ${url || 'kenresearch.com'}

━━━ SCENE: Market Size & Growth Overview ━━━

VISUAL DESIGN (4K vertical 9:16):
• Background: Deep navy-to-black gradient, premium dark theme
• Typography: Montserrat Bold / Bebas Neue — crisp, financial-grade
• Colour palette: Metallic gold (#D4AF37), electric blue (#00BFFF), white — no other colours
• Subtle animated particle grid in background (very low opacity)
• Ken Research watermark bottom-right at all times

[0.0 – 0.6s] TITLE CARD
Gold text staggered fade-in:
  Line 1 (large): "${title}"
  Line 2 (small, white): "Global Market Intelligence Report 2024–2030"
  Animated gold underline draws left-to-right beneath both lines

[0.6 – 4.2s] THREE STAT CARDS — slide in from bottom with spring easing
  Card A | "2024 Market Size"  | Gold $ counter animates 0 → final Billion USD | Gold border glow
  Card B | "CAGR 2024–2030"   | Blue % counter animates, upward arrow pulses   | Neon blue border glow
  Card C | "2030 Projection"   | Gold $ counter animates, double-up icon       | Gold border glow

[2.0 – 5.0s] GROWTH CHART — overlapping with cards
  Animated upward line chart draws left → right
  X-axis labels: 2024 · 2026 · 2028 · 2030 (white, small)
  Line: electric blue with neon glow trail
  Data nodes: gold circles that pop in with subtle scale bounce
  Area fill: deep blue gradient below line

[5.0 – 6.0s] BRAND OUTRO
  Slow Ken Burns zoom-in
  Footer: "Data by Ken Research | www.kenresearch.com"

━━━ VOICEOVER SCRIPT (professional male voice, measured pace) ━━━
"${title} — a rapidly growing global market.
By 2030, analysts project significant expansion driven by rising demand and technological adoption.
For the full intelligence report, visit Ken Research dot com."

VOICEOVER STYLE: Calm, authoritative financial narrator. Clear enunciation. No music bed — just clean voice.

STYLE RULES: No placeholder text. All numbers must appear. Gold + blue palette only. 4K 9:16 vertical.`;

  // ── PROMPT 2: Market Segmentation (with voiceover) ──────────────────────────
  const prompt2 = `Generate a 6-second ultra-premium cinematic financial infographic video for YouTube Shorts.

REPORT TITLE: "${title}"

━━━ SCENE: Market Segmentation Analysis (Part 2 of 4) ━━━

VISUAL DESIGN (4K vertical 9:16):
• Same dark navy-black premium background — visual continuity from Part 1
• Gold + electric blue + teal + violet for chart segments
• Montserrat Bold typography

[0.0 – 0.5s] HEADER
  Gold animated header: "Market Segmentation — ${title}"
  Thin gold underline draws in, "Ken Research | kenresearch.com" bottom-right

[0.5 – 4.5s] 3D DONUT CHART — centre screen
  Segments build clockwise one-by-one, each with:
  → Outward pop animation as it appears
  → Percentage counter animates from 0% → final value
  → External label with connecting gold line
  Segment colours: gold (largest), electric blue, teal, violet, white
  Largest segment has a subtle outer glow ring

  RIGHT PANEL — legend animates line by line:
  [Dot] Segment Name  —  XX%  —  $X.X Bn

[3.8 – 5.5s] INSIGHT CALLOUT BOX
  Dark card, gold left border, slides up from bottom:
  "The [Top Segment] leads with the highest revenue share, driven by [key industry trend]"

[5.5 – 6.0s] OUTRO
  Subtle zoom out, footer: "Source: Ken Research | www.kenresearch.com"

━━━ VOICEOVER SCRIPT ━━━
"${title} — diverse market segments, each telling a unique story.
Product type, application, and regional dynamics all shape competitive positioning.
Download the complete segmentation report at Ken Research dot com."

VOICEOVER STYLE: Same authoritative narrator. Measured pace. No music.`;

  // ── PROMPT 3: Competitive Landscape (with voiceover) ────────────────────────
  const prompt3 = `Generate a 6-second ultra-premium cinematic financial infographic video for YouTube Shorts.

REPORT TITLE: "${title}"

━━━ SCENE: Competitive Landscape & Key Players (Part 3 of 4) ━━━

VISUAL DESIGN (4K vertical 9:16):
• Dark navy-black background, professional corporate aesthetic
• Market leader bar highlighted gold, others electric blue

[0.0 – 0.5s] HEADER
  Gold fade-in: "Top Market Players — ${title}"
  White subtitle: "Competitive Share Analysis 2024"
  Gold divider line, Ken Research corner watermark

[0.5 – 4.5s] HORIZONTAL BAR CHART — builds top to bottom, staggered 0.3s per bar
  5 bars, each animating left → right:
  ① #1 Company  — glowing GOLD bar — percentage counter — "Market Leader" badge
  ② #2 Company  — electric blue bar
  ③ #3 Company  — electric blue bar
  ④ #4 Company  — electric blue bar
  ⑤ Others       — muted teal bar

  After all bars complete → gold callout box:
  "Top 3 players control ~XX% of total market"

[2.5 – 5.0s] RIGHT STATS PANEL (slides in at 2.5s):
  • Total Players: XXX+
  • Market Concentration: Low / Medium / High
  • M&A Deals 2023–24: XX

[4.5 – 6.0s] ZOOM on leader bar, footer solidifies

━━━ VOICEOVER SCRIPT ━━━
"${title} — a competitive landscape dominated by a handful of key players.
The top three companies collectively hold the majority of market share.
Get the full competitive intelligence at Ken Research dot com."

VOICEOVER STYLE: Same authoritative narrator. Measured, confident delivery.`;

  // ── PROMPT 4: Future Outlook + CTA (with voiceover) ─────────────────────────
  const prompt4 = `Generate a 6-second ultra-premium cinematic financial infographic video for YouTube Shorts.

REPORT TITLE: "${title}"

━━━ SCENE: Future Outlook & Growth Drivers 2025–2030 (Part 4 of 4) ━━━

VISUAL DESIGN (4K vertical 9:16):
• Dark background with subtle animated world-map dot grid (very low opacity)
• Four trend blocks, strong CTA closer

[0.0 – 0.5s] HEADER
  Gold fade-in: "Future Growth Drivers 2025–2030"
  White subtitle: "${title} — Investment Outlook"
  Gold divider, Ken Research watermark

[0.5 – 4.0s] FOUR TREND BLOCKS — staggered slide-in from left (0.5s apart)
  Each block has: dark card | gold left-accent border | gold icon circle | white stat text | neon-blue progress bar

  Block 1 — 📈 Rising Demand
    "Consumer demand accelerating at XX% YoY"
    Progress bar: 70%

  Block 2 — 💻 Digital Transformation
    "XX% of industry players digitising operations by 2027"
    Progress bar: 60%

  Block 3 — 🏛️ Government & Policy Support
    "Governments committing $XX Bn in sector investment"
    Progress bar: 80%

  Block 4 — 🌍 Emerging Market Expansion
    "Emerging markets to contribute XX% of new growth"
    Progress bar: 75%

  All stat numbers animate (counter effect).

[3.5 – 5.0s] WORLD MAP — fades in as background, glowing dots pulse at Asia, N.America, Europe

[5.0 – 6.0s] CTA — centre screen with gold particle shimmer:
  LINE 1 (GOLD, 48px): "GET THE FULL REPORT"
  LINE 2 (WHITE, 28px): "www.kenresearch.com"
  LINE 3 (BLUE, 20px):  "Follow for Daily Market Intelligence 📊"

  FINAL FREEZE: "© Ken Research Pvt. Ltd. | Market Research & Consulting"

━━━ VOICEOVER SCRIPT ━━━
"${title} — positioned for sustained growth through 2030.
Rising demand, digital adoption, and strong policy tailwinds are key catalysts.
Visit Ken Research dot com for the complete investment-grade report."

VOICEOVER STYLE: Warm but authoritative. Slightly uplifting on CTA line. No music.

CRITICAL: Ken Research branding visible minimum 3 times. All numbers must render. No placeholder text.`;

  const safeTag = title.replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 25);

  return {
    prompt1, prompt2, prompt3, prompt4,
    youtubeTitle: `${title} — Market Size, Trends & Forecast 2025–2030 | Ken Research #shorts`,
    youtubeDescription: `📊 ${title} — Complete Market Intelligence by Ken Research

✅ Market Size & CAGR (2024–2030)
✅ Key Segments & Revenue Breakdown
✅ Top Companies & Competitive Landscape
✅ Future Growth Drivers & Investment Outlook

🔗 Full Report: www.kenresearch.com${url ? '\n📎 ' + url : ''}

#MarketResearch #${safeTag} #BusinessIntelligence #Investing #Shorts #KenResearch #MarketAnalysis #MarketTrends #Industry`,
  };
}

// ── FFmpeg merge ──────────────────────────────────────────────────────────────

function mergeClips(timestamp: string): string {
  const finalPath = `${TEMP_DIR}\\final_${timestamp}.mp4`;
  const listPath  = `${TEMP_DIR}\\list.txt`;

  if (!existsSync(FFMPEG_PATH)) throw new Error(`FFmpeg not found at ${FFMPEG_PATH}`);
  if (!existsSync(listPath))    throw new Error(`list.txt not found at ${listPath} — Grok download may have failed`);

  console.log(`   🎞️  Merging clips → ${finalPath}`);
  execSync(`"${FFMPEG_PATH}" -f concat -safe 0 -i "${listPath}" -c copy "${finalPath}" -y`, { stdio: 'pipe' });
  console.log(`   ✅ Merged: ${finalPath}`);
  return finalPath;
}

// ── Main batch function ───────────────────────────────────────────────────────

export interface YoutubeBatchResult {
  processed: number;
  uploaded:  number;
  failed:    number;
  results: Array<{
    title:    string;
    success:  boolean;
    videoUrl?: string;
    error?:   string;
  }>;
}

export async function runYoutubeBatchAgent(params: {
  rows: SheetRow[];
  batchLabel?: string;
}): Promise<YoutubeBatchResult> {
  const result: YoutubeBatchResult = { processed: 0, uploaded: 0, failed: 0, results: [] };
  const batchLabel = params.batchLabel ?? 'Batch 1';

  for (const row of params.rows) {
    result.processed++;
    console.log(`\n   🎬 Processing: "${row.title}" (row ${row.rowIndex})`);

    const timestamp    = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const prompts      = generatePrompts(row.title, row.targetUrl);
    const chromeProfile = pickYoutubeAccount();

    console.log(`   👤 YouTube account: ${chromeProfile}`);

    try {
      // ── Step 1: Generate videos via Grok (direct Playwright) ──────────────
      console.log(`   📤 Generating videos via Grok...`);
      const genResult = await generateGrokVideos({
        title: row.title,
        chromeProfile,
        timestamp,
        prompt1: prompts.prompt1,
        prompt2: prompts.prompt2,
        prompt3: prompts.prompt3,
        prompt4: prompts.prompt4,
      });
      console.log(`   ✅ Clips ready: ${genResult.clip0}`);

      // ── Step 2: FFmpeg merge ──────────────────────────────────────────────
      const finalPath = mergeClips(timestamp);

      // ── Step 3: Upload to YouTube (direct Playwright) ─────────────────────
      console.log(`   📤 Uploading to YouTube...`);
      const uploadResult = await uploadToYoutube({
        finalPath,
        title:         prompts.youtubeTitle,
        description:   prompts.youtubeDescription,
        chromeProfile,
      });

      console.log(`   ✅ Uploaded: ${uploadResult.videoUrl}`);

      // ── Step 4: Save result to social sheet ───────────────────────────────
      const { saveYoutubeResult } = await import('../sheets/sheets.js');
      await saveYoutubeResult(row, {
        youtubePostUrl: uploadResult.videoUrl ?? '',
        youtubeStatus:  'Posted',
        youtubeBatch:   batchLabel,
      });

      result.uploaded++;
      result.results.push({ title: row.title, success: true, videoUrl: uploadResult.videoUrl ?? undefined });

    } catch (err: any) {
      console.error(`   ❌ Failed "${row.title}": ${err.message}`);
      try {
        const { saveYoutubeResult } = await import('../sheets/sheets.js');
        await saveYoutubeResult(row, {
          youtubePostUrl: '',
          youtubeStatus:  'Error',
          youtubeBatch:   batchLabel,
          youtubeError:   err.message,
        });
      } catch (sheetErr: any) {
        console.warn(`   ⚠️  Could not update sheet: ${sheetErr.message}`);
      }
      result.failed++;
      result.results.push({ title: row.title, success: false, error: err.message });
    }
  }

  return result;
}
