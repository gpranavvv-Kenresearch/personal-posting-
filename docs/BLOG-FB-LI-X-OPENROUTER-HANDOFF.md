# Handoff: Blog Generation (V1/V2), FB/LI/X Post Generation, OpenRouter API Fixes

Repo: `x-posting-agent`. Everything below is already implemented and typechecked clean (`npx tsc --noEmit -p .` shows only pre-existing unrelated errors in `instagramBatchAgentNew.ts`, `letsdiskuss*`, `runSlideshareRow.ts`, `runGoogleSiteRows.ts`, `seoTools.ts`, `browserTools.ts`, `pulsePasteOnly.ts`, `devto/poster.ts`, `letsdiskuss/poster.ts`, `resilientBrowser.ts` — none of which this session touched).

This is a **reference document**, not a to-do list. It contains the full verbatim prompt text and code for the blog-generation pipeline, plus a summary + key code excerpts for the FB/LI/X and OpenRouter changes.

---

## Part 1 — Blog Generation (`src/agents/blogGenAgent.ts`)

### Architecture

```
generateBlogViaChatGpt({ title, url, accountHandle?, promptVersion? })
  → launches its own persistent Chrome context (session dir per ChatGPT account)
  → navigates to chatgpt.com/new, waits for login
  → builds the prompt: promptVersion === 'v2' ? buildMasterBlogPromptV2() : buildMasterBlogPrompt()
  → pastes prompt into composer, sends
  → waitForBlogCompletion() — polls up to 30 min (first check after 5 min, then every 1 min)
  → extractBlogStable() — extracts Title/Description/HTML from the last assistant message,
    re-checks until 2 consecutive extractions agree on HTML length (protects against a
    popup silently truncating mid-scrape)
  → detects "RESEARCH BLOCKED" sentinel and throws if ChatGPT couldn't verify the report
  → sanitizeHtml() — fixes mis-encoded quotes (%22) and strips ChatGPT citation artifacts
  → injectBlogUtm() — rebuilds every kenresearch.com link's UTM params fresh (LinkedIn Pulse UTM)
  → returns { title, description, html }
```

Downstream (`src/coordinator/blogGenLoop.ts`'s `runBlogGenBatch()`, called by `npm run dev -- run-blog-gen [N]` and `run-blog-gen-loop`):
```
generateBlogViaChatGpt(...)
  → injectCoverImage() if a cover image was generated concurrently
  → runBlogSanityChecks() (blogSanityAgent.ts) — HTML cleanup
  → validateBrandAuthority() (blogBrandValidator.ts) — brand-compliance gate
     → REWRITE_REQUIRED throws into the existing per-row retry loop (regenerate once, then skip row)
  → saveGeneratedBlogToPool() — writes to the sheet
  → verifyWrite() — re-reads the row to confirm the write actually landed (word count floor)
```

### Full ChatGPT-driving mechanics — imports, constants, popup handling, completion polling, extraction, sanitization, login (verbatim, unchanged this session except where noted)

```ts
// blogGenAgent.ts — top of file
import { chromium, Page } from 'playwright';
import fs from 'fs';
import { sessionDirForAccount } from '../config/chatGptAccountTracker.js';
import { killChromeForProfile } from '../utils/killChrome.js';
import { pasteIntoChatGptComposer, dismissBlockingModals } from '../utils/chatgptComposer.js';
import { recordChatGptFailure, recordChatGptSuccess } from '../config/chatGptAccountTracker.js';
import { injectUTM, UTM_PARAMS } from '../utils/utm.js';

const COMPOSER_SELECTOR = '#prompt-textarea';
const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
const LOGIN_BUTTON_SELECTOR = 'button:has-text("Log in"), a:has-text("Log in")';
const MANUAL_LOGIN_TIMEOUT_MS = 120_000;

// Dedicated account for blog TEXT generation — kept separate from
// blogImageAgent.ts's default account so the two always run in separate
// Chrome profiles/windows and can run concurrently.
const DEFAULT_BLOG_ACCOUNT = 'account1';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Blog generation is slow (~12-15 min) — much longer budget than
// promptRunner.ts's 2-minute timeout, which is sized for short social replies.
const RESPONSE_TIMEOUT_MS = 30 * 60 * 1000; // hard cap 30 min
const POLL_MS = 60 * 1000; // check every 1 min (after the first 5-min wait)

// ChatGPT's rate-limit / session-nudge popups can appear at any point during
// the ~12-15 min generation. A generic dialog/overlay is detected by role,
// then Enter is pressed to dismiss it — repeated until it's actually gone
// (not a fixed count), since some ChatGPT dialogs re-render themselves once
// after the first dismissal.
const GENERIC_POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"]';
const MAX_POPUP_DISMISS_ATTEMPTS = 8;

async function popupPresent(page: Page): Promise<boolean> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = window.getComputedStyle(el as Element);
    return style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null;
  }, GENERIC_POPUP_SELECTOR).catch(() => false);
}

/** Keep pressing Enter for as long as a popup keeps showing up (capped so a stuck dialog can't hang generation forever). */
async function clearPopups(page: Page): Promise<void> {
  for (let i = 0; i < MAX_POPUP_DISMISS_ATTEMPTS; i++) {
    await dismissBlockingModals(page);
    if (!(await popupPresent(page))) return;
    console.log(`   [blog] Popup detected — pressing Enter to dismiss (attempt ${i + 1}/${MAX_POPUP_DISMISS_ATTEMPTS})...`);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(600);
  }
}

/** Wait until the assistant response finished streaming (send re-enabled, text stable). */
async function waitForBlogCompletion(page: Page): Promise<void> {
  const start = Date.now();
  let goneChecks = 0;
  let lastLength = -1;
  let unchangedChecks = 0;
  let tinyStallChecks = 0;
  await page.waitForTimeout(5 * 60 * 1000); // let generation get underway (~5 min) before first check
  while (Date.now() - start < RESPONSE_TIMEOUT_MS) {
    await clearPopups(page);
    const stopping = await page.locator(STOP_BUTTON_SELECTOR).first().isVisible({ timeout: 2000 }).catch(() => false);
    const text = await lastAssistantText(page);
    console.log(`   …checked at ${Math.round((Date.now() - start) / 60000)} min: ${stopping ? 'still writing' : 'looks finished'} (${text.length} characters so far)`);
    if (!stopping && text.length > 500) {
      goneChecks++;
      if (goneChecks >= 2) return; // Stop button gone for ~2 checks → done
    } else {
      goneChecks = 0;
    }
    // Second, independent completion signal: the Stop-button check can get
    // stuck reporting "still writing" (a UI glitch) even though generation
    // actually finished. If the character count is IDENTICAL for 3 checks in
    // a row, treat that as done regardless of what the Stop button says.
    if (text.length > 500 && text.length === lastLength) {
      unchangedChecks++;
      if (unchangedChecks >= 3) {
        console.log('   Character count unchanged for 3 checks in a row — treating as finished.');
        return;
      }
    } else {
      unchangedChecks = 0;
    }
    // Stalled/dead generation: not actively streaming but far too short to be
    // a real 1,450-1,600 word article, and length hasn't moved. Without this,
    // a response stuck at e.g. 55 chars never crosses the 500-char threshold
    // above, so neither completion branch fires and this polls uselessly for
    // the full 30-min timeout before failing. Fail fast instead — the
    // caller's own per-row retry (blogGenLoop.ts) already retries once and
    // then moves on.
    if (!stopping && text.length > 0 && text.length < 500 && text.length === lastLength) {
      tinyStallChecks++;
      if (tinyStallChecks >= 2) {
        throw new Error(`STALLED: ChatGPT response stuck at ${text.length} characters across 2 consecutive checks — treating as a dead generation instead of waiting out the full timeout.`);
      }
    } else {
      tinyStallChecks = 0;
    }
    lastLength = text.length;
    await page.waitForTimeout(POLL_MS);
  }
}

async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    let text = msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '';
    if (text.replace(/\s/g, '').length < 100) {
      const body = (document.body as HTMLElement).innerText || '';
      const idx = body.lastIndexOf('Title:');
      if (idx >= 0) text = body.slice(idx);
    }
    return text;
  }, ASSISTANT_MESSAGE_SELECTOR);
}

/** Extract Title / Description / HTML from the last assistant message (both code-block and raw-HTML shapes). */
async function extractBlog(page: Page, fallbackTitle: string): Promise<{ title: string; description: string; html: string }> {
  const data = await page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    const last = msgs.length ? (msgs[msgs.length - 1] as HTMLElement) : null;
    let code = '';
    let text = last ? (last.innerText || '') : '';
    if (last) { const c = last.querySelector('pre code, pre'); code = c ? (c.textContent || '') : ''; }
    if (text.replace(/\s/g, '').length < 100) {
      const body = (document.body as HTMLElement).innerText || '';
      const idx = body.lastIndexOf('Title:');
      if (idx >= 0) text = body.slice(idx);
    }
    return { code, text };
  }, ASSISTANT_MESSAGE_SELECTOR);

  const text = data.text || '';
  const titleMatch = text.match(/^\s*Title:\s*(.+)$/im);
  const descMatch = text.match(/^\s*Description:\s*(.+)$/im);

  let html = '';
  if (data.code && data.code.includes('<')) {
    html = data.code.trim();
  } else {
    // Raw HTML in the message text: from the first tag to the last tag (drops
    // any trailing page chrome like "ChatGPT can make mistakes" / "Sources").
    const firstTag = text.indexOf('<');
    html = firstTag >= 0 ? text.slice(firstTag) : text;
    const lastTag = html.lastIndexOf('>');
    if (lastTag >= 0) html = html.slice(0, lastTag + 1);
    html = html.trim();
  }

  // ARTICLE_HTML mode returns ONLY the HTML fragment — no "Title:"/"Description:"
  // lines. Fall back to pulling those straight out of the HTML itself.
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const firstPMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const blogTitle = titleMatch ? titleMatch[1].trim() : (h1Match ? stripTags(h1Match[1]) : fallbackTitle);
  const description = descMatch ? descMatch[1].trim() : (firstPMatch ? stripTags(firstPMatch[1]).slice(0, 170) : '');

  return { title: blogTitle, description, html };
}

// A popup can still land exactly while extractBlog() reads the DOM (race
// between the poll loop above and the modal re-rendering). Clear popups,
// extract, clear again, and repeat until two consecutive extractions agree
// on HTML length — protects against a mid-scrape popup silently truncating
// the extracted HTML.
const MAX_EXTRACTION_STABILITY_CHECKS = 4;

async function extractBlogStable(page: Page, fallbackTitle: string): Promise<{ title: string; description: string; html: string }> {
  let last: { title: string; description: string; html: string } | null = null;
  let previousLen = -1;

  for (let i = 0; i < MAX_EXTRACTION_STABILITY_CHECKS; i++) {
    await clearPopups(page);
    last = await extractBlog(page, fallbackTitle);
    const len = last.html.length;
    console.log(`   [blog] Extraction check ${i + 1}/${MAX_EXTRACTION_STABILITY_CHECKS}: ${len} chars`);
    await clearPopups(page);
    if (len > 0 && len === previousLen) {
      console.log('   [blog] Char count stable across checks — accepting extraction.');
      return last;
    }
    previousLen = len;
  }

  console.log(`   [blog] Char count did not fully stabilize after ${MAX_EXTRACTION_STABILITY_CHECKS} checks — using last extraction anyway.`);
  return last!;
}

/** Fix ChatGPT quirks: mis-encoded closing quotes (%22) and web-search citation tags. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/%22(?=[\s>])/g, '"')   // closing attribute quote emitted as %22
    .replace(/%22$/g, '"')
    .replace(/\s*:contentReference\[[^\]]*\]\{[^}]*\}/g, '') // ChatGPT web-search citation artifacts
    .trim();
}

/**
 * Ensure every kenresearch.com link carries the correct UTM params — strips
 * whatever ChatGPT wrote and rebuilds fresh with the LinkedIn Pulse UTM
 * (matches every platform poster's own injectUTM call downstream).
 */
function injectBlogUtm(html: string): string {
  return injectUTM(html, UTM_PARAMS.LinkedinPulse);
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
}

async function waitUntilLoggedIn(page: Page): Promise<boolean> {
  if (await isLoggedIn(page)) {
    console.log('   ✅ ChatGPT: already logged in (session restored)');
    return true;
  }
  const loginBtn = page.locator(LOGIN_BUTTON_SELECTOR).first();
  if (await loginBtn.isVisible().catch(() => false)) await loginBtn.click().catch(() => {});
  console.log(`   ⚠️  ChatGPT: no active session — please log in manually in the open browser window (waiting up to ${MANUAL_LOGIN_TIMEOUT_MS / 1000}s)...`);
  try {
    await page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: MANUAL_LOGIN_TIMEOUT_MS });
    console.log('   ✅ ChatGPT: manual login detected — session saved for future runs');
    return true;
  } catch {
    return false;
  }
}
```

### `generateBlogViaChatGpt()` — full function (the `promptVersion` param/selection is the only change this session)

```ts
export async function generateBlogViaChatGpt(params: {
  title: string;
  url: string;
  accountHandle?: string;
  /** 'v1' (default) uses buildMasterBlogPrompt; 'v2' uses the keyword-focused buildMasterBlogPromptV2 — the two prompts stay fully separate, this only picks which one gets sent. */   // [NEW]
  promptVersion?: 'v1' | 'v2';   // [NEW]
}): Promise<{ title: string; description: string; html: string }> {
  const accountName = params.accountHandle || DEFAULT_BLOG_ACCOUNT;
  const sessionDir = sessionDirForAccount(accountName);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    if (!(await waitUntilLoggedIn(page))) {
      throw new Error(`ChatGPT (account "${accountName}"): not logged in and manual login was not completed in time.`);
    }

    const prompt = params.promptVersion === 'v2'                          // [NEW branch]
      ? buildMasterBlogPromptV2(params.title, params.url)                 // [NEW]
      : buildMasterBlogPrompt(params.title, params.url);
    console.log(`   [blog:${accountName}] Sending blog prompt for: "${params.title}" (~12-15 min generation)...`);
    await pasteIntoChatGptComposer(page, prompt);
    await page.waitForTimeout(1000);

    // The blocking modal can re-render itself seconds after being removed —
    // check again right before the send click, not just once before typing.
    await dismissBlockingModals(page);
    const sendBtn = page.locator(SEND_BUTTON_SELECTOR).first();
    async function clickSend(): Promise<boolean> {
      if (!(await sendBtn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
      await sendBtn.click();
      return true;
    }
    try {
      if (!(await clickSend())) await page.keyboard.press('Enter');
    } catch {
      await dismissBlockingModals(page);
      await page.waitForTimeout(1000);
      if (!(await clickSend())) await page.keyboard.press('Enter');
    }

    await waitForBlogCompletion(page);
    console.log(`   [blog:${accountName}] ChatGPT finished writing — extracting the blog...`);
    const { title, description, html } = await extractBlogStable(page, params.title);

    // The prompt instructs ChatGPT to return exactly this sentence (nothing
    // else) when it genuinely can't verify the primary report page after
    // retrying — detect it explicitly rather than relying only on the
    // length check below, since it could theoretically get wrapped in
    // enough surrounding text to slip past `html.length < 100` and get
    // saved as if it were real blog content.
    if (html.includes('RESEARCH BLOCKED') || html.includes('Primary report could not be verified')) {
      throw new Error(`RESEARCH_BLOCKED: ChatGPT could not verify the primary report page for "${params.title}" (${params.url}) — check the URL is reachable and correct.`);
    }

    if (!html || html.length < 100) {
      throw new Error('No HTML content extracted from ChatGPT response');
    }

    recordChatGptSuccess();
    return {
      title: sanitizeHtml(title),
      description: sanitizeHtml(description),
      html: injectBlogUtm(sanitizeHtml(html)),
    };
  } catch (err: any) {
    const { rotated, account } = recordChatGptFailure();
    if (rotated) err.message = `${err.message} (rotated out — next attempt uses "${account}")`;
    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}
```

Depends on (not modified this session, unfamiliar names flagged for the next session to check if needed): `src/config/chatGptAccountTracker.ts` (`sessionDirForAccount`, `recordChatGptFailure`, `recordChatGptSuccess` — per-account session dirs + failure-rotation bookkeeping), `src/utils/killChrome.ts` (`killChromeForProfile`), `src/utils/chatgptComposer.ts` (`pasteIntoChatGptComposer`, `dismissBlockingModals`), `src/utils/utm.ts` (`injectUTM`, `UTM_PARAMS`).

### V1 prompt — `buildMasterBlogPrompt(reportTitle, reportUrl): string`

This is the **original** master ChatGPT blog prompt, updated in place this session with the changes marked `[NEW]` below. Full current text:

```
KEN RESEARCH SERP AND AI CITATION MASTER BLOG PROMPT
HOW TO USE
Paste this prompt into a new chat and change only the final <INPUTS> block.
Use OUTPUT_MODE: ARTICLE_HTML for a clean article body.
Keep OUTPUT_MODE: ARTICLE_HTML for the normal publishing workflow. This is the default and safest mode.
Use OUTPUT_MODE: CMS_PACKAGE only when a JSON-aware automation will decode the response before publishing.
Use IMAGE_MODE: OFF for a completely text-only article.
The only mandatory inputs are REPORT_TITLE and REPORT_URL.
ROLE
You are a senior market-intelligence editor, research analyst, SEO strategist, answer-experience architect, fact-checker, and HTML publishing specialist for Ken Research.
Produce one publication-ready article that is genuinely useful to decision-makers, eligible for search discovery, easy for answer systems to interpret, and defensible under editorial review.
SEO, GAI/GEO/AIO, AXO/AEO, and E-E-A-T are quality disciplines, not ranking tricks. Do not promise rankings, Google AI Overview inclusion, featured snippets, or AI citations.
OUTCOME
Create an evidence-led market article of 1,450-1,600 visible words that:
Answers the market question quickly and accurately.
Uses one consistent set of market values, years, units, segments, and qualifiers.
Adds original commercial interpretation instead of paraphrasing the report page.
Distinguishes Ken Research estimates, official facts, company facts, and editorial inference.
Covers the main executive intents: definition, size, forecast, growth mechanisms, value migration, competition, regulation, risks, and actions.
Uses descriptive headings, compact evidence units, natural entity language, and source-adjacent attribution.
Includes only verified, relevant, crawlable links.
Returns the exact selected output format without commentary.
NON-NEGOTIABLE TRUST RULES
Never invent a figure, date, company, ranking, market share, segment position, regulation, programme, quote, respondent count, methodology, or URL.
Search-result snippets are discovery aids, not evidence. Open the source page.
Never use a competing market-research firm as a source or hyperlink destination.
Do not present an estimate or forecast as a completed fact.
Do not invent first-hand experience, analyst credentials, customer stories, or expert quotations.
If a material claim cannot be verified, omit it or use narrower qualitative wording.
Before concluding the primary report cannot be accessed, retry opening REPORT_URL at least 3 times across a few seconds apart — a single failed load is very often a transient network hiccup, a slow first response, or a temporary bot-check, not a real block. Also try opening the bare domain (kenresearch.com) and re-navigating from there if the direct URL fails. Only after multiple genuine, consistent failures to load ANY page on the domain — or after successfully loading the page and finding its content genuinely does not match the requested market/report — is this a real block.
If, after exhausting those retries, the primary report truly cannot be accessed or its core market identity cannot be verified, do not stop or refuse. Instead, search the open web for the same market (REPORT_TITLE, its geography, and its core scope) and assemble the DATA_SPINE from other reputable, live sources — industry associations, government/regulatory statistics, company filings, reputable trade press. Still write and frame the article as Ken Research's own market intelligence throughout (e.g. "Ken Research estimates...", "According to Ken Research..."), exactly as if the primary report page had loaded normally, using the best-verified web-sourced figures as that estimate. Never name or link to a competing market-research firm (Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, or similar) as a source — if a figure's only available attribution is one of those firms, use the figure without naming its source, or omit that specific claim rather than invent a number. Only return RESEARCH BLOCKED: Primary report could not be verified if the web search itself also fails to turn up any usable, verifiable data for this market — this should be rare.
KEN RESEARCH BRAND AUTHORITY RULES (MANDATORY — the finished article is run through an automated code validator that checks these exact rules and rejects the article if any fail)   [NEW]
Title: the H1 title must naturally contain the words "Ken Research".
Opening paragraph: paragraph 1 must (a) mention "Ken Research", (b) use an approved authority-context phrase from the approved list below in the same sentence, and (c) hyperlink that first Ken Research mention to a kenresearch.com destination (homepage or the primary report).
Approved expressions — use only these when referring to Ken Research as a source: "According to Ken Research analysis", "Ken Research market assessment indicates", "The Ken Research study highlights", "Ken Research estimates".
Banned expressions — never write these: "Ken Research says", "Ken Research thinks", "Ken Research provides reports".
Mention frequency: since this article is always 1,450-1,600 words (above the 1,200-word threshold), the text must contain between 2 and 4 total mentions of "Ken Research" (counting every occurrence in visible text, including the title) — never fewer than 2, never more than 4.
Promotional risk: never use the words "Buy", "Purchase", "Download now", or "Get report" anywhere in the article. Keep the tone strictly editorial.
Every Ken Research mention must be connected to evidence, market intelligence, analysis, or methodology — never a bare/promotional reference.
RESEARCH CONTRACT
Complete the following silently before drafting.
1. Resolve the market entity
Open REPORT_URL and resolve redirects to the final canonical Ken Research report page. If the first attempt fails to load, retry — do not treat one failed request as proof the page or domain is unreachable.
Confirm the exact market, geography, included products or services, excluded scope, currency, and forecast period.
Read the accessible summary, KPI cards, tables, charts, segmentation, competitive coverage, methodology, FAQs, and publication information.
2. Lock the DATA_SPINE
Record the verified values available for:
Base or historical value, currency, year, and status
Current estimate, when available
Forecast value, currency, and year
Published CAGR and exact period
Volume and unit, when available
Largest segment and segmentation dimension
Fastest-growing segment and segmentation dimension
Important demand, pricing, technology, channel, funding, trade, or regulatory indicators
Verified market participants
Verified methodology information
Every repeated figure must match this DATA_SPINE. Recalculate CAGR from the locked values as a reasonableness check, but do not replace a published rate merely because of normal rounding.
3. Build the CLAIM_LEDGER
For every candidate factual claim, record its source URL, publisher, date, geography, year, unit, status, scope, and permitted wording.
Use this source hierarchy:
Ken Research report page for proprietary market estimates, segmentation, forecast, competitive coverage, and methodology.
Government departments, regulators, national statistics offices, public agencies, and primary legal or policy documents.
Official company filings, releases, product pages, and investor materials for company-specific claims.
Recognized multilaterals and industry associations when stronger primary evidence is unavailable.
Reputable trade sources only for non-critical context that cannot be obtained from a primary source.
4. Resolve conflicts and freshness
Use the latest authoritative official source for external policy, demographic, regulatory, funding, budget, and programme facts.
Cross-check the Ken Research page's hero, KPI cards, tables, narrative, charts, and FAQs.
Never combine a value from one year with a CAGR or forecast from another data series.
If one page label conflicts with a consistent value-year combination repeated elsewhere, use the consistent combination and log the isolated label in SOURCE_QA.
If a contradiction cannot be resolved, omit the disputed detail.
Put a verified year beside time-sensitive claims. Avoid unsupported words such as "currently," "recently," or "today."
5. Build the INTENT_AND_ENTITY_MAP
Identify:
Primary query and exact market entity
Likely executive follow-up questions
Related entities, technologies, policies, channels, companies, and buyer groups
The one commercial thesis the evidence best supports
The strongest counter-risk to that thesis
Three stakeholder decisions the article should improve
Use natural entity language. Do not create separate paragraphs merely to target keyword variants.
6. Validate links
Open every intended destination and confirm successful loading, final canonical URL, page-title match, topic relevance, and support for the surrounding statement.
Reject guessed URLs, soft 404s, search pages, generic filter pages, login walls, empty pages, irrelevant redirects, shortened URLs, or fabricated report slugs.
7. Check cannibalization and content uniqueness
Search the Ken Research domain for an existing article targeting the same market and primary query.
If an existing page satisfies the same intent, design this article as a substantive update or choose a clearly distinct executive angle rather than creating a near-duplicate.
In CMS_PACKAGE mode, record the competing internal URL and recommended action in seo.cannibalization_alert.
Do not copy paragraphs from the report page or create near-identical versions for multiple publishing platforms.
SEARCH AND AI-ANSWER WRITING STANDARD
Answer-first construction
The first paragraph must answer what the market is, its verified size or status, forecast direction, and why the result matters.
The first paragraph after every H2 must answer that section's question in approximately 45-80 words.
Follow the answer with deeper evidence and implications. Do not bury the conclusion at the end.
Citation-ready evidence units
Build short, self-contained passages around one claim cluster:
State the claim with the entity, geography, year, and unit.
Attribute the evidence directly.
Explain the mechanism.
State the commercial implication or counter-risk.
Keep Ken Research estimates, official evidence, and analysis visibly distinct with wording such as:
"Ken Research estimates..."
"Official data from [agency] shows..."
"This suggests..."
Original value
The article must contribute at least three forms of original analytical value:
A causal explanation of what moves value, volume, margins, or access
A stakeholder-specific implication
A credible counterpoint, constraint, or downside scenario
Do not merely restate drivers, company names, and market figures from the report page.
E-E-A-T and trust signals
Use a supplied author or organization byline; never invent an analyst.
State the research basis, source types, and data status.
Preserve regulatory and programme status: proposal, recommendation, enacted rule, active programme, or historical measure.
Name sources and dates where they materially improve trust.
Use company claims only for that company and label them accordingly.
Treat trust as the priority when experience, expertise, authority, and promotional language conflict.
Readability and language
Write for senior executives in neutral, concrete language.
Keep paragraphs to two or three sentences and normally below 90 words.
Average roughly 16-24 words per sentence.
Use one idea per paragraph and one clear purpose per section.
Avoid vague consulting phrases, generic introductions, hype, keyword stuffing, and repeated strategic labels.
Do not use the same statistic and implication in more than two body locations, excluding one FAQ retrieval answer.
Use <strong> selectively for decisive values and conclusions, not every number.
NEW ARTICLE ARCHITECTURE
Use exactly one H1 and exactly seven H2 sections, in this fixed order and role.
H2 heading wording — do not default to the same literal H2 heading text article after article. Each "H2 N:" label below names that section's ROLE, not mandatory verbatim text — write a fresh, natural heading for this specific market that fulfills the role (often working in the market entity, geography, or the article's live theme) instead of reusing a stock phrase every time. Keep the section order and count fixed; vary only the wording.   [NEW]
Hero image, conditional
If IMAGE_MODE: ON and HERO_IMAGE_URL passes validation, place a verified hero image before the H1. If the image fails, omit it silently. If IMAGE_MODE: OFF, output no image tags or image discussion.
H1 — MANDATORY TWO-CLAUSE TITLE FORMAT (overrides any generic headline length/shape guidance elsewhere)   [NEW — replaced old "50-60 char" rule]
The H1 always has exactly two clauses joined by " : " (space, colon, space). Never omit the colon clause — a title without it fails validation.
Clause 1 — the market-size headline:
{GEOGRAPHY} {MARKET NAME} Market {Nears|Hits} USD {VALUE}{B|M}
Use "Nears" when the headline value is an approaching/forecast figure not yet reached. Use "Hits" when the headline value is a current/achieved figure.
{VALUE}{B|M} format: "USD" followed by the number then immediately "B" (billion) or "M" (million) with no space before the letter — e.g. "USD 5.83B", "USD 211B", "USD 99.1M", "USD 1.6B", "USD 14M". Use one or two decimal places only when the verified figure needs them; whole numbers stay whole (e.g. "USD 211B", not "USD 211.0B").
Geography is the short verified market geography (e.g. "India", "Global", "Vietnam", "Thailand", "Middle East", "APAC", "Kuwait"). Market Name is the concise verified market/report entity.
Clause 2 — the Ken Research analytical hook, in one of exactly two patterns:
Pattern A (Tracks): Ken Research Tracks a/an {2-4 word Insight Noun Phrase}
  Example insight phrases: "a Compliance Race", "a Counterfeit Risk", "a Workforce Gap", "an IT Talent Gap", "a Gastroenterologist Shortage", "a Consolidation Wave", "a Channel Shift", "a Compliance Filter", "a Regulatory Divide".
Pattern B (Flags): Ken Research Flags {Factor} as the Real|Bigger {Consequence Noun Phrase}
  Example: "Ken Research Flags SME Financing as the Real Modernization Bottleneck", "Ken Research Flags Price Volatility as the Bigger Risk", "Ken Research Flags Brand Concentration as the Real Entry Barrier".
Choose whichever pattern the article's strongest counter-risk/thesis fits more naturally — the insight phrase (Pattern A) or factor+consequence (Pattern B) must genuinely reflect the counter-risk identified in the RESEARCH CONTRACT and Decision Framework sections, never a generic or unrelated phrase.
Title-case both clauses (capitalize major words); keep small connector words ("a", "an", "as", "the") lowercase except when starting a clause.
Full worked examples (format only — do not reuse the figures):
"India Sustainable Packaging Market Nears USD 5.83B : Ken Research Tracks a Compliance Race"
"Global Fried Onion Market Hits USD 4.9B : Ken Research Flags Price Volatility as the Bigger Risk"
Do not use vague trend-only endings such as "Shifts to Powered Care," "Enters a New Era," or "Growth Accelerates" in place of clause 2 — clause 2 must always be the "Ken Research Tracks/Flags ..." structure above.
Typical total length runs 80-100 visible characters; up to ~130 is acceptable for a longer Pattern B consequence phrase. There is no fixed 50-60 character cap — the two-clause structure and clarity take priority over brevity.
Wrap only "USD {VALUE}{B|M}" in <strong> inside the H1; leave the rest of the H1 unformatted.
No byline   [NEW]
Never output a byline paragraph (e.g. "By Ken Research", "By [Author]", or any variant) anywhere in the article, regardless of SHOW_BYLINE or AUTHOR_NAME field values. The article body goes directly from the H1 into the opening abstract paragraph.
No citation-tool artifacts   [NEW]
Never output raw citation/browsing-tool markup such as ":contentReference[oaicite:0]{index=0}", "[oaicite:...]", or any other bracket-style citation residue. If a claim needs a source, express it in plain prose (e.g. "According to Ken Research analysis...") or as a proper <a> hyperlink per the LINK ARCHITECTURE rules — never as leftover tool syntax. Reread the full response before returning it and strip any such artifact if one appears.
Opening abstract
Write two paragraphs totaling approximately 140-180 words.
Paragraph 1:
Answer the market definition, size or current status, forecast direction, and time period.
Link the first natural Ken Research mention to the homepage.
Link the market name to the primary report in a separate sentence.
Use no more than three core statistics.
Paragraph 2:
State the main growth mechanism, counter-risk, and central commercial thesis.
Do not summarize every later section.
H2 1: Market Definition and Evidence Snapshot
Begin with a one-sentence definition that clarifies what is included and, when necessary, excluded.
Add exactly five concise bullets: current/base value, forecast and CAGR period, segment structure, one official external signal, and the central implication or risk.
Use complementary evidence rather than repeating the opening word for word.
If IMAGE_MODE: ON and SNAPSHOT_IMAGE_URL passes validation, place it after the definition and before the bullets.
H2 2: Growth Mechanisms and Market Economics
Use two or three H3 subsections selected for the market, covering ground such as:
what is expanding the demand base
how price and volume are interacting
which technology, funding, replacement, or channel mechanism matters most
H3 phrasing is not required to be a question every time — use a question, a direct statement, or a short thematic label, whichever reads most naturally for that specific point; do not mechanically convert every H3 into a question just for formatting consistency, and do not phrase all H3s in a section the same way.   [NEW — H3s no longer forced to always be questions]
Each subsection must move from evidence to mechanism to commercial consequence.
H2 3: Where Market Value Is Moving
Use two H3 subsections to explain the most decision-relevant shifts across product, technology, application, end user, channel, geography, or price tier. Same H3-phrasing freedom as above — question, statement, or label, whichever fits.
Identify the segmentation dimension explicitly.
Distinguish largest from fastest-growing.
Explain buyer behaviour and why the mix shift matters.
Do not list every segment.
H2 4: Competition, Regulation and Entry Barriers
Use two or three H3 subsections. Same H3-phrasing freedom as above.
Discuss only verified participants and treat them as unranked unless shares or rankings are sourced.
Explain the real basis of competition: access, distribution, service, pricing, technology, procurement, compliance, or customer relationships.
Explain the most material regulation, policy, funding rule, trade condition, or barrier to entry using an official source.
Include the strongest risk to the article's thesis.
After this section, include CTA 1 linking to the canonical primary report. The anchor must describe the destination accurately.
H2 5: Decision Framework and Market Outlook
Use exactly two H3 subsections:
Decision Framework
Signals to Monitor
Requirements:
Translate the evidence into exactly three stakeholder actions.
Present a measured base-case direction and two conditions that could strengthen or weaken it. Do not invent probabilities.
Identify leading indicators to monitor through the forecast period.
Add one or two relevant Ken Research cluster links only when they give useful adjacent-market context.
After this section, include CTA 2 linking to the Ken Research Talk to Us destination. Use exactly one of these two verified URLs (either is acceptable — do not invent or use any other "talk to us"/"contact" URL): https://www.kenresearch.com/book-a-discovery-call or https://www.kenresearch.com/custom-form, each with the mandatory UTM string appended as usual. Keep it consultative.   [NEW — Talk to Us URL locked to these 2 exact options; previously unspecified]
H2 6: Frequently Asked Questions
Include exactly five unique FAQ pairs. Use an H3 question and one 45-65-word answer for each.
Cover:
Market definition and scope
Size, year, and data status
Forecast value and CAGR period
Segment, competition, or regulation
Primary opportunity or risk
Question format — mandatory: prefix every H3 question with its number in the form "Q1:", "Q2:", "Q3:", "Q4:", "Q5:" (in order), followed by a space, then the question text. Each question must explicitly include the exact market name (e.g. "the Global Welded Metal Bellow Market") rather than a vague pronoun like "the market" or "this segment", and must be phrased the way a real executive searcher would type or ask it — matching the underlying search/answer intent for that FAQ topic (definition intent, sizing intent, forecast intent, segmentation/competition intent, opportunity/risk intent), not a generic templated phrasing.   [NEW — Q1-Q5 numbering + market-name + intent requirement]
Example: "Q2: How Large Is the Global Welded Metal Bellow Market in 2025?" — not "Q2: How large is the market?".
Answer directly in the first sentence. Do not add unsupported facts.
FAQ interlinking — mandatory: include exactly two Ken Research hyperlinks across the five FAQ answers — one link each inside two different answers (never both links in the same answer, never more than two total in this section). Link to the primary report or a genuinely relevant Ken Research cluster page, using the same UTM rules as the rest of the article. Use descriptive market-topic anchor text for these two links (e.g. the market/report name) rather than the literal words "Ken Research" — this keeps the article's total "Ken Research" mention count within the mandatory brand-frequency band above. The other three answers stay link-free.   [NEW — 2 FAQ interlinks added]
H2 7: Methodology and Sources
Reserve approximately 110-150 words for this final section and write three complete paragraphs:
Research Basis: verified Ken Research methodology and validation information.
Sources: primary report attribution plus the most important official source publishers. Include the third primary-report link placement here.
Disclaimer: a concise statement that the article is for informational purposes and that readers should consult the full report or relevant professionals before making decisions.
Do not claim a confidence level unless the report publishes one.
Do not add a separate caveats section. The article is not complete until the Disclaimer paragraph is fully written and closed with </p>.
COMPLETION LOCK
Draft all seven H2 sections before returning any output.
Reserve the final 110-150 visible words for Methodology and Sources.
If the response approaches the length limit, compress earlier analysis. Never truncate the final section, FAQ answers, CTAs, source attribution, or disclaimer.
The final HTML element must be the complete Disclaimer paragraph.
The final non-whitespace characters in ARTICLE_HTML mode must be </p>.
Count opening and closing <p>, <h1>, <h2>, <h3>, <ul>, <li>, <a>, <strong>, and <em> tags. Every opened tag must close.
Do not return a partial article under any circumstance.
LINK ARCHITECTURE
The finished article must contain 12-14 Ken Research link placements, separate from official external citations.   [NEW — was 10-12, raised to account for the +2 FAQ links]
Required Ken Research distribution:
Ken Research homepage: exactly one placement in the opening
Canonical primary report: exactly three placements in the opening, CTA 1, and Sources paragraph
Ken Research Talk to Us: exactly one placement in CTA 2, using either https://www.kenresearch.com/book-a-discovery-call or https://www.kenresearch.com/custom-form (with UTM) — never any other "talk to us"/"contact"/"custom form" URL
Frequently Asked Questions: exactly two placements, one each inside two different FAQ answers   [NEW]
Relevant Ken Research cluster pages: five to seven placements using five to seven unique destinations
Total Ken Research placements: exactly 12-14
Total unique Ken Research destinations: at least eight
Use one or two unique official government, regulator, national-statistics, or public-agency links, with two preferred when two strong and directly relevant sources exist. Never use more than two official external citations. These external citations do not count toward the 12-14 Ken Research placements.
After drafting, count all official external <a> tags. The article passes only when the count is one or two; zero or more than two fails validation.
Distribute internal links across the article:
Opening: homepage and primary report
Market Definition and Evidence Snapshot: one relevant cluster page
Growth Mechanisms and Market Economics: one or two relevant cluster pages
Where Market Value Is Moving: one or two relevant cluster pages
Competition, Regulation and Entry Barriers: one relevant cluster page plus primary-report CTA 1
Decision Framework and Market Outlook: one or two relevant cluster pages plus Talk to Us CTA 2
Frequently Asked Questions: two links, one each inside two different FAQ answers (primary report or a relevant cluster page)   [NEW]
Methodology and Sources: primary report
Prioritize actual related Ken Research report pages. A verified sector, service, report-store category, or Competition Benchmarking page may be used only when it directly fits the surrounding discussion. Never use a generic page merely to reach the count.
If five unique relevant cluster destinations cannot be verified, continue researching. Never guess a URL or silently publish below the internal-link target. If the minimum cannot be satisfied, return only: LINK VALIDATION BLOCKED: Fewer than 12 verified Ken Research link placements.
Competitor market-research domains are prohibited.
Link quality
Use concise descriptive anchor text, not "click here," "read more," naked URLs, or repeated exact-match anchors.
Place the link next to the claim or context it supports.
Do not put two links in one sentence.
Prefer one link per paragraph.
Related Ken Research pages must be verified, genuinely relevant, and contextually introduced.
External factual links must point to direct primary pages, not government homepages when a specific page is available.
Mandatory UTM rule — EXACT, byte-for-byte, no exceptions
Every Ken Research hyperlink must end with this EXACT UTM string, character for character, with absolutely nothing changed, added, removed, re-encoded, or reordered:
?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation
Example — for the report https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market, the final href must be exactly:
https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation
Rules:
Only the base URL (the domain + path, e.g. https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market) may vary from link to link. The UTM string itself — ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation — must be pasted identically on every single Ken Research link, with zero variation.
Use a literal "?" to join the base URL and the UTM string — never "&", never "&amp;", never a second "?".
Use a literal "&" between utm_medium and utm_campaign — never "&amp;", never any HTML-entity encoding.
Do not change letter casing anywhere in the UTM string. Do not add, drop, duplicate, or reorder any of the three parameters.
If the base URL already ends with a "/", still join with a single "?" — never leave a stray "/" or "&" before the UTM string.
Apply this to all 12-14 Ken Research placements, including homepage, primary report, related pages, FAQ links, and Talk to Us.
Do not add any query parameters to official external sources.
Reopen every tracked URL and verify it reaches the intended page AND ends with exactly ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation.
Reject any Ken Research <a> tag whose href does not end with that exact UTM string.
Link markup
For LINK_STYLE_MODE: CMS, use clean crawlable anchors:
<a href='FINAL_URL'><strong>DESCRIPTIVE ANCHOR</strong></a>
For LINK_STYLE_MODE: INLINE, use:
<a href='FINAL_URL' style='color:#0645AD; font-weight:700; text-decoration:underline;' target='_blank' rel='noopener'><strong>DESCRIPTIVE ANCHOR</strong></a>
Use single quotation marks for HTML attributes.
IMAGE RULES
When IMAGE_MODE: OFF:
Output no image tags.
Do not search for, request, generate, or mention images.
When IMAGE_MODE: ON:
Use only supplied image URLs.
Confirm a successful image response and inspect the image.
Reject broken, unreadable, misspelled, truncated, contradictory, outdated, or fabricated visual data.
Prefer a 16:9 hero image at least 1200 pixels wide.
Write concise descriptive alt text based on the actual visual and market entity.
Do not stuff keywords or place unsupported figures in alt text.
Hero markup:
<img src='HERO_IMAGE_URL' alt='VERIFIED DESCRIPTIVE ALT' loading='eager'/>
Snapshot markup:
<img src='SNAPSHOT_IMAGE_URL' alt='VERIFIED DESCRIPTIVE ALT' loading='lazy'/>
OUTPUT MODES
ARTICLE_HTML
Return only one clean HTML fragment.
Put each block element on a new real line.
Never output the literal character sequences \n, \r, or \t.
Do not JSON-escape the HTML.
Allowed tags:
<img>, <h1>, <h2>, <h3>, <p>, <ul>, <li>, <a>, <strong>, <em>
Do not output Markdown, code fences, full HTML document wrappers, meta tags, CSS blocks, JavaScript, schema, comments, tables, footnotes, internal ledgers, or commentary.
The response must begin with < and end with the final </p> from the completed Disclaimer paragraph.
CMS_PACKAGE
Return one valid JSON object with exactly these keys:
seo
schema
source_qa
link_manifest
article_html
seo must include:
meta_title: 50-60 characters and include the strongest verified numerical hook
meta_description: 145-155 characters
slug: concise lowercase hyphenated slug
canonical_url: supplied value or null
primary_keyword: exact market entity
secondary_entities: five to eight verified related entities
excerpt: 150-170 characters
author_name: supplied value or null
published_date: supplied value or null
updated_date: supplied value or null
featured_image_alt: verified value or null
cannibalization_alert: verified competing internal URL and recommendation, or null
post_publish_checks: an array covering indexability, canonical rendering, sitemap inclusion, mobile content parity, Core Web Vitals, schema validation, image fetchability, and crawlable internal links
schema must include article, faq, and breadcrumb fields.
If CMS_GENERATES_SCHEMA: YES, return null for all three.
If CMS_GENERATES_SCHEMA: NO, generate valid JSON-LD only when required author, date, canonical URL, image, and breadcrumb inputs are available.
Schema must match visible content exactly. Do not invent missing fields.
Do not create special "AI schema"; use only valid structured data supported by the visible page.
source_qa must be an array of verified source-page contradictions, each containing issue, locations, safe_article_value, and recommended_fix. Use an empty array when none are found.
link_manifest must list each final link's type, anchor, url, section, and verification_status.
article_html must contain the complete validated article as one continuous JSON string. Do not insert \n, \r, or \t escape sequences. The JSON-aware consumer must decode this field before publishing; never publish the raw JSON representation.
PUBLISHING DEPENDENCIES OUTSIDE THE ARTICLE
The content cannot rank or become eligible for AI features if the published page is inaccessible or technically ineligible. The CMS or SEO workflow must separately verify after publication:
The final URL returns HTTP 200 and is not blocked by robots rules or noindex.
The page declares the intended canonical URL.
The same primary content and structured data are available on mobile.
The URL is discoverable through crawlable internal links and the XML sitemap.
Core Web Vitals and general page experience are acceptable.
Images are publicly fetchable, correctly sized, and not blocked.
Structured data parses successfully and matches visible content.
Updated dates change only after a meaningful content revision.
FINAL QA GATE
Before returning the deliverable, verify:
Evidence
Every factual claim has a source in the CLAIM_LEDGER.
Market values, years, currency, volume, CAGR period, and segment dimensions are consistent.
Estimates, forecasts, official facts, company facts, and inference are labelled correctly.
No search snippet, competitor report, fabricated URL, unsupported ranking, or invented methodology remains.
Report-page inconsistencies are resolved safely or omitted and logged.
Search and answer quality
The H1 follows the mandatory two-clause "{Geography} {Market} Market Nears/Hits USD {Value}{B|M} : Ken Research Tracks/Flags ..." format, contains the market entity, and includes the strongest verified numerical hook.   [NEW]
The article has exactly seven H2 sections and five FAQs.
Each H2 begins with a direct answer.
The market scope is explicitly defined.
Important claims include entity, geography, year, unit, and attribution where applicable.
The article contains original mechanisms, stakeholder implications, and a counter-risk.
No section repeats another section's full fact-and-implication pair.
The article does not duplicate an existing Ken Research page targeting the same intent without a distinct update or angle.
Language is natural, specific, neutral, and free of keyword stuffing.
Visible article length is 1,450-1,600 words.
Links and images
Every link loads, matches its destination, and uses descriptive anchor text.
No competitor market-research link exists.
The article contains exactly 12-14 Ken Research link placements (including exactly two inside the FAQ section) and at least eight unique Ken Research destinations.   [NEW — was 10-12]
The primary report appears exactly three times; homepage and Talk to Us appear exactly once each.
Five to seven unique verified Ken Research cluster destinations are used contextually.
One or two unique official external citations are present and counted separately; the count never exceeds two.
Every Ken Research href ends with exactly ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation — no &amp; entities, no extra "?" or "&", no casing changes.
Official external links contain no UTM parameters.
Image mode and image validation rules are satisfied.
Technical package
Article HTML uses only allowed tags and valid nesting.
All seven H2 sections, five FAQs, two CTAs, Research Basis, Sources, and Disclaimer are complete.
Every opened HTML tag closes, and the final HTML element is the complete Disclaimer paragraph ending with </p>.
ARTICLE_HTML mode uses real line breaks and contains no literal \n, \r, or \t sequences.
ARTICLE_HTML mode contains no metadata or schema.
CMS_PACKAGE mode parses as JSON and contains exactly the required keys.
CMS_PACKAGE article_html is complete and contains no newline escape sequences.
Metadata character limits are met.
Cannibalization alerts and post-publish technical checks are present in CMS_PACKAGE mode.
Schema is absent when CMS-generated or when required inputs are missing.
Schema and FAQs match visible content exactly.
FINAL RESPONSE
For OUTPUT_MODE: ARTICLE_HTML, return only the validated HTML fragment.
For OUTPUT_MODE: CMS_PACKAGE, return only the validated JSON object.
Do not add explanations, research notes, validation results, or Markdown fences.
<INPUTS> REPORT_TITLE: ${reportTitle} REPORT_URL: ${reportUrl}
OUTPUT_MODE: ARTICLE_HTML
LINK_STYLE_MODE: CMS
IMAGE_MODE: OFF
HERO_IMAGE_URL:
SNAPSHOT_IMAGE_URL:
SHOW_BYLINE: OFF   [NEW — was ON, flipped since bylines are now unconditionally banned]
AUTHOR_NAME: Ken Research
PUBLISHED_DATE:
UPDATED_DATE:
CANONICAL_BLOG_URL:
BREADCRUMB_PARENT_URL:
CMS_GENERATES_SCHEMA: YES
</INPUTS>
```

### V2 prompt — `buildMasterBlogPromptV2(reportTitle, reportUrl): string`

**A complete, independent copy of V1** — not derived from it, never sharing code, per explicit requirement ("we will not mix both" — if V1 or V2 need editing later, edit only the intended function). Identical to V1 above **except**:

1. Title line changed to `KEN RESEARCH SERP AND AI CITATION MASTER BLOG PROMPT (V2 — KEYWORD-FOCUSED H2s)`.
2. The `NEW ARTICLE ARCHITECTURE` section's H2-heading-wording rule is replaced with:

```
H2 KEYWORD REQUIREMENT (SEO indexing — the defining rule of this V2 prompt): at least four of the seven H2 headings must naturally include the primary target keyword phrase: {Geography} + {Market Name} (e.g. "UK Zipper Market", "the Zipper Market in the UK", "UK's Zipper Sector") — use the exact geography and market entity from REPORT_TITLE/REPORT_URL, not a placeholder. Rotate which grammatical form is used heading to heading and article to article (exact phrase, possessive form, geography-first, market-first, with or without "the") so headings read naturally rather than as mechanically repeated keyword stuffing. Every H2 must still read as a real, natural heading a human editor would write — never sacrifice grammar or clarity just to fit the keyword in. Each "H2 N:" label below names that section's ROLE, not mandatory verbatim text — write a fresh heading for this specific market that fulfills the role AND satisfies this keyword requirement where it applies. Keep the section order and count fixed; vary only the wording.
```

3. The H1's Geography example list adds `"UK"`.
4. The `SEARCH AND AI-ANSWER WRITING STANDARD` → Readability paragraph drops "keyword stuffing" from its avoid-list (since V2 deliberately does controlled keyword placement) and the INTENT_AND_ENTITY_MAP step drops the "Do not create separate paragraphs merely to target keyword variants" line.
5. `FINAL QA GATE` → Search and answer quality gains a line: `At least four H2 headings naturally include the {Geography} + {Market Name} keyword phrase, in varied grammatical forms, without reading as keyword-stuffed.` and the "free of keyword stuffing" line is scoped to `free of generic keyword stuffing outside the mandatory H2 keyword requirement above`.

Everything else — brand authority rules, H1 two-clause format, no-byline, no-citation-artifacts, FAQ Q-numbering + interlinking, LINK ARCHITECTURE (12-14 links), UTM rules, output modes, FINAL QA GATE — is byte-identical to V1.

### Wiring

```ts
// blogGenAgent.ts
export async function generateBlogViaChatGpt(params: {
  title: string;
  url: string;
  accountHandle?: string;
  promptVersion?: 'v1' | 'v2'; // default 'v1'
}): Promise<{ title: string; description: string; html: string }> {
  ...
  const prompt = params.promptVersion === 'v2'
    ? buildMasterBlogPromptV2(params.title, params.url)
    : buildMasterBlogPrompt(params.title, params.url);
  ...
}
```

### Full orchestration layer — `src/coordinator/blogGenLoop.ts` (verbatim; the `promptVersion` random pick is the only change this session)

```ts
/**
 * blogGenLoop.ts — autorun: picks "New Logic" rows that have a Target URL
 * but no Blog Content yet, generates the article and cover image
 * CONCURRENTLY in two separate Chrome windows (blogGenAgent.ts /
 * blogImageAgent.ts each launch their own persistent context), writes the
 * result back, then re-reads that same cell from the sheet to verify it
 * actually landed with real content before moving on to the next row.
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
import { validateBrandAuthority } from '../agents/blogBrandValidator.js';
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

        // Randomly pick V1 (buildMasterBlogPrompt) or V2 (keyword-focused
        // buildMasterBlogPromptV2) per row — the two prompts stay fully
        // separate in blogGenAgent.ts, this just rotates which one runs.   [NEW]
        const promptVersion: 'v1' | 'v2' = Math.random() < 0.5 ? 'v1' : 'v2';   // [NEW]
        console.log(`   Prompt version: ${promptVersion}`);   // [NEW]

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
            generateBlogViaChatGpt({ title, url: row.targetUrl, accountHandle: opts.blogAccountHandle, promptVersion }),   // promptVersion added [NEW]
          ]);
          coverImageUrl = imgResult;
          blog = blogResult;
        } else {
          blog = await generateBlogViaChatGpt({ title, url: row.targetUrl, accountHandle: opts.blogAccountHandle, promptVersion });   // promptVersion added [NEW]
        }

        const htmlWithImage = coverImageUrl ? injectCoverImage(blog.html, coverImageUrl, title) : blog.html;

        const sanity = runBlogSanityChecks(htmlWithImage, { title });
        if (sanity.changes.length > 0) {
          console.log(`   [BLOG SANITY] Applied: ${sanity.changes.join(', ')}`);
        }

        const brandCheck = validateBrandAuthority(sanity.html, { title: blog.title || title });
        if (brandCheck.status !== 'PASS') {
          const issueSummary = brandCheck.issues.map((i) => `${i.rule}: ${i.problem}`).join(' | ');
          throw new Error(`BRAND_VALIDATION_FAILED (score ${brandCheck.score}/10): ${issueSummary}`);
        }
        console.log(`   [BRAND CHECK] PASS (score ${brandCheck.score}/10)`);

        await saveGeneratedBlogToPool(row, { coverImageUrl, html: sanity.html }, 'newLogic');

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
```

Manual CLI (`src/tools/generateBlogAndImage.ts`) has a `--v2` flag:
```bash
node --import=tsx src/tools/generateBlogAndImage.ts --title "..." --url "..." [--with-image] [--v2]
```

### Validation/sanitization pipeline

**`src/agents/blogBrandValidator.ts`** (new file this session) — pure function, mirrors the prompt's brand rules in code as a second, independent check. Full source, verbatim:

```ts
/**
 * blogBrandValidator.ts — Ken Research brand-authority compliance gate.
 * Runs after blogSanityAgent.ts's HTML cleanup but before a generated blog
 * is saved to the sheet. Implements the checks from
 * ken-brand-authority-layer-SKILL.md / ken-brand-authority-validator.md:
 * title branding, opening-paragraph branding + hyperlink, word-count-based
 * mention frequency, brand-quality wording, and promotional-risk language.
 *
 * blogGenAgent.ts's own ChatGPT master prompt already enforces a much
 * stricter link architecture (10-12 links, exact UTM string) — this module
 * is an independent, code-side second check on top of that, per the
 * Generate -> Brand Validator -> Publish/Rewrite flow in
 * claude-code-integration-instructions.md.
 */

export interface BrandValidatorContext {
  title?: string;
}

export interface BrandIssue {
  rule: string;
  problem: string;
  fix: string;
}

export interface BrandValidationResult {
  status: 'PASS' | 'REWRITE_REQUIRED';
  score: number;
  issues: BrandIssue[];
}

const BRAND_RE = /Ken\s+Research/gi;
const KENRESEARCH_LINK_RE = /<a\b[^>]*href\s*=\s*(['"])(?:(?!\1).)*kenresearch\.com(?:(?!\1).)*\1[^>]*>/i;

// Wording the SKILL doc flags as low-value / non-editorial.
const AVOID_PHRASES = [/Ken\s+Research\s+says/i, /Ken\s+Research\s+thinks/i, /Ken\s+Research\s+provides\s+reports/i];

// Authority-context signal words expected around a Ken Research mention.
const AUTHORITY_CONTEXT_RE = /(according to|analysis|assessment|estimates?|study|research indicates|market intelligence|methodology)/i;

const PROMOTIONAL_RE = /\b(buy|purchase|download now|get report)\b/gi;

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function visibleWordCount(html: string): number {
  const text = stripTags(html);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function firstParagraph(html: string): string {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return match ? match[1] : '';
}

function mentionBounds(wordCount: number): { min: number; max: number } {
  if (wordCount > 1200) return { min: 2, max: 4 };
  if (wordCount >= 900) return { min: 2, max: 3 };
  return { min: 1, max: 2 };
}

/**
 * Validate a finished blog article (title + sanitized HTML body) against the
 * Ken Research brand-authority rules. Pure function — no I/O, no mutation.
 */
export function validateBrandAuthority(html: string, ctx: BrandValidatorContext = {}): BrandValidationResult {
  const issues: BrandIssue[] = [];
  const title = (ctx.title || '').trim();

  // 1. Title validation
  if (!BRAND_RE.test(title)) {
    issues.push({
      rule: 'title-branding',
      problem: `Title does not contain "Ken Research": "${title}"`,
      fix: 'Rework the title to naturally include "Ken Research".',
    });
  }
  BRAND_RE.lastIndex = 0;

  // 2. Opening paragraph validation
  const opening = firstParagraph(html);
  const openingText = stripTags(opening);
  if (!openingText) {
    issues.push({
      rule: 'opening-paragraph',
      problem: 'No opening <p> paragraph found to validate.',
      fix: 'Ensure the article body starts with a <p> paragraph.',
    });
  } else {
    if (!BRAND_RE.test(openingText)) {
      issues.push({
        rule: 'opening-paragraph-mention',
        problem: 'Opening paragraph does not mention Ken Research.',
        fix: 'Add a Ken Research mention with authority context to the opening paragraph, e.g. "According to Ken Research analysis...".',
      });
    }
    BRAND_RE.lastIndex = 0;
    if (!KENRESEARCH_LINK_RE.test(opening)) {
      issues.push({
        rule: 'opening-paragraph-link',
        problem: 'Opening paragraph is missing a hyperlink to a kenresearch.com destination.',
        fix: 'Hyperlink the first Ken Research mention to https://www.kenresearch.com/ or the relevant report URL.',
      });
    }
    if (BRAND_RE.test(openingText) && !AUTHORITY_CONTEXT_RE.test(openingText)) {
      issues.push({
        rule: 'opening-paragraph-authority-context',
        problem: 'Ken Research mention in the opening paragraph lacks authority context (analysis/estimates/methodology wording).',
        fix: 'Rephrase using an approved expression, e.g. "According to Ken Research analysis..." or "Ken Research estimates...".',
      });
    }
    BRAND_RE.lastIndex = 0;
  }

  // 3. Word-count-based brand frequency
  const wordCount = visibleWordCount(html);
  const mentionCount = (stripTags(html).match(BRAND_RE) || []).length;
  const { min, max } = mentionBounds(wordCount);
  if (mentionCount < min) {
    issues.push({
      rule: 'brand-frequency-min',
      problem: `Only ${mentionCount} Ken Research mention(s) across ${wordCount} words — minimum is ${min}.`,
      fix: `Add ${min - mentionCount} more Ken Research mention(s), each connected to evidence/analysis, not repetition for its own sake.`,
    });
  }
  if (mentionCount > max) {
    issues.push({
      rule: 'brand-frequency-max',
      problem: `${mentionCount} Ken Research mentions across ${wordCount} words exceeds the maximum of ${max}.`,
      fix: `Remove or consolidate ${mentionCount - max} mention(s) to avoid excessive promotional repetition.`,
    });
  }

  // 4. Brand quality validation
  for (const re of AVOID_PHRASES) {
    if (re.test(html)) {
      issues.push({
        rule: 'brand-quality',
        problem: `Low-value/non-editorial Ken Research phrasing found matching /${re.source}/.`,
        fix: 'Use an approved expression such as "According to Ken Research analysis" or "Ken Research estimates".',
      });
    }
  }

  // 5. Link validation — at least one Ken Research link somewhere in the article.
  if (!KENRESEARCH_LINK_RE.test(html)) {
    issues.push({
      rule: 'link-presence',
      problem: 'No hyperlink to a kenresearch.com destination found anywhere in the article.',
      fix: 'Add at least one hyperlink to https://www.kenresearch.com/ or a relevant report URL, starting with the first Ken Research mention.',
    });
  }

  // 6. Promotional risk check
  const promoMatches = stripTags(html).match(PROMOTIONAL_RE);
  if (promoMatches && promoMatches.length > 0) {
    issues.push({
      rule: 'promotional-risk',
      problem: `Promotional language found: ${[...new Set(promoMatches.map((m) => m.toLowerCase()))].join(', ')}.`,
      fix: 'Rewrite in editorial voice — remove direct calls-to-action like "Buy", "Purchase", "Download now", "Get report".',
    });
  }

  const criticalRules = new Set(['title-branding', 'opening-paragraph', 'opening-paragraph-mention', 'opening-paragraph-link', 'link-presence']);
  const criticalFailures = issues.filter((i) => criticalRules.has(i.rule)).length;
  const score = Math.max(0, 10 - issues.length - criticalFailures); // critical failures cost double

  const status: 'PASS' | 'REWRITE_REQUIRED' = score >= 9 && criticalFailures === 0 ? 'PASS' : 'REWRITE_REQUIRED';

  return { status, score, issues };
}
```

**`src/agents/blogSanityAgent.ts`** — 4 mechanical HTML cleanup rules run in order (`normalizeImgTags`, `removeByline`, `boldAllNumbers`, `removeDisclaimer`). Full source, verbatim (only `removeByline` changed this session, marked below):

```ts
/**
 * blogSanityAgent.ts — post-generation cleanup pass for blog HTML.
 * Runs after ChatGPT generation (and cover-image injection) but BEFORE the
 * result is written into the sheet. Each rule is a small, independent
 * html -> html transform, applied in order — add new rules to RULES to
 * extend this later without touching the call sites.
 */

export interface BlogSanityContext {
  /** Used to build the fallback img alt text ("<title> market research"). */
  title?: string;
}

export interface BlogSanityResult {
  html: string;
  changes: string[];
}

// Rule 1 — normalize every <img> tag to the exact canonical shape:
//   <img src='URL' alt='ALT market research'/>
function normalizeImgTags(html: string, ctx: BlogSanityContext): { html: string; changed: boolean } {
  let changed = false;
  const fallbackAltBase = (ctx.title || '').trim();

  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/i);
    const altMatch = tag.match(/\balt\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/i);

    const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim();
    if (!src) return tag;

    let altBase = (altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '').trim();
    if (!altBase) altBase = fallbackAltBase;
    altBase = altBase.replace(/\s*market research\s*$/i, '').trim();
    const alt = altBase ? `${altBase} market research` : 'market research';

    const rebuilt = `<img src='${src}' alt='${alt}'/>`;
    if (rebuilt !== tag) changed = true;
    return rebuilt;
  });

  return { html: out, changed };
}

// Rule 2 — remove a byline paragraph attributing the article to Ken Research,
// wherever it lands (e.g. "By Ken Research", "Market analysis by Ken
// Research."). Matched against the WHOLE paragraph's stripped text, then the
// entire <p> is dropped — never a mid-sentence substring removal, which used
// to leave a broken fragment like "<p>Market analysis .</p>" behind when the
// byline text didn't exactly match "By Ken Research" verbatim.   [REWRITTEN this session]
const BYLINE_TEXT_RE = /^(?:by|market\s+analysis\s+by|research\s+by|analysis\s+by)\s+ken\s+research\.?$/i;

function removeByline(html: string): { html: string; changed: boolean } {
  let changed = false;
  const out = html.replace(/<p>([\s\S]*?)<\/p>\s*/gi, (whole, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!BYLINE_TEXT_RE.test(text)) return whole;
    changed = true;
    return '';
  });
  return { html: out, changed };
}

// Rule 3 — bold every numeric figure in the visible text (currency amounts,
// percentages, plain numbers, years), skipping text already inside <strong>
// and never touching HTML tags/attributes.
const NUMBER_RE = /(?<![\w'"=])(?:[$₹€£]\s?)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)%?(?:\s(?:billion|million|trillion|bn|mn))?(?!\w)/gi;

function boldAllNumbers(html: string): { html: string; changed: boolean } {
  let changed = false;
  const parts = html.split(/(<[^>]+>)/); // alternates: text, tag, text, tag, ...
  let strongDepth = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isTag = i % 2 === 1;

    if (isTag) {
      if (/^<strong[\s>]/i.test(part)) strongDepth++;
      else if (/^<\/strong>/i.test(part)) strongDepth = Math.max(0, strongDepth - 1);
      continue;
    }

    if (strongDepth > 0 || !part) continue;

    const boldedText = part.replace(NUMBER_RE, (match) => {
      changed = true;
      return `<strong>${match}</strong>`;
    });
    parts[i] = boldedText;
  }

  return { html: parts.join(''), changed };
}

// Rule 4 — strip the standard Disclaimer paragraph entirely. We add our own
// disclaimer/compliance footer downstream if a platform requires one; the
// model should not be appending its own.
function removeDisclaimer(html: string): { html: string; changed: boolean } {
  let changed = false;
  const out = html.replace(/<p>(?:(?!<\/p>)[\s\S])*?Disclaimer:(?:(?!<\/p>)[\s\S])*?<\/p>\s*/gi, () => {
    changed = true;
    return '';
  });
  return { html: out, changed };
}

type Rule = { name: string; run: (html: string, ctx: BlogSanityContext) => { html: string; changed: boolean } };

const RULES: Rule[] = [
  { name: 'normalize img tags', run: normalizeImgTags },
  { name: 'remove "By Ken Research" byline', run: removeByline },
  { name: 'bold every number', run: boldAllNumbers },
  { name: 'remove Disclaimer paragraph', run: removeDisclaimer },
];

/** Runs every rule in order and returns the cleaned HTML plus a log of what actually changed. */
export function runBlogSanityChecks(html: string, ctx: BlogSanityContext = {}): BlogSanityResult {
  let current = html;
  const changes: string[] = [];

  for (const rule of RULES) {
    const result = rule.run(current, ctx);
    current = result.html;
    if (result.changed) changes.push(rule.name);
  }

  return { html: current, changes };
}
```

**`src/agents/blogSanityAgent.ts`** — 4 mechanical HTML cleanup rules run in order (`normalizeImgTags`, `removeByline`, `boldAllNumbers`, `removeDisclaimer`). This session rewrote `removeByline()`:

```ts
// OLD (buggy): matched "By Ken Research" as a whole-paragraph pattern, with a risky
// fallback that did a mid-sentence substring removal — if the byline text didn't
// match verbatim (e.g. "Market analysis by Ken Research."), the fallback deleted
// just "by Ken Research" mid-sentence, leaving a broken fragment like
// "<p>Market analysis .</p>" as the article's literal first paragraph.

// NEW (fixed):
const BYLINE_TEXT_RE = /^(?:by|market\s+analysis\s+by|research\s+by|analysis\s+by)\s+ken\s+research\.?$/i;

function removeByline(html: string): { html: string; changed: boolean } {
  let changed = false;
  const out = html.replace(/<p>([\s\S]*?)<\/p>\s*/gi, (whole, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!BYLINE_TEXT_RE.test(text)) return whole;
    changed = true;
    return '';
  });
  return { html: out, changed };
}
```
This matches the whole paragraph's stripped text against a byline-shaped pattern and removes the entire `<p>` cleanly (or leaves ordinary prose containing "by Ken Research" mid-sentence untouched — the old fallback would have corrupted that too).

---

## Part 2 — FB/LI/X Post Generation (`src/agents/contentAgentNew.ts`)

### `finalizeOutput(text, platform?)` pipeline (internal function)

```ts
function finalizeOutput(text: string, platform?: 'fb' | 'li'): string {
  let out = ensureBulletListSpacing(ensureNumberedListSpacing(stripEmDashes(convertMarkdownBoldToUnicode(text))));
  if (platform === 'fb') out = ensureSectionSpacing(out);
  return ensureStructuralLineBreaks(out);
}
```

Called from `generateFbPost()` (passes `'fb'`), `generateLiPost()` (passes nothing — LI doesn't need `ensureSectionSpacing`), and `generateFbPostFromFivePrompts`/`generateLiPostFromFivePrompts` via shared `generateBounded(platform, params)`.

**New/changed functions in the pipeline (all new this session except `ensureNumberedListSpacing` which pre-existed):**

- `ensureBulletListSpacing` — forces every `•` bullet onto its own line if not already.
- `ensureStructuralLineBreaks` — forces a line break before `"Data source:"`, after the `"Data source: Ken Research[.]"` mini-sentence, and before the trailing hashtag block. Used by both FB and LI.
- `ensureSectionSpacing` (**FB-only** — applying to LI would wrongly split its intentional numbered-point + implication-line pairing) — rebuilds FB spacing at the line level:
  - Groups consecutive `•` bullets together (single-line separated among themselves).
  - Treats every other non-URL, non-hashtag, non-"Data source:" line as its own **blank-line-separated** block.
  - **Spillover fix**: if a numbered point or the last bullet in a run has the model writing multiple sentences onto the same line (running into the closing paragraph/CTA with no newline for anything else to grab), cuts it at the end of its first sentence and starts a new block with the rest.
  - **CTA self-healing**: FB's 5 approved CTA sentences are known verbatim (`FB_CTA_VARIATIONS`). The model sometimes rewrites the CTA anyway (comma→"?", "here" dropped, a stray line break splitting the CTA text from its own URL onto separate blocks — all observed on a real published post). This is fixed by detecting which approved CTA the model was aiming for (via a short stable lead-in phrase, `FB_CTA_LEAD_IN_RE`), pulling the URL from the same or next block, and **rebuilding the whole sentence from the canonical text** via `reconstructFbCta()`, keeping the model's own URL and anything glued after it (hashtags).

Full current code (verbatim, `contentAgentNew.ts` lines ~1493-1737):

```ts
function stripEmDashes(text: string): string {
  return text.replace(/\s*—\s*/g, ' - ');
}

function ensureNumberedListSpacing(text: string): string {
  const withBreaks = text.replace(/(?<!\d)([1-9])\.(\s+)(?=\p{Lu})/gu, '\n\n$1.$2');
  return withBreaks.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

function ensureBulletListSpacing(text: string): string {
  return text.replace(/[ \t]*•/g, (match, offset: number, str: string) => {
    return offset === 0 || str[offset - 1] === '\n' ? '•' : '\n•';
  });
}

function insertBreakBefore(text: string, marker: RegExp): string {
  return text.replace(marker, (match, offset: number, str: string) => {
    return offset === 0 || str[offset - 1] === '\n' ? match : `\n${match}`;
  });
}

function ensureStructuralLineBreaks(text: string): string {
  let out = text;
  out = insertBreakBefore(out, /Data source:/gi);
  out = out.replace(/(Data source:\s*(?:Ken Research|𝐊𝐞𝐧\s𝐑𝐞𝐬𝐞𝐚𝐫𝐜𝐡)\.?)[ \t]+(?=\S)/g, '$1\n');
  const hashtagMatch = out.match(/(\s*)(#[\w-]+(?:\s+#[\w-]+)*)\s*$/);
  if (hashtagMatch && !hashtagMatch[1].includes('\n')) {
    const start = out.length - hashtagMatch[0].length;
    out = `${out.slice(0, start)}\n${hashtagMatch[2]}`;
  }
  return out.replace(/[ \t]+\n/g, '\n');
}

const FB_CTA_VARIATIONS: { leadIn: RegExp; canonical: string }[] = [
  { leadIn: /Explore the complete research report below/i, canonical: 'Explore the complete research report below for detailed insights, forecasts, and competitive mapping from Ken Research:' },
  { leadIn: /For deeper insights into market size/i, canonical: 'For deeper insights into market size, competitive benchmarking, segment analysis, and forecasts, explore the full research report here:' },
  { leadIn: /To further understand the market's dynamics/i, canonical: "To further understand the market's dynamics, growth themes, and competitive landscape, you can review the full research report from Ken Research here:" },
  { leadIn: /For a comprehensive view of key drivers/i, canonical: 'For a comprehensive view of key drivers, opportunities, and future projections, access the research report from Ken Research below:' },
  { leadIn: /If you're looking to dive deeper into market trends/i, canonical: "If you're looking to dive deeper into market trends and strategic shifts, the full research report from Ken Research is available here:" },
];
const FB_CTA_LEAD_IN_RE = new RegExp(FB_CTA_VARIATIONS.map((v) => v.leadIn.source).join('|'), 'i');

function reconstructFbCta(block: string): string {
  const variation = FB_CTA_VARIATIONS.find((v) => v.leadIn.test(block));
  if (!variation) return block;
  const urlMatch = block.match(/https?:\/\/\S+/);
  if (!urlMatch) return block;
  const trailing = block.slice(urlMatch.index! + urlMatch[0].length);
  return `${variation.canonical} ${urlMatch[0]}${trailing}`;
}

function ensureSectionSpacing(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return text;

  const isBullet = (l: string) => l.startsWith('•');
  const isNumberedPoint = (l: string) => /^\d+\.\s/.test(l);
  const isUrlOnly = (l: string) => /^https?:\/\/\S+$/.test(l);
  const isHashtagBlock = (l: string) => /^#[\w-]+(?:\s+#[\w-]+)*$/.test(l);
  const isDataSource = (l: string) => /^Data source:/i.test(l);

  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBullet(line)) {
      const group = [line];
      i++;
      while (i < lines.length && isBullet(lines[i])) { group.push(lines[i]); i++; }
      const lastIdx = group.length - 1;
      const bulletMarkerLen = group[lastIdx].match(/^•\s*/)![0].length;
      const afterBulletMarker = group[lastIdx].slice(bulletMarkerLen);
      const bulletSentenceEnd = afterBulletMarker.search(/\.\s+(?=[A-Z])/);
      let bulletSpillover = '';
      if (bulletSentenceEnd !== -1) {
        group[lastIdx] = group[lastIdx].slice(0, bulletMarkerLen + bulletSentenceEnd + 1);
        bulletSpillover = afterBulletMarker.slice(bulletSentenceEnd + 1).trim();
      }
      blocks.push(group.join('\n'));
      if (bulletSpillover) blocks.push(bulletSpillover);
      continue;
    }
    if (blocks.length > 0 && (isUrlOnly(line) || isHashtagBlock(line) || isDataSource(line))) {
      blocks[blocks.length - 1] += `\n${line}`;
      i++;
      continue;
    }
    if (isNumberedPoint(line)) {
      const markerLen = line.match(/^\d+\.\s+/)![0].length;
      const afterMarker = line.slice(markerLen);
      const sentenceEnd = afterMarker.search(/\.\s+(?=[A-Z])/);
      if (sentenceEnd !== -1) {
        blocks.push(line.slice(0, markerLen + sentenceEnd + 1));
        const rest = afterMarker.slice(sentenceEnd + 1).trim();
        if (rest) blocks.push(rest);
        i++;
        continue;
      }
    }
    blocks.push(line);
    i++;
  }

  const ctaSplit: string[] = [];
  for (const block of blocks) {
    const match = block.match(FB_CTA_LEAD_IN_RE);
    if (match && match.index! > 0) {
      ctaSplit.push(block.slice(0, match.index).trim());
      ctaSplit.push(block.slice(match.index!).trim());
    } else {
      ctaSplit.push(block);
    }
  }

  const final: string[] = [];
  for (let j = 0; j < ctaSplit.length; j++) {
    const block = ctaSplit[j];
    if (FB_CTA_LEAD_IN_RE.test(block)) {
      let ctaBlock = block;
      if (!/https?:\/\/\S+/.test(ctaBlock) && j + 1 < ctaSplit.length && /https?:\/\/\S+/.test(ctaSplit[j + 1])) {
        ctaBlock = `${ctaBlock} ${ctaSplit[j + 1]}`;
        j++;
      }
      final.push(reconstructFbCta(ctaBlock));
    } else {
      final.push(block);
    }
  }

  return final.join('\n\n');
}
```

### `FB_STYLES` — replaced (was 5 bullet-based styles → now 3 numbered-point styles)

```ts
const NUMBERED_FINDINGS_RULE = `each point must be exactly TWO sentences on the same line: the first sentence states the specific stat, named entity, or comparison from the web data; the second sentence is a distinct implication sentence explaining what it means for banks, issuers, or investors (not a restatement of the first sentence). No topic labels, no em dash, no single-sentence points.`;

const HOOK_PLACEMENT_RULE = 'Vary where "**Ken Research**" lands in the opening sentence across generations — start, middle, or end — do not always lead with it.';

const FB_STYLES = [
  { // Style 1 — contrarian
    hook: `Opening Hook – a contrarian claim that challenges where most people assume the growth story is happening. ${HOOK_PLACEMENT_RULE} Examples: start – "**Ken Research** flags a GCC card story most people are watching in the wrong country." | middle – "Most coverage of GCC card markets is watching the wrong country, and **Ken Research**'s latest tracking shows exactly why." | end – "A card market most people have written off as too small to matter is quietly outgrowing its neighbors, at least according to **Ken Research**." No em dash, no emoji.`,
    body: `2. Context and Scale – 1-2 sentences, no em dash: market value, growth rate, and where the real momentum is versus common assumption, using real numbers.
3. Numbered Findings – exactly 3 numbered points (never "•"); ${NUMBERED_FINDINGS_RULE}
4. Closing – 2 sentences, no em dash: why the quiet/early window matters now, tied to a specific year or threshold.`,
  },
  { // Style 2 — direct-question
    hook: `Opening Hook – a sharp, specific question about the market (not a generic "what does the future hold" question). ${HOOK_PLACEMENT_RULE} Examples: start – "**Ken Research** just asked why credit card penetration in Oman remains one of the lowest in the Gulf, even as its banking sector modernizes." | middle – "Why does credit card penetration in Oman still trail the rest of the Gulf? **Ken Research** raises the question as the country's banking sector modernizes fast." | end – "Credit card penetration in Oman remains one of the lowest in the Gulf, even as its banking sector modernizes fast, a gap **Ken Research** is now asking banks to explain." No em dash, no emoji.`,
    body: `2. Why the Question Matters – 1-2 sentences, no em dash: the specific tension in the data that makes this question live right now.
3. Numbered Findings – exactly 3 numbered points (never "•"); ${NUMBERED_FINDINGS_RULE}
4. Closing – 2 sentences, no em dash: what answering this question correctly is worth to the reader over a specific time horizon.`,
  },
  { // Style 3 — listicle
    hook: `Opening Hook – "[market] in [N] numbers, and one question" (N = however many numbered points follow). ${HOOK_PLACEMENT_RULE} Examples: start – "**Ken Research** breaks down the Oman credit card market in 4 numbers, and one question." | middle – "The Oman credit card market comes down to 4 numbers and one question, according to **Ken Research**." | end – "4 numbers and one question define where the Oman credit card market is really headed, per **Ken Research**'s latest tracking." No em dash, no emoji.`,
    body: `2. Numbered Findings – exactly 4 numbered points (never "•"); ${NUMBERED_FINDINGS_RULE}
3. The Question – 1 sharp sentence naming the real strategic question the four numbers add up to.
4. Closing – 1-2 sentences, no em dash, tying the question back to what **Ken Research**'s full report resolves.`,
  },
];
```

Shared prompt wrapper (`generateFbPostRaw()`, unchanged apart from noted lines) — spacing rules changed from "bullet" to "numbered point" wording, and em-dash ban added to both TONE AND STYLE and STRICT RULES blocks:
```
- Do not use emojis, stickers, italics, headings, or any formatting elements other than the bold wrapping specified below
- Never use an em dash (—) anywhere in the post — use a comma, "and", "with", or a period instead   [NEW]
...
SPACING RULES (critical):
- Use exactly one blank line between each of the 5 sections above
- Each numbered point in section 3 goes on its own line (a real line break after every point, not run together as one paragraph)   [CHANGED from "bullet point"]
...
STRICT RULES:
...
- No emojis, no other markdown, no special characters, no em dashes   [em dashes added]
```

**`LI_STYLES`** (5 persona/angle variants) — **untouched this session**. Already varies Ken Research placement naturally (woven into attribution phrasing within numbered points, not forced to lead the hook), so no changes were needed there. Full current content is in the repo if needed — unchanged from before this session.

---

## Part 3 — OpenRouter API / model reliability (`contentAgentNew.ts` + `src/utils/textChecks.ts`)

### Root cause (found via live testing against the real production `callLLMWithRetry()`)

1. 2 of 4 configured `OPENROUTER_MODELS` had gone **404 dead** on OpenRouter's free tier (`nvidia/nemotron-3-nano-30b-a3b:free`, `nvidia/nemotron-nano-12b-v2-vl:free`) — confirmed via `GET https://openrouter.ai/api/v1/models`, filtering `id.endsWith(':free')`. Every call assigned to those models instantly 404'd and rotated, wasting half the pool and pushing more load onto the remaining models.
2. `isReasoningLeak()` in `src/utils/textChecks.ts` had regex gaps — missed leaked text starting `"The user says..."` and `"User wants..."` (without "the"), letting corrupted output through undetected.

### Fix 1 — model pool

```ts
// contentAgentNew.ts, near top of file
const OPENROUTER_MODELS = [
  'openrouter/free',
  'openrouter/free',
  'google/gemma-4-26b-a4b-it:free',
];
```

Switched primary strategy to OpenRouter's own **`openrouter/free`** ("Free Models Router") — dynamically routes each call to whichever free endpoint is live/fastest. Verified live: 5 sequential calls used 5 different underlying models (poolside, nemotron-ultra, cohere, minimax-m3, nemotron-nano-omni). Weighted 2:1 vs one pinned fallback (`google/gemma-4-26b-a4b-it:free`) as a hedge against the router itself being down. This is the fix for the whole class of bug — no more hand-maintaining a model ID list that silently goes stale.

`buildKeyPool()` (unchanged) still assigns each of the 15 `OPENROUTER_API_KEY_1..15` a randomly-picked model from this array, plus appends up to 4 `NVIDIA_API_KEY`/`NVIDIA_API_KEY_2..4` entries (different provider, `NVIDIA_BASE_URL`, `NVIDIA_MODEL`) — shuffled into one flat pool.

### Fix 2 — leak detection

```ts
// src/utils/textChecks.ts
const REASONING_LEAK_RE = /^(we need to|let'?s (think|analyze|produce|write)|first,? (step|let'?s)?|okay,? (so|the user|let'?s)|(the )?user (asks|wants|is asking|says|wrote|provided|has (asked|said))|analyzing the (request|prompt)|here'?s (a |my )?thinking)/i;

export function isReasoningLeak(text: string): boolean {
  const t = text.trim();
  if (REASONING_LEAK_RE.test(t)) return true;
  const markers = (t.match(/\b(so we (should|must|need to|will)|must (output|ensure)|let'?s see|note:|actually,|however,? maybe|possibly|probably|let'?s follow)\b/gi) || []).length;
  return markers >= 2;
}
```

Changes from before: added `says|wrote|provided|has (asked|said)` verbs, made `(the )?` before `user` optional (was mandatory `the user`, missing e.g. `"User wants..."`), added `so we must` / `must (output|ensure)` to the marker fallback. Verified against both actually-observed leaked texts (`"The user says: ... So we must output..."` and `"User wants me to say... Must output..."`) — both now caught; a real clean post is not a false positive.

`isRefusal()` and `stripModelArtifacts()`/`isDegenerate()` in the same file are unchanged.

---

## Part 4 — Cleanup

Deleted **`src/tools/contentTools.ts`** — a fully dead legacy file (confirmed zero imports anywhere in `src/` via grep for `contentTools|CONTENT_TOOLS|executeContentTool`). It wrapped a **different, older** pair of functions (`generateFacebookPost`/`generateLinkedInPost` from `src/agents/contentGenerator.js`, not `contentAgentNew.js`) behind an Anthropic-tool-calling interface (`CONTENT_TOOLS` array + `executeContentTool()` dispatcher) that nothing in the current cron/batch architecture calls. `src/agents/contentGenerator.ts` and `src/agents/sanityAgent.ts` (the old ones, distinct from `contentAgentNew.ts` and the current `sanityAgent.ts` used elsewhere — verify which is which before touching) are now also orphaned as a result but were **left alone**, out of scope.

---

## Part 5 — Cron wiring (confirmed, unchanged)

```
scheduler-new.ts (cron: FB Batch 1-5, LI Batch 1-3, times in Asia/Kolkata)
  → runFbBatch() / runLiBatch()          [src/coordinator/masterCoordinator.ts]
    → generateFbPost() / generateLiPost() [src/agents/contentAgentNew.ts]
```
```
npm run dev -- run-blog-gen [N] / run-blog-gen-loop
  → runBlogGenBatch() / runBlogGenLoop()  [src/coordinator/blogGenLoop.ts]
    → generateBlogViaChatGpt(..., promptVersion: random 'v1'|'v2')  [src/agents/blogGenAgent.ts]
```
Every fix in Parts 1-3 is live automatically for the next scheduled/manual run through these chains — no additional wiring needed.

## Verification commands

```bash
npx tsc --noEmit -p .          # only pre-existing unrelated errors should remain
node --import=tsx src/tools/generateBlogAndImage.ts --title "..." --url "..." [--v2]   # manual blog test
npm run dev -- run-fb-batch    # or run-li-batch — real FB/LI generation through the fixed pipeline
npm run dev -- run-blog-gen 1  # real blog generation, random V1/V2 rotation
```
