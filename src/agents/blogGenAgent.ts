/**
 * blogGenAgent.ts — generate a full blog article by driving the user's own
 * logged-in ChatGPT session (not an API call). ChatGPT does its own research
 * against the report URL, verifies its data, and assembles a publication-ready
 * article per the master SERP/AI-citation prompt below.
 *
 * Generation takes ~12-15 minutes per article — this is not a fast path.
 *
 * Launches its OWN persistent Chrome context per call (does not go through
 * browser/chatgpt/login.ts's shared single-browser singleton) — that's what
 * lets this run at the same time as blogImageAgent.ts's cover-image
 * generation in a second, independent Chrome window, instead of the two
 * fighting over one shared browser/page.
 *
 * Usage:
 *   const result = await generateBlogViaChatGpt({ title: row.title, url: row.targetUrl });
 *   // result: { title, description, html }
 */

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
// blogImageAgent.ts's default account (below) so the two always run in
// separate Chrome profiles/windows and can run concurrently.
const DEFAULT_BLOG_ACCOUNT = 'account1';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Blog generation is slow (~12-15 min) — this is a much longer budget than
// promptRunner.ts's 2-minute RESPONSE_TIMEOUT_MS, which is sized for short
// social-post replies, not full articles.
const RESPONSE_TIMEOUT_MS = 30 * 60 * 1000; // hard cap 30 min
const POLL_MS = 60 * 1000; // check every 1 min (after the first 5-min wait)

/**
 * The master SERP/AI-citation blog prompt — fully self-contained: does its
 * own research, sourcing, fact-checking, and HTML assembly per a fixed
 * 7-section architecture. ARTICLE_HTML mode: a raw HTML fragment response,
 * far more robust to extract from a ~1500-word ChatGPT generation than
 * trusting valid JSON out of the same.
 */
export function buildMasterBlogPrompt(reportTitle: string, reportUrl: string): string {
  return `KEN RESEARCH SERP AND AI CITATION MASTER BLOG PROMPT
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
If, after exhausting those retries, the primary report truly cannot be accessed or its core market identity cannot be verified, return only: RESEARCH BLOCKED: Primary report could not be verified.
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
Use exactly one H1 and exactly seven H2 sections.
Hero image, conditional
If IMAGE_MODE: ON and HERO_IMAGE_URL passes validation, place a verified hero image before the H1. If the image fails, omit it silently. If IMAGE_MODE: OFF, output no image tags or image discussion.
H1
Write a unique, accurate headline of 50-60 characters including spaces.
Front-load a concise version of the exact market entity and geography.
Include the strongest verified numerical hook. Prefer forecast value plus year, current market value plus year, or CAGR plus period.
A structure such as {Market Name} to Reach {Verified Value} is preferred when accurate.
Do not use vague trend-only endings such as "Shifts to Powered Care," "Enters a New Era," or "Growth Accelerates" when a verified value is available.
Wrap only the decisive numerical hook in <strong> when it improves scanability.
Avoid clickbait, a mechanical brand suffix, questions, and unsupported superlatives.
Count visible characters without HTML tags and rewrite until the H1 is within 50-60 characters.
Optional byline
If SHOW_BYLINE: ON, add one short byline paragraph using only supplied author and date fields. Omit blank fields. Never invent them.
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
Use two or three question-led H3 subsections selected for the market, such as:
What is expanding the demand base?
How are price and volume interacting?
Which technology, funding, replacement, or channel mechanism matters most?
Each subsection must move from evidence to mechanism to commercial consequence.
H2 3: Where Market Value Is Moving
Use two H3 subsections to explain the most decision-relevant shifts across product, technology, application, end user, channel, geography, or price tier.
Identify the segmentation dimension explicitly.
Distinguish largest from fastest-growing.
Explain buyer behaviour and why the mix shift matters.
Do not list every segment.
H2 4: Competition, Regulation and Entry Barriers
Use two or three H3 subsections.
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
After this section, include CTA 2 linking to the verified Ken Research Talk to Us page. Keep it consultative.
H2 6: Frequently Asked Questions
Include exactly five unique FAQ pairs. Use an H3 question and one 45-65-word answer for each.
Cover:
Market definition and scope
Size, year, and data status
Forecast value and CAGR period
Segment, competition, or regulation
Primary opportunity or risk
Answer directly in the first sentence. Do not add hyperlinks or unsupported facts.
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
The finished article must contain 10-12 Ken Research link placements, separate from official external citations.
Required Ken Research distribution:
Ken Research homepage: exactly one placement in the opening
Canonical primary report: exactly three placements in the opening, CTA 1, and Sources paragraph
Ken Research Talk to Us: exactly one placement in CTA 2
Relevant Ken Research cluster pages: five to seven placements using five to seven unique destinations
Total Ken Research placements: exactly 10-12
Total unique Ken Research destinations: at least eight
Use one or two unique official government, regulator, national-statistics, or public-agency links, with two preferred when two strong and directly relevant sources exist. Never use more than two official external citations. These external citations do not count toward the 10-12 Ken Research placements.
After drafting, count all official external <a> tags. The article passes only when the count is one or two; zero or more than two fails validation.
Distribute internal links across the article:
Opening: homepage and primary report
Market Definition and Evidence Snapshot: one relevant cluster page
Growth Mechanisms and Market Economics: one or two relevant cluster pages
Where Market Value Is Moving: one or two relevant cluster pages
Competition, Regulation and Entry Barriers: one relevant cluster page plus primary-report CTA 1
Decision Framework and Market Outlook: one or two relevant cluster pages plus Talk to Us CTA 2
Methodology and Sources: primary report
Prioritize actual related Ken Research report pages. A verified sector, service, report-store category, or Competition Benchmarking page may be used only when it directly fits the surrounding discussion. Never use a generic page merely to reach the count.
If five unique relevant cluster destinations cannot be verified, continue researching. Never guess a URL or silently publish below the internal-link target. If the minimum cannot be satisfied, return only: LINK VALIDATION BLOCKED: Fewer than 10 verified Ken Research link placements.
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
Apply this to all 10-12 Ken Research placements, including homepage, primary report, related pages, and Talk to Us.
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
Never output the literal character sequences \\n, \\r, or \\t.
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
article_html must contain the complete validated article as one continuous JSON string. Do not insert \\n, \\r, or \\t escape sequences. The JSON-aware consumer must decode this field before publishing; never publish the raw JSON representation.
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
The H1 is 50-60 visible characters, contains the market entity, and includes the strongest verified numerical hook.
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
The article contains exactly 10-12 Ken Research link placements and at least eight unique Ken Research destinations.
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
ARTICLE_HTML mode uses real line breaks and contains no literal \\n, \\r, or \\t sequences.
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
SHOW_BYLINE: ON
AUTHOR_NAME: Ken Research
PUBLISHED_DATE:
UPDATED_DATE:
CANONICAL_BLOG_URL:
BREADCRUMB_PARENT_URL:
CMS_GENERATES_SCHEMA: YES
</INPUTS>`;
}

// ChatGPT's rate-limit / session-nudge popups can appear at any point during
// the ~12-15 min generation, not just at the fixed checkpoints
// dismissBlockingModals() covers (before typing, before sending). A generic
// dialog/overlay is detected by role, then Enter is pressed to dismiss it —
// repeated until it's actually gone (not a fixed count), since some ChatGPT
// dialogs re-render themselves once after the first dismissal.
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
 * (matches every platform poster's own injectUTM call downstream, so this is
 * really just what shows up before any platform-specific posting overrides it).
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

/**
 * Generate one blog article via the user's own logged-in ChatGPT session.
 * Launches its own persistent Chrome context (session dir per account),
 * sends the master prompt, waits ~12-15 min, extracts and sanitizes the
 * result, then closes that context. Throws on failure so the caller can
 * retry/skip. Independent of blogImageAgent.ts's browser — safe to run both
 * concurrently via Promise.all.
 */
export async function generateBlogViaChatGpt(params: {
  title: string;
  url: string;
  accountHandle?: string;
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

    const prompt = buildMasterBlogPrompt(params.title, params.url);
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
