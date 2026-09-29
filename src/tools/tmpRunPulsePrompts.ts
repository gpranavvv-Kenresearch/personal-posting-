/**
 * tmpRunPulsePrompts.ts — one-off test run of the 4 LinkedIn Pulse article
 * prompts from "Different Prompts for LinkedIn Articles.docx", sent ONE AT A
 * TIME through the same ChatGPT session blog generation uses (the
 * "social-image" account, per blogGenAgent.ts's DEFAULT_BLOG_ACCOUNT) — never
 * carousel-single or storyline, those are reserved for the LI carousel
 * pipelines. Records each response to a local file before sending the next.
 */
import 'dotenv/config';
import fs from 'fs';
import { Page } from 'playwright';
import TurndownService from 'turndown';
import { ensureChatGptPage, closeChatGptBrowser, COMPOSER_SELECTOR } from '../browser/chatgpt/login.js';
import { pasteIntoChatGptComposer, dismissBlockingModals } from '../utils/chatgptComposer.js';

const BLOG_TEXT_ACCOUNT = 'social-image'; // same account blogGenAgent.ts uses for blog text

const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
// Matches both the old data-message-author-role attribute and the new UI's
// div[data-markdown-text-style="assistant-message"] (confirmed live
// 2026-09-26 — ChatGPT dropped the old attribute in a UI redesign).
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const turndownService = new TurndownService({ headingStyle: 'atx', emDelimiter: '*', strongDelimiter: '**' });
turndownService.remove(['button']);

async function sendPromptAndWait(page: Page, prompt: string): Promise<string> {
  await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded' });
  await page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 30_000 });

  await pasteIntoChatGptComposer(page, prompt);

  await dismissBlockingModals(page);
  const sendBtn = page.locator(SEND_BUTTON_SELECTOR).first();
  await sendBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await sendBtn.click();

  // Wait for streaming to finish (stop button appears then disappears).
  await page.locator(STOP_BUTTON_SELECTOR).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  await page.locator(STOP_BUTTON_SELECTOR).first().waitFor({ state: 'hidden', timeout: 300_000 });

  const lastMessage = page.locator(ASSISTANT_MESSAGE_SELECTOR).last();
  let previousLength = -1;
  for (let i = 0; i < 8; i++) {
    await sleep(700);
    const currentLength = (await lastMessage.innerText().catch(() => '')).length;
    if (currentLength > 0 && currentLength === previousLength) break;
    previousLength = currentLength;
  }

  const rawHtml = await lastMessage.innerHTML();
  const rawText = turndownService.turndown(rawHtml);
  if (!rawText?.trim()) throw new Error('ChatGPT: reply came back empty');
  return rawText.trim();
}

const TEST_URL = 'https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market';
const TEST_KEYWORDS = 'Saudi Arabia outdoor play structures market, playground equipment Saudi Arabia, recreational infrastructure GCC';

// Matches the exact "Return exactly" structured-deliverable contract from
// the existing master blog prompt (buildKenResearchMasterPromptV1_3 in
// blogGenAgent.ts) so the same downstream parser (extractBlog(), which finds
// each section by its heading name) works identically no matter which
// prompt variant produced the reply — required before these can ever rotate
// 50/50 with the existing prompt.
const HTML_INSTRUCTION = `

OUTPUT FORMAT (mandatory) — return exactly the following sections, in this order, each under its own heading line exactly as written below. Do not add commentary before "SEO Title" or after the closing tag of the FINAL ARTICLE HTML.

SEO Title
A search-facing title, distinct from the article's own H1/headline. Must be unique, punchy, search-intent aligned. Do not include "Ken Research" in it.

Meta Description
A single-paragraph meta description (under 160 characters) summarizing the article for search results.

Primary Search Intent
One line naming the primary search intent this article satisfies.

Primary Keyword
The single primary target keyword.

Secondary Semantic Topics
A short list of secondary semantic topics/keywords covered.

Suggested Snapshot Image Alt
One descriptive alt-text line for the article's snapshot image.

Key Snapshot Metrics for Image
5-7 supported metrics, one per line, each in the exact format "Label: Value" (e.g. "Market Size 2025: USD 1.2 Billion", "CAGR 2025-2030: 8.4%", "Top Segment Share: Skincare 34%", "Key Player: PlayCore") — never freeform prose, never a citation chip (bare domain or "+N") as its own line.

Internal Link Map
For each Ken Research link used in the article: Anchor / Verified URL / Report publication date or year if available / Intended H2 section / Why relevant / Supporting contextual trend or claim if available. Include the Ken Research homepage branding link, the Primary Report as the final CTA, and 2-4 adjacent report links.

External Source Map
For each external (government/official) source used: Source or anchor / Official URL / Claim supported / Intended placement.

FINAL ARTICLE
ONE complete, clean HTML article — use <h1> for the title, <h2>/<h3> for subheadings, <p> for paragraphs, <ul>/<li> for lists, and <a href="..."> for every interlink. No markdown syntax anywhere inside the HTML (no #, **, -, etc.).`;

const PROMPTS: { name: string; prompt: string }[] = [
  {
    name: '1-visionary-forecast',
    prompt: `Role & Task: Act as an expert B2B content strategist and futurist. Write an 800-1000 word LinkedIn Pulse article targeting CXOs, founders, and decision-makers. Input Data: URL: ${TEST_URL}. Key Stats/Data: research and extract the current market size, CAGR, and forecast figures directly from the URL above. Target Keywords: ${TEST_KEYWORDS}. Storytelling Angle: The Visionary Forecast (Future-Casting). Focus on horizon scanning, 3-to-5-year market shifts, and strategic foresight. The narrative should be: "Look beyond the current quarter; here is what the autonomous/cognitive ecosystem of the future looks like and how to prepare your board." Tone: Visionary, forward-looking, yet grounded in the provided data. Professional and boardroom-ready. Optimization Rules: SEO: Optimize H-tags for long-tail future-focused keywords. AIO/AEO: Use a "Current State vs. Future State" comparison list for easy AI parsing. GEO/LLM: Establish strong semantic relationships between current technologies and future outcomes. Use clear, definitive language. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research foresight or macro-trend reports. End with a strong CTA: "Schedule a strategic foresight session with Ken Research analysts to align your long-term vision with market realities."${HTML_INSTRUCTION}`,
  },
  {
    name: '2-industry-blind-spot',
    prompt: `Role & Task: Act as an expert B2B content strategist and industry insider. Write an 800-1000 word LinkedIn Pulse article targeting CXOs, founders, and decision-makers. Input Data: URL: ${TEST_URL}. Target Keywords: ${TEST_KEYWORDS}. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., regulatory changes, compliance data, .gov policy shifts, national audit reports) to expose the gap between the surface-level industry narrative and the underlying data reality. Storytelling Angle: The Industry Blind Spot. Do NOT use a confrontational "your strategy is failing" tone. Instead, use a revelatory, insider-intelligence writing style. The narrative should be: "The entire industry is collectively optimizing for the wrong metric and chasing the wrong trend. Here is the hidden data pattern that almost every board is overlooking, and the massive first-mover advantage available to the few leaders who see what others cannot." Frame the reader as the smart insider who "gets it," not as someone being lectured. Tone: Sophisticated, revelatory, calm but compelling. Think "exclusive briefing from a trusted advisor," not "aggressive thought leader shouting on LinkedIn." The authority should come from the depth of the data, not from provocative language. Formatting Rules: CRITICAL BULLET POINT RULE: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Structure using a "Surface Narrative vs. Underlying Data Reality" framework instead of the overused "Myth vs. Reality" format. This unique structure is more likely to be cited by AI answer engines as a novel perspective. GEO/LLM: Use objective, data-backed assertions with clear causal reasoning. Ensure the logical bridge between "what the industry believes" and "what the government/market data actually shows" is airtight for LLM comprehension. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research deep-dive analytical or sector-specific reports. End with a strong CTA: "Consult Ken Research for a bespoke market intelligence deep-dive to uncover the blind spots your competitors have not yet identified."${HTML_INSTRUCTION}`,
  },
  {
    name: '3-regulatory-policy-catalyst',
    prompt: `Role & Task: Act as an expert B2B content strategist and corporate policy advisor. Write an 800-1000 word LinkedIn Pulse article targeting CXOs, founders, and decision-makers. Input Data: URL: ${TEST_URL}. Target Keywords: ${TEST_KEYWORDS}. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., new policy frameworks, subsidy allocations, national compliance mandates, .gov economic surveys) to highlight the regulatory catalyst. Storytelling Angle: The Regulatory Catalyst. The narrative should be: "Government policy is the ultimate market mover. Here is how recent regulatory shifts and national mandates are creating an asymmetric advantage for early movers, and how to align your corporate strategy with the new rules of the game." Tone: Strategic, risk-aware, highly professional, and policy-literate. Formatting Rules: CRITICAL BULLET POINT RULE: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Use a "Policy Shift -> Market Impact -> Strategic Action" structure. Detailed lists are critical here for Answer Engine parsing. GEO/LLM: Clearly define the relationship between government policy (entity 1) and market outcomes (entity 2) for LLM context. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research regulatory impact, market entry, or policy analysis reports. End with a strong CTA: "Access the Ken Research Policy Impact Toolkit to align your corporate strategy with the latest regulatory frameworks immediately."${HTML_INSTRUCTION}`,
  },
  {
    name: '4-ecosystem-map',
    prompt: `Role & Task: Act as an expert B2B content strategist and M&A/strategy advisor. Write an 800-1000 word LinkedIn Pulse article targeting CXOs, founders, and decision-makers. Input Data: URL: ${TEST_URL}. Target Keywords: ${TEST_KEYWORDS}. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., cross-border trade data, foreign direct investment stats, .gov economic surveys) to map out the macro-synergies. Storytelling Angle: The Ecosystem Map (Strategic Alignment). Focus on cross-industry convergence, M&A targets, and macro-synergies. The narrative should be: "Industry boundaries are dissolving. Here is how different sectors are intersecting, and where the hidden alpha lies for founders and investors." Tone: Strategic, big-picture, investor/boardroom-focused, and highly professional. H2/H3 Tag Optimization Rules (CRITICAL): ZERO Generic Headings: Do NOT use "Market Trends", "Synergies", "Industry Overlaps", "Key Takeaways", or "Conclusion". Convergence-Driven H2s: Every H2 must highlight a specific intersection of industries, M&A activity, or macro-synergy using strong semantic keywords. (e.g., Instead of "New Partnerships", use "Mapping the Convergence: How Retail and Logistics are Merging into Retail-as-a-Service (RaaS)"). AEO/GEO Structure: Use H2s to define the specific ecosystems being mapped. Use H3s to break down the exact M&A targets, joint venture structures, or capital flows within that ecosystem. Ensure H2s act as direct, semantic answers to investor and CXO queries. Formatting Rules: Crucial Bullet Point Rule: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Use a "Key Intersections" bulleted list to clearly map out the converging sectors for AI summarization. GEO/LLM: Focus on entity relationships (e.g., how Sector A impacts Sector B). Use authoritative, analytical language that signals high expertise to Generative Engines. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research ecosystem, market mapping, or M&A reports. End with a strong CTA: "Download the Ken Research Ecosystem Map to discover untapped M&A and joint venture opportunities in your sector."${HTML_INSTRUCTION}`,
  },
];

async function run() {
  const outDir = 'output/pulse-prompt-test';
  fs.mkdirSync(outDir, { recursive: true });

  const page = await ensureChatGptPage(BLOG_TEXT_ACCOUNT);

  for (const { name, prompt } of PROMPTS) {
    console.log(`\n========== Sending: ${name} ==========`);
    try {
      const response = await sendPromptAndWait(page, prompt);
      const outPath = `${outDir}/${name}.html`;
      fs.writeFileSync(outPath, response, 'utf8');
      console.log(`✅ Saved (${response.length} chars) -> ${outPath}`);
    } catch (err: any) {
      console.error(`❌ ${name} failed: ${err.message}`);
    }
  }

  await closeChatGptBrowser();
  console.log('\nDone.');
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
