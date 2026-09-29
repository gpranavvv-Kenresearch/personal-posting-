# Blog Generation Pipeline — Full Reference

Scope: the **blog TEXT + blog COVER IMAGE generation** pipeline that fills in a "New Logic" sheet row's `Blog Content` / `Title` / `Description` / `Image Data` / `Cover Image URL` columns from just a `Target URL`. This does **not** cover posting the finished blog to any platform, and does **not** cover the separate 7-slide/6-slide LinkedIn carousel pipeline in `li-carousel-storyline/` — those are different systems.

All file paths are relative to the repo root:
`C:\Users\Pranav Gupta\OneDrive - Ken Research Private Limited\Desktop\Read Me\reponse\x-posting-agent`

---

## 1. Big picture

```
Google Sheet "New Logic" tab
  row has: Target URL, empty/short Blog Content
        │
        ▼
src/coordinator/blogGenLoop.ts  ── runBlogGenBatch() ──┐
        │                                              │
        ├─ Chrome window #1: blogImageAgent.ts ────────┤  (run concurrently
        │     generateBlogCoverImageWithText()         │   via Promise.all)
        │     → ChatGPT/DALL-E cover image              │
        │     → uploaded to Google Drive → URL          │
        │     → saved to sheet immediately               │
        │                                              │
        └─ Chrome window #2: blogGenAgent.ts ───────────┘
              generateBlogViaChatGpt()
              → ChatGPT writes the full HTML article
              → parsed/extracted from the chat DOM
        │
        ▼
  blog.imageData → blogSnapshotImageAgent.ts
     renders the "Key Snapshot Metrics" text block into a real PNG chart,
     replaces the article's YOUR_IMAGE_URL_HERE placeholder
        │
        ▼
  injectCoverImage() prepends <img src="cover"> above the <h1>
        │
        ▼
  blogPreferredSourceAgent.ts inserts one Google Preferred-Source CTA link
        │
        ▼
  saveGeneratedBlogToPool() writes Blog Content / Title / Description /
  Image Data / Cover Image URL back to the sheet
        │
        ▼
  verifyWrite() re-reads the row from the sheet to confirm it actually landed
  (word-count floor) — retries the whole row (up to 2 attempts) if not
```

Two completely separate Chrome profiles/windows run **at the same time** for one row: the blog text (`social-image` ChatGPT account) and the cover image (`account2` ChatGPT account). This is deliberate — each script launches its own `chromium.launchPersistentContext`, so they never fight over one browser.

Generation is slow: ~12–15 minutes for the blog text, up to ~9 minutes for the cover image. This is why it's a separate long-running process, not part of the tightly-timed posting cron.

---

## 2. Sheet columns involved (New Logic tab)

Sheet: **`New Logic`** (`sheets.ts` — `NEW_LOGIC_SHEET_NAME = 'New Logic'`, id `1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ`). `blogGenLoop.ts` always passes `'newLogic'` as the sheet type.

| Column (canonical name) | Accepted aliases | Role |
|---|---|---|
| `Target URL` | `targetUrl`, `URL`, `Report URL`, `Download Report URL` | **Input.** The Ken Research report URL ChatGPT researches against. |
| `Blog Content` | `blog content`, `Blog Content for all`, `Content` | **Gate + output.** A row is "needs generation" when this is empty or under 50 characters. Final write target for the complete article HTML (cover image + snapshot chart + Preferred Source CTA already inlined). |
| `Title` | `title` | **Output.** Overwritten with ChatGPT's own generated *SEO Title* — not the row's original working title. |
| `Description` | `description` | **Output.** ChatGPT's *Meta Description*. |
| `Image Data` | `image data` | **Output.** The raw "Key Snapshot Metrics for Image" text block, consumed by `blogSnapshotImageAgent.ts` to render the mid-article chart PNG. |
| `Cover Image URL` | `cover image url` | **Output.** The Google-Drive-hosted cover image URL. Written **twice**: immediately when the image finishes generating (before the blog text is even done), and again as part of the final batch write. |
| `Image text` | `image text` | **Output, observational only.** Whatever text ChatGPT wrote alongside the generated cover image (its own research notes). Never blocks anything. |
| `Blog Title` / `Main Title` | — | **Read only**, as a fallback display title for logging, separate from the SEO Title written back after generation. |

Per the code comment on `saveGeneratedBlogToPool`, these New Logic columns physically sit at spreadsheet columns **C (Title) / D (Description) / E (Image Data)**.

**Row-picking function**: `getContentPoolRowsNeedingGeneration(limit, 'newLogic')` (`sheets.ts:863-892`) — reads the whole sheet (`A:ZZ`), resolves the URL and Blog Content column indices by the aliases above, and does a linear scan: a row qualifies when `targetUrl` is non-empty **and** `blogContent.trim().length < 50`.

**Write functions**:
- `saveGeneratedBlogToPool(row, { html, coverImageUrl?, seoTitle?, metaDescription?, imageData? }, 'newLogic')` — the main batch write, `sheets.ts:896-920`.
- `saveCoverImageUrlToPool(row, url, 'newLogic')` — writes only `Cover Image URL`, called the instant the image finishes so the URL survives even if the (much slower) blog text then fails/retries.
- `saveNewLogicImageText(row, imageText)` — writes only `Image text`, wrapped in try/catch so it can never fail the row.
- `getSheetRowByIndex(rowIndex, 'newLogic')` — re-reads a single row by 1-based row number, used by `blogGenLoop.ts`'s `verifyWrite()`.

---

## 3. Blog TEXT generation — `src/agents/blogGenAgent.ts` (3693 lines)

### 3.1 Account + session

```ts
const DEFAULT_BLOG_ACCOUNT = 'social-image';
```
Blog text generation uses the ChatGPT account/session named **`social-image`** — the same session the LI-carousel image generator uses, but a **different** session from the cover-image agent below (`account2`), so the two Chrome windows never collide over one profile. Session dir resolves via `sessionDirForAccount('social-image')` → `.sessions/chatgpt-accounts/social-image`.

Login/session setup: `npx tsx src/tools/loginChatGpt.ts social-image` (manual, one-time; session then persists).

### 3.2 Selectors

```ts
const COMPOSER_SELECTOR = '#prompt-textarea, div[contenteditable="true"].ProseMirror';
const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
```
Both the composer and assistant-message selectors are comma-separated to match **both** ChatGPT's old DOM and its 2026-09-26 UI redesign (which dropped `data-message-author-role` entirely in favor of `div[data-markdown-text-style="assistant-message"]`). This fix was applied across every file that reads ChatGPT's DOM after the redesign broke text generation silently for several days (see §8).

### 3.3 The prompts — five total, chosen at random per generation

`generateBlogViaChatGpt()` decides the prompt **at run time**, not via any caller parameter:

```ts
let promptLabel = 'v1 (master)';
let prompt: string;
if (params.promptVersion === 'v2') {
  prompt = buildMasterBlogPromptV2(params.title, params.url);
  promptLabel = 'v2 (keyword-focused)';
} else if (Math.random() < PROMPT_B_ROTATION_CHANCE) {
  const variant = PROMPT_B_BUILDERS[Math.floor(Math.random() * PROMPT_B_BUILDERS.length)];
  prompt = variant.build(params.title, params.url);
  promptLabel = `Prompt B (${variant.name})`;
} else {
  prompt = buildMasterBlogPrompt(params.title, params.url);
}
```
`PROMPT_B_ROTATION_CHANCE = 0.5`. Since `blogGenLoop.ts` (the only real caller) never passes `promptVersion`, **every automated generation is a 50/50 coin flip** between:
- the master **"Ken Research Market Blog Master Prompt V1.3"**, or
- a uniformly-random pick of one of **4 "Prompt B" variants**.

`buildMasterBlogPromptV2` is *not dead* — it's just never reached automatically, only via an explicit `promptVersion: 'v2'` (used by the standalone `src/tools/generateBlogAndImage.ts` tool). As of 2026-09-18 both `buildMasterBlogPrompt` (v1) and `buildMasterBlogPromptV2` (v2) are thin wrappers that return the **identical** V1.3 text — the old, genuinely different bodies survive only as dead code under `OLD_buildMasterBlogPrompt` / `OLD_buildMasterBlogPromptV2` for reference/rollback, never called.

#### 3.3.1 Master Prompt V1.3 (the default text, ~2200 lines, `buildKenResearchMasterPromptV1_3`)

Interpolates `${reportTitle}` and `${reportUrl}` near the top, twice each. Full text:

> You are a senior market-intelligence editor, SEO strategist, AIO/GEO content architect, fact-checker, research analyst, internal-link strategist, and HTML publishing specialist working for Ken Research.
>
> Your task is to research and create ONE final, publication-ready, platform-neutral market-intelligence article using only the inputs supplied below.
>
> You are NOT given a reference article.
>
> You must independently determine: the strongest editorial thesis; the most appropriate article structure; the best H2/H3 hierarchy; the right balance of paragraphs, bullets and callouts; the most useful internal links; the most authoritative external sources; the most decision-relevant market insights.
>
> Do NOT ask for: a sample blog; a reference article; competitor content; target platform; preferred structure; previous article; writing example. This prompt is self-contained.
>
> Report Title: `${reportTitle}`
> Market Name: `${reportTitle}`
> Primary Report URL: `${reportUrl}`
> Optional Primary Keyword: *(blank)*
> Optional Secondary Keywords: *(blank)*
>
> **Create a premium, research-led article that:** provides genuine market intelligence; is useful to business decision-makers; is suitable for Google organic search; is structured clearly for AI search, AI Overviews, retrieval and citation; demonstrates real information gain; uses Ken Research proprietary data accurately; clearly separates proprietary estimates from official statistics; uses credible external evidence; uses natural, well-spaced internal linking; avoids keyword stuffing; avoids excessive promotion; avoids generic AI wording; avoids one-line paragraph fragmentation; avoids paragraph-only walls of text; uses useful H2s, H3s, bullets and limited callouts; includes a meaningful counter-thesis/risk view; can be published directly as clean HTML; does NOT require a reference article.
>
> **The final article should feel like:** MARKET RESEARCH + BUSINESS ANALYSIS + EDITORIAL INSIGHT + SEO QUALITY + AI-SEARCH READABILITY + SOURCE TRANSPARENCY.
> **It must NOT feel like:** KEYWORD PAGE + GENERIC TEMPLATE + SALES LANDING PAGE + AI FILLER.
>
> Start with the supplied Primary Report URL. Research the Ken Research website and determine whether a newer/current version of the same market or data framework exists.
>
> **Extract only supported information such as:** publication date; study period; historical period; base year; forecast period; market value; forecast value; CAGR; historical growth; physical volume; transaction count; subscribed units; project count; installed base; ASP / ARPU / value per unit; dominant segment; fastest-growing segment; dominant geography; fastest-growing geography; deployment/channel/business model; customer type; growth mechanisms; operating economics; risks; competitive participants; regulatory considerations; methodology; respondent/sample count; market-sizing basis; supporting metrics.
>
> Never invent a number because a field is missing.
>
> **If several Ken Research pages contain different figures for the same market:** compare publication dates; identify the newest complete dataset; prefer the newest reliable framework; use ONE internally consistent dataset; do NOT mix old and new values; use the newest relevant report URL when appropriate; do not confuse readers with obsolete values unless the comparison itself is analytically important.
>
> Treat Ken Research market figures as proprietary estimates unless explicitly identified otherwise. Never present proprietary estimates as government statistics.
>
> Research approximately 2–4 authoritative external sources. The final article normally needs only 2–3 external links.
>
> **Priority:** Government ministry; National statistics office; Regulator; Central bank; Customs/trade authority; Transport/port authority; Official industry body; Primary company disclosure; Highly credible institutional source.
>
> **External evidence may validate:** regulation; trade; infrastructure; demographics; payments; transport activity; internet usage; policy; technology adoption; government programs; customs; company infrastructure investments.
>
> Do not add external links merely to increase source count. Every sourced statistic must retain the correct: year; unit; geography; population/sample where relevant; context.
>
> Before writing, determine: *"What is actually changing in this market, and why does it matter commercially?"* Do NOT default to: "The market is growing because demand is increasing." Look for the strongest mechanism.
>
> **Examples of mechanisms:** basic service shifting toward advanced analytics; recurring revenue replacing transaction revenue; value growth exceeding volume growth; digital channel changing distribution economics; cloud changing cost structures; regulation creating demand; premiumization offsetting demographic weakness; outsourcing raising service intensity; automation improving productivity; infrastructure constraining demand; affordability weakening real growth; fragmented competition favoring integrated players; local sourcing reducing import risk; e-commerce increasing logistics intensity; data governance becoming a buying criterion.
>
> The article must be built around the strongest supported thesis.
>
> Before writing, silently create THREE possible editorial structures. Do NOT output them. **The three structures must differ in:** central thesis; opening angle; H2 sequence; H2 wording; H3 usage; section grouping; position of competition; position of regulation; position of geography; position of segment analysis; treatment of risk; bullet usage; callout placement.
>
> **Evaluate the 3 structures based on:** Which best explains the actual economics? Which surfaces proprietary information most effectively? Which provides the most information gain? Which is most useful to decision-makers? Which avoids generic market-report templating? Which creates the strongest SEO/AIO structure?
>
> Select ONE. Output ONE final article only. Do NOT generate every article with the same flow.
>
> **Do NOT mechanically use:** Market Size → Drivers → Segments → Competition → Regulation → Outlook. Different industries should naturally produce different architectures. For example:
> - **TECH / SaaS / CYBERSECURITY** may emphasize: recurring revenue; cloud; adoption; talent; automation; integration; compliance.
> - **LOGISTICS** may emphasize: trade flows; corridor economics; utilization; freight; warehousing; outsourcing; infrastructure.
> - **FMCG / RETAIL** may emphasize: consumer demand; basket economics; pricing; distribution; channel mix; affordability; sourcing.
> - **HEALTHCARE** may emphasize: disease burden; access; reimbursement; regulation; capacity; adoption; pricing.
> - **LUXURY / FASHION** may emphasize: affluent demand; tourism; price mix; product categories; digital channels; import exposure.
> - **AGRICULTURE** may emphasize: yield; farm economics; input costs; technology; water; infrastructure; climate; regulation.
> - **CONSTRUCTION** may emphasize: project pipeline; capex; permits; materials; labor; financing; infrastructure.
>
> The exact headings must be written for the specific industry. QUALITY RULES remain fixed even when structure changes.
>
> **Avoid generic/repetitive H2s such as:** Growth Drivers; Key Trends; Market Opportunities; Competitive Landscape; Market Analysis.
> **Prefer analytical headings.** Instead of "Growth Drivers" use "Fuel Economics Are Making Analytics Easier to Justify"; instead of "Competitive Landscape" use "Competition Is Moving From Devices to Analytics Capability"; instead of "Key Trends" use "Cloud Delivery Is Lowering the Barrier to Adoption." Headings should communicate an insight. Do not repeatedly reuse the same H2 wording across different reports.
>
> **Generate before the article:** SEO Title.
>
> **SEO TITLE ROLE:** the search-facing title, preserving strong market/entity relevance while adding a distinctive, report-specific commercial angle.
>
> **MANDATORY SEO TITLE RULES:** Retain the recognizable core Market Name / primary market entity in the SEO Title. Do NOT rewrite the market name so aggressively that the main search entity becomes unclear. Keep the market/entity phrase prominent, preferably at or near the beginning. Make the second half dynamic and based on the strongest VERIFIED commercial thesis in the report. The SEO Title must be unique, punchy, search-intent aligned, and useful rather than generic. The SEO Title must be meaningfully different from the H1. Do NOT include "Ken Research" in the SEO Title by default. Do NOT mechanically use generic formulas such as "[Market Name] Size, Share, Trends & Forecast" unless that wording is genuinely required by the search intent. Do NOT force a rigid character limit if doing so damages the market entity or meaning. Keep the title as concise as the market name allows; prioritize entity clarity, search relevance and click appeal over arbitrary character-count compliance. Do NOT invent an angle merely to make the title sound dramatic. Every thesis used in the SEO Title must be supported by the researched market evidence.
>
> **DYNAMIC SEO TITLE FAMILIES** (style families, not fixed templates — create a new phrasing when the evidence suggests a better angle):
> - [Market Name] Enters a Higher-Value Growth Phase
> - [Market Name] Shifts From [Old Model] to [New Model]
> - [Market Name] Moves Toward [Important Commercial Shift]
> - [Market Name]: Growth Beyond [Old Growth Mechanism]
> - [Market Name] Builds a Stronger [Revenue / Channel / Technology] Story
> - [Market Name] Expands Beyond [Traditional Category / Channel]
> - [Market Name]: [Emerging Segment] Reshapes Growth
> - [Market Name] Moves Into a [New Economics]-Led Phase
> - [Market Name] Targets [Commercial Outcome] Through [Forecast Year]
> - [Market Name]: [Key Metric / Behavior] Becomes the New Driver
>
> Example — Market Name "Poland Online Food Delivery Aggregator Market" → strong SEO Title "Poland Online Food Delivery Aggregator Market Shifts From Reach to Revenue" (or "Poland Online Food Delivery Aggregator Market: Growth Beyond User Acquisition").
>
> **Meta Description:** approximately 140–160 characters; useful; non-promotional; include core figure(s) when valuable. Plain text only — no HTML tags, no `<strong>`, no Markdown bold/links, no formatting of any kind. Numbers as plain digits (e.g. "USD 63 million", not "`<strong>`USD 63 million`</strong>`").
>
> **Also generate:** Primary Search Intent; Primary Keyword; 5–8 Secondary Semantic Topics; Suggested Snapshot Image Alt.
>
> Use exactly ONE H1.
>
> **H1 ROLE:** the editorial headline — more expressive, insight-led and attention-grabbing than the SEO Title while still making the market/topic immediately understandable.
>
> **MANDATORY H1 RULES:** The H1 must be meaningfully different from the SEO Title. The H1 must preserve a recognizable market/topic reference, but does NOT need to repeat the complete formal Market Name word-for-word if a shorter natural expression is clearer. The H1 must include `<strong>`Ken Research`</strong>` naturally. The H1 should communicate the strongest VERIFIED market tension, milestone, opportunity, risk, transformation or strategic question. A verified market value / forecast / milestone may be used when it materially strengthens the headline. If a visible number appears in the HTML H1, apply the existing mandatory number-bolding rule. Do NOT invent a risk, barrier, opportunity or numerical milestone for headline impact. The headline may be longer than the SEO Title when editorial clarity requires it. Avoid robotic keyword repetition. Avoid repeating the same H1 grammar across different reports. Do NOT automatically use "Tracks", "Flags", "Hits", "Nears", or any other single verb in every article. Vary the editorial construction according to the report and industry.
>
> **ALLOWED H1 APPROACHES:**
> 1. **Question / strategic-tension style** — e.g. `<h1>`Can Poland's Food Delivery Platforms Turn Reach Into Revenue Quality? `<strong>`Ken Research`</strong>` Tracks the `<strong>`USD 2.03B`</strong>` Opportunity`</h1>`
> 2. **Milestone + barrier/risk style** — e.g. `<h1>`Thailand Agri-Equipment Rental Market Hits `<strong>`USD 1B`</strong>`: `<strong>`Ken Research`</strong>` Flags Service Reliability as the Bigger Loyalty Barrier`</h1>`
> 3. **Transformation style** — logic: [Market/Industry] Moves From [Old Model] Toward [New Model]: `<strong>`Ken Research`</strong>` Examines What Changes the Economics
> 4. **Opportunity + execution style** — logic: [Market/Industry] Opens a New [Opportunity] Layer: `<strong>`Ken Research`</strong>` Highlights the Execution Test
> 5. **Commercial-tension style** — logic: [Market/Industry] Growth Accelerates, but [Constraint] Changes the Economics: `<strong>`Ken Research`</strong>` Maps the Trade-Off
>
> Question-style H1s are allowed but NOT mandatory — use a question only when it creates a genuine decision-oriented tension; do NOT make every H1 a question; do NOT use the same H1 family repeatedly across consecutive reports. The H1 must feel written for the specific market, not filled into a template. SEO Title = search-led and market-entity-led; H1 = editorial, branded, insight-led — they complement rather than repeat each other.
>
> Use 2–3 proper introductory paragraphs. **Normal paragraph:** 2–4 sentences, usually 45–110 words, one coherent analytical idea.
>
> **Paragraph 1** should establish: market identity; market change; base value; forecast value; CAGR.
> **Paragraph 2** should explain: why the market is changing; why that mechanism matters commercially.
> **Paragraph 3** (required — the second interlinking placement, paragraph 1's Ken Research homepage link being the first): major risk; counter-thesis; operating tension. Include exactly one contextual link to a genuinely relevant adjacent Ken Research report here (same verification/UTM rules as every other adjacent-report link). This becomes "Adjacent #1" — do not also place a separate first-adjacent link in the early H2 section; the early/early-middle H2 instead carries "Adjacent #2", the middle H2 carries "Adjacent #3", and so on. Do NOT link the Ken Research homepage a second time here — paragraph 1 already used that single mandatory homepage placement.
>
> Within roughly the first 150 words the reader should understand: what the market is; current/base value; forecast direction; why it is changing. Within the first 200–250 words, naturally include one concise market-scope sentence — what the market includes and, where relevant, excludes, using only the primary report's supported scope, not written like a dictionary definition.
>
> The first natural occurrence of Ken Research must link exactly once to `https://www.kenresearch.com/`, format:
> ```html
> <a href="https://www.kenresearch.com/">
>   <strong>Ken Research</strong>
> </a>
> ```
> Purpose: brand attribution; publisher identity; research provenance. Rules: homepage link exactly once; do not repeat homepage later; do not add "Visit Ken Research"; do not use homepage as CTA; later Ken Research mentions remain bold but unlinked.
>
> The Primary Report URL must normally be linked ONLY ONCE in the FINAL ARTICLE, inside the final commercial CTA. Do NOT link the Primary Report URL in the introduction. The first important market-name mention in the introduction should remain plain text or may be bold if editorially useful, but must NOT carry the Primary Report URL. Purpose: prevent duplicate primary-report linking; reduce promotional density; avoid two Ken Research-domain links appearing together in the introduction; preserve the final CTA as the primary conversion point.
>
> **Normal architecture:** INTRODUCTION → Ken Research homepage branding link only. BODY → contextual adjacent-market links. FINAL CTA → Primary Report link. Do not repeat the primary-report URL elsewhere unless explicitly required.
>
> EVERY visible occurrence of "Ken Research" must be `<strong>`Ken Research`</strong>`; if linked, `<a href="https://www.kenresearch.com/"><strong>Ken Research</strong></a>`. Never leave visible Ken Research unbolded.
>
> Every meaningful visible number must be bold — e.g. `<strong>`USD 63 million`</strong>`, `<strong>`2025`</strong>`, `<strong>`13.6%`</strong>`, `<strong>`160,000 vehicles`</strong>`, `<strong>`58%`</strong>`, `<strong>`216 respondents`</strong>`, `<strong>`5–7 years`</strong>`, `<strong>`2025–2032`</strong>`. Applies to: market values; years; ranges; percentages; currency; volumes; counts; units; shares; ASP; ARPU; transaction counts; subscriber counts; respondent counts; external statistics. Do NOT bold numbers inside URLs, HTML attributes, image dimensions, tracking parameters, or code.
>
> After the introduction include ONE snapshot-image placeholder. Do NOT create an HTML table. Use exactly this tag — a bare img with only src and alt, nothing else (no `<figure>`, no `<figcaption>`, no width/height/loading attributes, no caption text):
> ```html
> <img src="YOUR_IMAGE_URL_HERE" alt="[DESCRIPTIVE ALT]">
> ```
>
> Choose approximately 5–7 supported metrics for the base set below, PLUS any of the optional multi-value fields (Segment Breakdown, Key Players, Market Share) whenever the report actually publishes that data — these feed a downstream chart generator that renders each metric as a real chart (donut, gauge, bar comparison), so the EXACT field name and value format must be followed. Never fabricate a metric or value to fit a format — omit the field entirely if unsupported.
>
> **Base set** — plain "Label: Value" line, one metric per line: Base Market Value; Forecast Value; CAGR; Market Volume / Units; Leading Segment; Fastest-Growing Segment; Dominant Geography; Major Driver; Major Constraint.
>
> **MANDATORY VALUE FORMATS** (the chart generator parses these patterns literally):
> - **Trend metric** (bar-comparison chart) — two/three chronological points joined by " → ", each ending in "in {year}": `Completed Orders: 3.8 million in 2025 → 8.5 million in 2031` / `Revenue per User: USD 12 in 2025 → USD 15.5 in 2028 → USD 19 in 2031`
> - **Share metric** (donut) — label contains the word "Share" (not "Breakdown"), value ends in a percentage: `Fresh-Food Share: 41.0% in 2025`
> - **Segment Breakdown** (multi-slice donut) — label exactly "Segment Breakdown", value a comma-separated "Name X%" list, 3–5 segments summing near 100%: `Segment Breakdown: Cloud Deployment 45%, On-Premise 30%, Hybrid 25%`
> - **Gauge metric** (half-circle gauge) — label contains CAGR/Growth/Adoption/Penetration/Utilization/Conversion, value a percentage: `CAGR: 15.1%` / `Adoption Rate: 62% in 2025`
> - **Key Players** (competitor name list) — label exactly "Key Players", value a comma-separated company list: `Key Players: Acme Corp, Northwind Traders, Globex Inc`
> - **Market Share** (ranked bar chart) — label exactly "Market Share", value a comma-separated "Name X%" list (same companies as Key Players when both used): `Market Share: Acme Corp 34%, Northwind Traders 22%, Globex Inc 15%`
>
> Only include Segment Breakdown / Key Players / Market Share when the primary or a verified adjacent report actually publishes segment- or competitor-level percentages — optional, never fabricated.
>
> Typical article length: 1,500–2,200 words, only when evidence supports that depth — do not pad merely to hit word count. Use approximately 6–9 meaningful H2 sections (a complex market may justify slightly more); don't create/delete sections purely to meet a numeric limit.
>
> The article must NOT be one-liner-heavy, paragraph-only, or a wall of text. Normal analytical paragraphs: 2–4 sentences, roughly 45–110 words, one complete idea. Avoid sentence-by-sentence `<p>` splitting, excessive single-sentence paragraphs, 180–250 word blocks, dramatic AI-style fragmentation. Single-sentence paragraphs should normally stay below ~15–20% of body paragraphs, used only for intentional emphasis, a transition before bullets, a callout, or a short conclusion.
>
> Every article should mix analytical paragraphs, H2 sections, selective H3 sub-sections, useful bullet lists, and limited blockquotes. Structural diversity ≠ paragraph-only prose; formatting ≠ converting everything into lists.
>
> **Preferred editorial rhythm:** Paragraph → Paragraph → H3 or short setup → Bullets → Analytical interpretation; or: Paragraph → Bullets → Paragraph. The exact amount varies by market. QUALITY must never decrease merely to create visual variation.
>
> **Use bullets when readers benefit from scanning** — good uses: operating questions; technology modules; demand drivers; risks; costs; competitive differentiators; buyer requirements; product/segment characteristics; signals to monitor; methodology components. Do not make every section a bullet list or every section paragraphs — use lists only when useful.
>
> Use H3 when a real subtopic deserves separation. For a typical 1,500–2,200 word article: approximately 2–5 useful H3 sub-sections, distributed across different H2 sections where genuinely relevant — do NOT force every H2 to contain an H3, do NOT use H3 for decoration, do NOT create an H3 followed by only one trivial sentence.
>
> **Good H3 candidates:** higher-value modules; use cases; buyer priorities; fastest-growing sub-segments; operating bottlenecks; channel economics; cost components; competitive differentiators; regional factors; methodology framework. Examples: `<h3>`Higher-Value Analytics Modules`</h3>`, `<h3>`Potential Costs of Unplanned Downtime`</h3>`, `<h3>`Competitive Differentiation Is Moving Toward`</h3>`.
>
> If several related points are short: H2 → introductory paragraph → H3 → bullets → analytical interpretation may be appropriate. Another H2 may use only analytical paragraphs when that reads better. The goal is visual and analytical rhythm — the article must NOT become a continuous H2 + paragraph + paragraph sequence with no visual variation.
>
> Use maximum 2–3 blockquotes, only for strategic conclusions, e.g.:
> ```html
> <blockquote>
>   <p><strong>The market is moving from basic visibility toward operational intelligence.</strong></p>
> </blockquote>
> ```
> These are editorial callouts — do not invent executive quotations, do not overuse.
>
> Major sections should generally follow: FACT → MECHANISM → BUSINESS IMPLICATION → COUNTER-RISK where relevant. Do not stop at facts — explain what changed, why it changed, who benefits, what it means commercially, what could weaken the trend. Avoid generic filler such as "Technology adoption is increasing." Explain the economics behind the change.
>
> **Every strong quantitative or market-structure claim must be traceable to a specific source** — including: market share; platform concentration; "top X players account for Y%"; penetration rates; dominant segment percentages; fastest-growing segment claims; number of participants; transaction counts; active-user counts; adoption percentages; average commission rates; take rates; regulatory deadlines; historical CAGR; operating ratios; installed-base figures.
>
> Before using such a claim, confirm it appears in the primary Ken Research report, a verified adjacent Ken Research report, or an authoritative external source. Preserve the exact year, unit, scope, geography, denominator where relevant. Attribute the claim where attribution improves clarity. If exact support cannot be verified: REMOVE the number, OR rewrite the statement qualitatively.
>
> Example — if verified: *"The five core national platforms represented approximately `<strong>`96%`</strong>` of aggregator GMV in `<strong>`2024`</strong>`."* If NOT verified: *"The market is concentrated among a small group of national platforms."* Never retain a precise number merely because it sounds authoritative — strong claims must survive source verification before publication.
>
> Do not over-repeat the exact complete market name — use natural semantic variations. Example: exact "Nigeria Fleet Management Analytics Market" → alternatives "Nigeria's fleet analytics market", "fleet technology market", "connected-fleet analytics", "fleet-management software", "telematics and analytics sector", "the market", "fleet technology ecosystem." Do not optimize to a fixed keyword-density percentage or repeat the exact market name in every heading — prioritize readability, entity clarity, topical depth, semantic coverage.
>
> Search the live Ken Research catalog. Never guess an internal URL. For each candidate: confirm the page exists; confirm URL resolves; confirm relevance; prefer country-specific reports where appropriate; prefer the most specific relevant market; avoid unrelated cross-country pages just to create links. Identify the publication year/date of the adjacent report where available; prefer the newest relevant adjacent report when multiple versions exist.
>
> **Normal architecture:** ONE Ken Research homepage branding link; ONE Primary Report link (final CTA); THREE genuinely relevant adjacent Ken Research report links inside the body. Normal total ≈ 5 Ken Research-domain link placements. Optional fourth adjacent report only if it represents a genuinely separate and valuable topic — never force a link to hit a quota.
>
> Use descriptive anchors. GOOD: `<strong>`Nigeria logistics and warehousing market`</strong>`, `<strong>`Nigeria supply chain technology market`</strong>`, `<strong>`Netherlands AgriTech smart irrigation market`</strong>`. BAD: click here, read more, this report, market, logistics, e-commerce. Do not repeat the same commercial anchor unnecessarily.
>
> Adjacent Ken Research report links must be distributed across DIFFERENT meaningful H2 sections. Do NOT place: 2 adjacent links in the same paragraph; 2 adjacent links in back-to-back paragraphs; adjacent links in immediately consecutive short sections; multiple adjacent-report links inside one short H2 section; multiple links simply because several URLs were discovered.
>
> Do NOT place hyperlinks directly inside H1 or H2 heading text — place contextual internal links naturally inside body paragraphs beneath the relevant H2.
>
> **Preferred distribution:** INTRODUCTION — Paragraph 1: Ken Research homepage branding link (mandatory first-mention); Paragraph 3: Adjacent report #1. EARLY/EARLY-MIDDLE H2: Adjacent report #2 + a meaningful content gap. MIDDLE H2: Adjacent report #3 + a meaningful content gap. LATER H2: optional adjacent report #4 (only if a genuinely distinct, valuable topic, only significantly later). END: Primary Report CTA.
>
> Whenever practical, keep at least 2 normal analytical paragraphs OR 1 substantial H2/H3 section between adjacent Ken Research report links. The article must never visually resemble an SEO link cluster.
>
> Adjacent Ken Research links should do more than function as navigation — where a related report contains genuinely relevant evidence, use it as contextual corroboration. **Preferred patterns:**
> - *"A similar shift is visible in the `<strong>`2026`</strong>` `<a href="[VERIFIED URL]"><strong>Ken Research [Related Market Name]</strong></a>` assessment, where [SUPPORTED RELATED FINDING]."*
> - *"This pattern is consistent with the `<strong>`2026`</strong>` `<a href="[VERIFIED URL]"><strong>Ken Research [Related Market Name]</strong></a>`, which identifies [SUPPORTED ADJACENT TREND]."*
> - *"Related `<strong>`Ken Research`</strong>` analysis published in `<strong>`2026`</strong>` also points to [SUPPORTED TREND], providing broader context for [CURRENT ARTICLE CLAIM]."*
>
> Rules: mention the adjacent report's publication year when available and useful; prefer the newest relevant adjacent report; do NOT invent a supporting statistic; do NOT claim an adjacent report "confirms" the primary estimate unless it genuinely validates the same metric. Prefer careful wording: "is consistent with", "shows a similar pattern", "provides adjacent evidence", "offers broader context", "reinforces the operating trend." Avoid overstating with "proves"/"confirms"/"verifies" unless genuinely supported.
>
> If quoting a specific number from an adjacent report: verify the exact number; preserve its exact year, unit, market scope; bold the visible number; make clear it belongs to the adjacent market. Adjacent Ken Research research is contextual evidence and does not replace an official source when an official/regulatory/statistical claim requires primary validation.
>
> BAD internal linking: *"The wider `<a href='URL'><strong>Poland e-commerce market</strong></a>` is also growing."* BETTER: *"This channel expansion is consistent with the `<strong>`2026`</strong>` `<a href='URL'><strong>Ken Research Poland Online Groceries and Quick Commerce Market</strong></a>` assessment, which also points to growing demand for digitally coordinated convenience purchases. For delivery aggregators, this creates additional ordering occasions beyond restaurant meals."*
>
> Every adjacent internal link should ideally contribute meaning, recency, context or corroboration — not merely SEO navigation.
>
> **=== ADJACENT REPORT PHRASING DIVERSITY — MANDATORY ===**
>
> The contextual-corroboration examples above are examples only — do NOT turn them into a repeated sentence template. Adjacent citations must NOT repeatedly follow the same construction such as "This direction is consistent with the [Month Year] Ken Research...", "The same pattern is visible in the [Month Year] Ken Research...", "A similar shift is visible in the [Month Year] Ken Research...", "The [Month Year] Ken Research [Market] assessment...", "Related Ken Research analysis published in [Year]..." — these may be used occasionally when they genuinely read well, but must NOT become the default structure.
>
> For each adjacent report, choose the most natural editorial role: broader market context; supporting demand signal; technology overlap; supply-side evidence; channel-development context; regional/geographic context; operating-economics context; buyer-behavior context; infrastructure context; strategic adjacency.
>
> **Possible integration styles:**
> - A. Direct contextual integration: *"The expansion of the `<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>` also increases demand for [specific relevant capability]."*
> - B. Supporting evidence: *"Broader evidence from the `<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>` shows how [supported related trend], which matters here because [implication]."*
> - C. Technology overlap: *"This operating model overlaps with trends in the `<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>`, particularly around [technology/process]."*
> - D. Supply-side context: *"On the supply side, the `<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>` adds context around [supported supply-side factor]."*
> - E. Comparative signal: *"A related shift can be seen in the `<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>`, where [supported adjacent trend]."*
> - F. Natural continuation: *"That same infrastructure is also relevant to the `<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>`, because [specific connection]."*
> - G. Evidence-first sentence: *"[Supported adjacent finding]. This is reflected in the `<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>`."*
>
> **MANDATORY VARIATION RULES:** Do NOT begin multiple adjacent-report sentences with the same phrase. Do NOT use the same grammatical structure for all adjacent links. Do NOT force the words "Ken Research" into every adjacent-link anchor — if visibly written it must still be bold per the existing rule. Publication month/year is OPTIONAL, not mandatory phrasing — mention only when recency materially improves credibility. Do NOT mechanically place "[Month Year] + Ken Research + Report Name + assessment" around every internal link. At least 2–3 different editorial integration styles should be used across the adjacent links in a typical article. The sentence containing the link should still read naturally and add analytical value if the hyperlink were removed. Natural editorial flow > repeating brand/date language. Preserve source accuracy, recency, claim traceability and contextual value while varying the phrasing.
>
> Objective: CONTEXTUAL EVIDENCE + NATURAL EDITORIAL FLOW + LINK VALUE — not REPEATED CITATION TEMPLATE + SEO FOOTPRINT.
>
> Use approximately 2–3 authoritative external links, preferring: regulator; government agency; national statistics body; central bank; transport/port authority; customs authority; official ministry; primary institutional source. Anchor the actual organization/regulation name, use normal editorial links. Do NOT automatically add `rel="nofollow"` to genuine official editorial citations — only when there's a real reason.
>
> Do NOT use: URL shorteners; discovery-call links; repeated homepage links; excessive primary-report links; irrelevant report links; naked URLs; large related-report blocks; links purely for SEO; repeated anchors. Article must be informational first and commercial second.
>
> If companies are discussed: use only supported participants; do not fabricate market shares; do not rank without reliable evidence; do not call a company #1 without evidence; describe as an unranked participant set when appropriate. A concentration statistic like "Five platforms represent `<strong>`96%`</strong>`" must pass the STRONG CLAIM TRACEABILITY rule.
>
> Explain what competition is based on: price; technology; integrations; network; distribution; analytics; local support; reliability; customer acquisition; compliance; product depth; recurring revenue; service quality; data capability. Competition analysis must explain economics, not just list names.
>
> Where regulation matters, explain: regulation/program; administering authority; relevant scope; operational requirement; effect on buyers/providers; demand implication; cost implication; compliance burden; possible entry barrier; competitive differentiation. Use official sources where possible — do not write vague statements like "Government regulation supports the market."
>
> Every article needs meaningful downside analysis. **Relevant risks may include:** affordability; inflation; currency; regulation; input costs; energy; talent shortage; financing; fragmented infrastructure; implementation complexity; utilization; customer acquisition; margin compression; demographics; adoption barriers; cybersecurity; privacy; data governance; supply-chain risk. Use only risks relevant to the market. Article must not read like promotion.
>
> Near the end include a market-specific monitoring section where appropriate:
> ```html
> <h2>What [Relevant Stakeholders] Should Watch Through <strong>[Forecast Year]</strong></h2>
> ```
> Start with one analytical paragraph, then approximately 5–7 bullets, each `<strong>`Indicator:`</strong>` why it matters. Do not create an H3 for every indicator.
>
> Include a dedicated **Market Outlook** section — must summarize market direction; include base/forecast values where useful; identify structural opportunity; identify major risk; explain upside conditions; explain downside conditions; translate forecast into business meaning. Do not simply repeat the introduction.
>
> Always include:
> ```html
> <h2>Research Basis and Data Status</h2>
> ```
> Clearly state: report publication date/period; base year; forecast period; methodology; respondent count if available; validation approach where published; proprietary status of estimates; government statistics separately sourced; company-reported information distinct.
>
> If useful include:
> ```html
> <h3>Research Framework</h3>
> <ul>
>   <li>Provider mapping</li>
>   <li>Industry indicators</li>
>   <li>Pricing analysis</li>
>   <li>Regulatory research</li>
>   <li>Primary interviews</li>
>   <li>Supply-demand reconciliation</li>
>   <li>Market-model validation</li>
> </ul>
> ```
> Use ONLY methodology actually supported by the report.
>
> Use ONE final commercial CTA — normally the ONLY place the Primary Report URL is linked:
> ```html
> <p>
>   <strong>
>     <a href="[PRIMARY REPORT URL]">Explore the [Market Name] report</a>
>   </strong>
>   for detailed segmentation, competitive coverage and forecast assumptions.
> </p>
> ```
> Do NOT add: discovery call; newsletter; Preferred Source CTA; generic homepage CTA; second sales CTA; URL shortener. (The actual Preferred Source CTA is inserted separately, downstream, by `blogPreferredSourceAgent.ts` — see §6.)
>
> Do NOT automatically add FAQs — add only if genuine questions remain unanswered, provide incremental value, and address separate user intent. Do not repeat market size/CAGR/segments just to create FAQ content.
>
> No target platform will be provided — always create a platform-neutral master article. Use: clean HTML; semantic H1/H2/H3; paragraphs; bullet lists; limited blockquotes; one snapshot image; descriptive alt text. Do NOT use: HTML tables; Markdown tables; platform-specific widgets; custom scripts; complex CSS; platform-only embeds. The master article must be easy to adapt later for LinkedIn, Medium, Blogger, HackMD, KenResearch.com.
>
> The FINAL ARTICLE must use pure HTML only. **The FINAL ARTICLE must be a FLAT sequence of top-level block tags only** — `<h1>`, `<p>`, `<h2>`, `<h3>`, `<ul>`, `<li>` — with the `<h1>` as the very first tag. Do NOT wrap the article, or any part of it, in `<article>`, `<div>`, `<section>`, or any other container tag. Every heading and paragraph must be a direct, unwrapped top-level element.
>
> Inside final article HTML: do NOT use Markdown bold, do NOT use Markdown links. Use `<strong>...</strong>` and `<a href="...">...</a>`. Final HTML must not mix Markdown and HTML.
>
> Do not use fake AI-search tricks — optimize through clarity and evidence. Ensure: clear market/entity definition; explicit scope; factual statements; years attached to numbers; units attached to numbers; direct attribution; clear segment leadership; mechanism explanation; meaningful headings; official sources; proprietary vs official distinction; risk analysis; methodology transparency; forecast assumptions. Do not artificially manufacture repetitive 40-word answer snippets — write naturally for human readers first.
>
> **Before output, silently verify** (self-audit checklist covering): CONTENT (correct market, newest consistent dataset, base value, forecast, CAGR, years correct, segment claims supported, drivers/mechanisms explained, business implications included, risk included, competition not falsely ranked, strong claims traceable, regulation sourced, methodology included, proprietary estimates identified) · STRUCTURE (dynamic market-specific architecture, industry-specific H2s, 2–5 useful H3s distributed naturally, useful bullets, not paragraph-only, not list-heavy, paragraphs not fragmented or walls of text, blockquotes limited, no generic filler, no keyword stuffing) · BOLDING (every visible number/year/percentage/currency/count/unit/Ken Research bold) · BRANDING (homepage linked exactly once, first natural mention linked, homepage not repeated) · PRIMARY REPORT (not linked in introduction, not repeatedly linked in body, linked in final CTA) · INTERNAL LINKS (3 adjacent reports discovered and verified, optional 4th only if valuable, no guessed URLs, descriptive anchors, placed in different H2 sections, no back-to-back links, no link clusters, publication year used where useful, contextual corroboration where supported, no overstated "confirms/proves" language, no repeated opening phrase, month/year not mechanically repeated, "Ken Research [Report] assessment" not a fixed formula, at least 2–3 different integration styles, sentences remain natural without the hyperlink, no repeated "This direction is consistent with..." pattern) · STRONG CLAIMS (market-share/concentration/adoption/participant-count/regulatory-deadline/commission-rate claims all traced, unsupported precision removed or softened) · EXTERNAL LINKS (2–3 authoritative links, exact claims supported, official sources preferred, no forced links, no automatic nofollow) · LINK HYGIENE (no shortener, no discovery call, no link farm behavior, one final CTA) · HTML (exactly one H1, valid H2/H3 hierarchy, valid paragraphs/lists/blockquotes, snapshot image is a bare `<img src="YOUR_IMAGE_URL_HERE" alt="...">` with no figure/figcaption/width/height/loading, descriptive alt, no table, no Markdown inside HTML, no broken tags, only image placeholder = YOUR_IMAGE_URL_HERE, no citation/source chips like "kenresearch.com +1" anywhere in the SEO Title/Meta Description/Key Snapshot Metrics).
>
> **Return exactly:** SEO Title / Meta Description / Primary Search Intent / Primary Keyword / Secondary Semantic Topics / Suggested Snapshot Image Alt / **Key Snapshot Metrics for Image** (5–7 supported metrics in the exact mandated formats above, never freeform) / **Internal Link Map** (for each: Anchor, Verified URL, Report publication date/year if available, Intended H2 section, Why relevant, Supporting contextual trend/claim if available — include the homepage link, Primary Report as final CTA, Adjacent #1/#2/#3, optional #4 only if necessary) / **External Source Map** (for each: Source/anchor, Official URL, Claim supported, Intended placement) / **FINAL ARTICLE** (ONE complete clean HTML article).
>
> Research first. Verify second. Verify every strong quantitative claim. Silently create three possible market-specific structures. Choose the strongest structure. Write ONE complete article. Keep the formatting quality standard: paragraphs + industry-specific H2s + selective H3s + useful bullet lists + limited strategic callouts. Place adjacent Ken Research links in different meaningful H2 sections. Do not place adjacent internal links back-to-back. Use adjacent Ken Research reports as contextual, recent, carefully worded supporting evidence where their content genuinely supports the point. Do NOT overstate adjacent research as proof of the primary-market claim. Do NOT let structural variation reduce quality. Audit the article against every rule. Fix violations silently. Then return the final output.
>
> Do NOT ask for a reference article. Do NOT ask for a target platform. Do NOT output multiple full article variations. Do NOT make every industry look structurally identical. Do NOT sacrifice facts, SEO, AIO quality, readability, sourcing, information gain or editorial formatting merely to create variation.

*(Note: the file also still contains the pre-2026-09-18 `OLD_buildMasterBlogPrompt`/`OLD_buildMasterBlogPromptV2` bodies as dead code, kept for reference/rollback only — not transcribed here since they're never invoked.)*

#### 3.3.2 Prompt B pool (4 variants, added 2026-09-25)

Sourced from "Different Prompts for LinkedIn Articles.docx", each targets 800–1000 words for CXOs/founders/decision-makers, and each is followed by the **same shared output-format suffix** so the extraction logic (§3.4) parses either the master prompt or any Prompt B variant identically:

**Shared suffix (`PROMPT_B_OUTPUT_FORMAT`, appended to every variant below):**
> OUTPUT FORMAT (mandatory) — return exactly the following sections, in this order, each under its own heading line exactly as written below. Do not add commentary before "SEO Title" or after the closing tag of the FINAL ARTICLE HTML.
>
> **SEO Title** — A search-facing title, distinct from the article's own H1/headline. Must be unique, punchy, search-intent aligned. Do not include "Ken Research" in it.
>
> **Meta Description** — A single-paragraph meta description (under 160 characters) summarizing the article for search results.
>
> **Primary Search Intent** — One line naming the primary search intent this article satisfies.
>
> **Primary Keyword** — The single primary target keyword.
>
> **Secondary Semantic Topics** — A short list of secondary semantic topics/keywords covered.
>
> **Suggested Snapshot Image Alt** — One descriptive alt-text line for the article's snapshot image.
>
> **Key Snapshot Metrics for Image** — 5-7 supported metrics, one per line, each in the exact format "Label: Value" (e.g. "Market Size 2025: USD 1.2 Billion", "CAGR 2025-2030: 8.4%", "Top Segment Share: Skincare 34%", "Key Player: PlayCore") — never freeform prose, never a citation chip (bare domain or "+N") as its own line.
>
> **Internal Link Map** — For each Ken Research link used in the article: Anchor / Verified URL / Report publication date or year if available / Intended H2 section / Why relevant / Supporting contextual trend or claim if available. Include the Ken Research homepage branding link, the Primary Report as the final CTA, and 2-4 adjacent report links.
>
> **External Source Map** — For each external (government/official) source used: Source or anchor / Official URL / Claim supported / Intended placement.
>
> **FINAL ARTICLE** — ONE complete, clean HTML article — use `<h1>` for the title, `<h2>`/`<h3>` for subheadings, `<p>` for paragraphs, `<ul>`/`<li>` for lists, and `<a href="...">` for every interlink. No markdown syntax anywhere inside the HTML (no #, **, -, etc.).

**Variant 1 — `visionary-forecast`** ("The Visionary Forecast / Future-Casting"):
> Role & Task: Act as an expert B2B content strategist and futurist. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Key Stats/Data: research and extract the current market size, CAGR, and forecast figures directly from the URL above. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Storytelling Angle: The Visionary Forecast (Future-Casting). Focus on horizon scanning, 3-to-5-year market shifts, and strategic foresight. The narrative should be: "Look beyond the current quarter; here is what the autonomous/cognitive ecosystem of the future looks like and how to prepare your board." Tone: Visionary, forward-looking, yet grounded in the provided data. Professional and boardroom-ready. Optimization Rules: SEO: Optimize H-tags for long-tail future-focused keywords. AIO/AEO: Use a "Current State vs. Future State" comparison list for easy AI parsing. GEO/LLM: Establish strong semantic relationships between current technologies and future outcomes. Use clear, definitive language. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research foresight or macro-trend reports. End with a strong CTA: "Schedule a strategic foresight session with Ken Research analysts to align your long-term vision with market realities."

**Variant 2 — `industry-blind-spot`** ("The Industry Blind Spot"):
> Role & Task: Act as an expert B2B content strategist and industry insider. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., regulatory changes, compliance data, .gov policy shifts, national audit reports) to expose the gap between the surface-level industry narrative and the underlying data reality. Storytelling Angle: The Industry Blind Spot. Do NOT use a confrontational "your strategy is failing" tone. Instead, use a revelatory, insider-intelligence writing style. The narrative should be: "The entire industry is collectively optimizing for the wrong metric and chasing the wrong trend. Here is the hidden data pattern that almost every board is overlooking, and the massive first-mover advantage available to the few leaders who see what others cannot." Frame the reader as the smart insider who "gets it," not as someone being lectured. Tone: Sophisticated, revelatory, calm but compelling. Think "exclusive briefing from a trusted advisor," not "aggressive thought leader shouting on LinkedIn." The authority should come from the depth of the data, not from provocative language. Formatting Rules: CRITICAL BULLET POINT RULE: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Structure using a "Surface Narrative vs. Underlying Data Reality" framework instead of the overused "Myth vs. Reality" format. This unique structure is more likely to be cited by AI answer engines as a novel perspective. GEO/LLM: Use objective, data-backed assertions with clear causal reasoning. Ensure the logical bridge between "what the industry believes" and "what the government/market data actually shows" is airtight for LLM comprehension. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research deep-dive analytical or sector-specific reports. End with a strong CTA: "Consult Ken Research for a bespoke market intelligence deep-dive to uncover the blind spots your competitors have not yet identified."

**Variant 3 — `regulatory-policy-catalyst`** ("The Regulatory Catalyst"):
> Role & Task: Act as an expert B2B content strategist and corporate policy advisor. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., new policy frameworks, subsidy allocations, national compliance mandates, .gov economic surveys) to highlight the regulatory catalyst. Storytelling Angle: The Regulatory Catalyst. The narrative should be: "Government policy is the ultimate market mover. Here is how recent regulatory shifts and national mandates are creating an asymmetric advantage for early movers, and how to align your corporate strategy with the new rules of the game." Tone: Strategic, risk-aware, highly professional, and policy-literate. Formatting Rules: CRITICAL BULLET POINT RULE: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Use a "Policy Shift -> Market Impact -> Strategic Action" structure. Detailed lists are critical here for Answer Engine parsing. GEO/LLM: Clearly define the relationship between government policy (entity 1) and market outcomes (entity 2) for LLM context. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research regulatory impact, market entry, or policy analysis reports. End with a strong CTA: "Access the Ken Research Policy Impact Toolkit to align your corporate strategy with the latest regulatory frameworks immediately."

**Variant 4 — `ecosystem-map`** ("The Ecosystem Map / Strategic Alignment"):
> Role & Task: Act as an expert B2B content strategist and M&A/strategy advisor. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., cross-border trade data, foreign direct investment stats, .gov economic surveys) to map out the macro-synergies. Storytelling Angle: The Ecosystem Map (Strategic Alignment). Focus on cross-industry convergence, M&A targets, and macro-synergies. The narrative should be: "Industry boundaries are dissolving. Here is how different sectors are intersecting, and where the hidden alpha lies for founders and investors." Tone: Strategic, big-picture, investor/boardroom-focused, and highly professional. H2/H3 Tag Optimization Rules (CRITICAL): ZERO Generic Headings: Do NOT use "Market Trends", "Synergies", "Industry Overlaps", "Key Takeaways", or "Conclusion". Convergence-Driven H2s: Every H2 must highlight a specific intersection of industries, M&A activity, or macro-synergy using strong semantic keywords. (e.g., Instead of "New Partnerships", use "Mapping the Convergence: How Retail and Logistics are Merging into Retail-as-a-Service (RaaS)"). AEO/GEO Structure: Use H2s to define the specific ecosystems being mapped. Use H3s to break down the exact M&A targets, joint venture structures, or capital flows within that ecosystem. Ensure H2s act as direct, semantic answers to investor and CXO queries. Formatting Rules: Crucial Bullet Point Rule: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Use a "Key Intersections" bulleted list to clearly map out the converging sectors for AI summarization. GEO/LLM: Focus on entity relationships (e.g., how Sector A impacts Sector B). Use authoritative, analytical language that signals high expertise to Generative Engines. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research ecosystem, market mapping, or M&A reports. End with a strong CTA: "Download the Ken Research Ecosystem Map to discover untapped M&A and joint venture opportunities in your sector."

Registry:
```ts
const PROMPT_B_BUILDERS = [
  { name: 'visionary-forecast', build: buildPromptB_VisionaryForecast },
  { name: 'industry-blind-spot', build: buildPromptB_IndustryBlindSpot },
  { name: 'regulatory-policy-catalyst', build: buildPromptB_RegulatoryPolicyCatalyst },
  { name: 'ecosystem-map', build: buildPromptB_EcosystemMap },
];
const PROMPT_B_ROTATION_CHANCE = 0.5;
```

### 3.4 Orchestration — `generateBlogViaChatGpt()` step by step

1. `accountName = params.accountHandle || DEFAULT_BLOG_ACCOUNT` → `sessionDirForAccount(accountName)` → `.sessions/chatgpt-accounts/<accountName>`.
2. `fs.mkdirSync(sessionDir)`, then `killChromeForProfile(sessionDir)` to clear any stale Chrome process locking the profile.
3. Launches its **own** `chromium.launchPersistentContext` — headless: false, viewport 1366×900, `ignoreDefaultArgs: ['--enable-automation']`, args include `--disable-blink-features=AutomationControlled`, `--no-first-run`, `--no-default-browser-check`, `--disable-infobars`, `--window-size=1366,900`, `--window-position=0,0`. Uses `CHROME_PATH` env var or `C:\Program Files\Google\Chrome\Application\chrome.exe`, falling back to Playwright's bundled Chromium if that path doesn't exist.
4. Opens/reuses a page, `minimizeToTaskbar()` (best-effort CDP window-minimize, silently ignored on failure), navigates to `https://chatgpt.com/new`, waits 2s.
5. `logChatGptSessionState(page)` — diagnostic only, logs whether the composer is visible; never blocks/aborts.
6. Starts `startContinuousPopupWatcher(page)` — a background loop calling `dismissBlockingModals(page)` every 1500ms for the tab's whole lifetime, stopped in `finally`.
7. **Prompt selection** — the 50/50 coin flip described in §3.3 above.
8. `pasteIntoChatGptComposer(page, prompt)` (from `src/utils/chatgptComposer.ts`) types/pastes into `COMPOSER_SELECTOR`; waits 1s; `dismissBlockingModals(page)` again right before sending ("a blocking modal can re-render itself seconds after being removed"); clicks `SEND_BUTTON_SELECTOR` or falls back to `Enter`, retrying once after another modal-dismiss if the first click throws.
9. `waitForBlogCompletion(page)` — polls every 60s up to 15 times (~15 min hard cap). Each poll: clears popups, checks `STOP_BUTTON_SELECTOR` visibility ("still writing" vs "looks finished"), reads the last assistant message text. Three completion/failure signals: (a) stop button gone for 2 consecutive checks with text >500 chars → done; (b) text length unchanged for 3 consecutive checks (even if stop-button check is stuck) → done; (c) text stuck under 500 chars and unchanged for 2 checks while not "stopping" → throws `STALLED: ChatGPT response stuck at ${text.length} characters across 2 consecutive checks...`.
10. `extractBlogStable(page, title)` — see §3.5.
11. **Preamble/refusal detection & nudge**: if the extracted HTML has no `<h1>`/`<h2>`, ChatGPT is judged to have replied with an acknowledgement instead of the article. Detects a refusal via `/unable to complete|cannot complete|not available from|could not be verified/i`, then sends this exact nudge and re-runs completion+extraction once:
    > That reply is not an accepted output. Explanations, acknowledgements and "unable to complete" messages are failed responses. Apply the MANDATORY PROCEDURE FOR SURVEY / SERVICE / METHODOLOGY INPUTS from the prompt: derive the adjacent market from REPORT_TITLE and the page geography (drop words like survey, buyer experience, feedback, study), search the open web for that market's size, CAGR and forecast, lock the DATA_SPINE from verified pages, and present those figures as Ken Research market intelligence. Use the survey topic as the article's analytical angle. Now output only the deliverable defined under "Return exactly": SEO Title, Meta Description, Primary Search Intent, Primary Keyword, Secondary Semantic Topics, Suggested Snapshot Image Alt, Key Snapshot Metrics for Image, Internal Link Map, External Source Map, then FINAL ARTICLE with the complete clean HTML article. Nothing else.

    If it *still* doesn't look like an article, throws `PREAMBLE_ONLY: ChatGPT replied with an acknowledgement instead of the article, even after a "proceed" nudge.`
12. **Blocked-response detection**: `html.includes('RESEARCH BLOCKED')` or `'Primary report could not be verified'` → throws `RESEARCH_BLOCKED: ...`. `html.includes('LINK VALIDATION BLOCKED')` → throws `LINK_VALIDATION_BLOCKED: ...`.
13. Generic guard: `if (!html || html.length < 100) throw new Error('No HTML content extracted from ChatGPT response')`.
14. **On success**: `recordChatGptSuccess()`, returns `{ title, description, html: injectBlogUtm(sanitizeHtml(html)), seoTitle, imageData }` (all four other fields also `sanitizeHtml`'d).
15. **On any thrown error**: `recordChatGptFailure()` is called; if that decided to rotate accounts, `(rotated out — next attempt uses "<account>")` is appended to the error message; the error is re-thrown to `blogGenLoop.ts`.
16. `finally`: stops the popup watcher, `context.close()`.

### 3.5 Extraction

`SECTION_LABELS` (used to slice the plain-text reply into blocks):
```
SEO Title, Meta Description, Primary Search Intent, Primary Keyword,
Secondary Semantic Topics, Suggested Snapshot Image Alt,
Key Snapshot Metrics for Image, Internal Link Map, External Source Map,
FINAL ARTICLE
```
`extractLabeledSection(text, label)` finds the line that exactly (case/whitespace-insensitively) matches `label`, then takes every following line up to (not including) the next line matching any *other* label — a plain-text, label-delimited parser (not regex/markdown-aware).

`extractBlog(page, fallbackTitle)`:
- Reads `document.querySelectorAll(ASSISTANT_MESSAGE_SELECTOR)`, takes the **last** match, reads its `innerText` (and any `pre code`/`pre` block's `textContent`).
- If under 100 non-whitespace chars, falls back to searching the whole `document.body.innerText` for the last occurrence of the literal string `'SEO Title'` and slicing from there — a defensive fallback for when the assistant-message selector itself fails to match the current ChatGPT DOM.
- Strips a "citation chip" pattern (`/\s*(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*\+\d+)?\s*$/i`) off the tail of SEO Title / Meta Description (ChatGPT's web-search citation pills like "kenresearch.com +1" leaking into plain text), and drops any metrics-block line that is *entirely* a citation chip.
- HTML extraction: finds where `FINAL ARTICLE` starts on its own line; everything before that (SEO Title, link maps, source maps) is never mistaken for the article body. If the assistant message has a `<pre><code>` block containing `<`, that's used verbatim; otherwise takes from the first `<` to the last `>` in the post-"FINAL ARTICLE" text (drops ChatGPT UI chrome like "ChatGPT can make mistakes"/"Sources").
- `blogTitle` from the first `<h1>` (tags stripped) → falls back to `seoTitle` → falls back to the caller's `fallbackTitle`. `description` from Meta Description → falls back to the first `<p>` truncated to 170 chars.

`extractBlogStable`: re-extracts up to 4 times (clearing popups before and after each pass), only accepting the result once two consecutive passes agree exactly on `html.length` — protects against a popup mid-scrape silently truncating the DOM read. Uses the last extraction anyway (with a warning) if it never stabilizes.

`sanitizeHtml(html)`: fixes `%22`-encoded closing quotes, collapses ChatGPT's occasional doubled `href=""..."" ` quoting bug down to single quotes, strips `:contentReference[...]{...}` web-search citation artifacts.

`injectBlogUtm(html)`: `injectUTM(html, UTM_PARAMS.LinkedinPulse)` — every kenresearch.com link gets a fresh LinkedIn-Pulse UTM tag (this is a base/default UTM only; platform posters presumably override it downstream).

### 3.6 Popup handling

`GENERIC_POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"]'`. `clearPopups()` calls `dismissBlockingModals()` then, while a popup is still visible, presses Enter and waits 600ms, up to 8 times. `startContinuousPopupWatcher(page)` runs `dismissBlockingModals` every 1.5s for the tab's entire life, returning a stop function.

---

## 4. Blog COVER IMAGE generation — `src/agents/blogImageAgent.ts` (796 lines)

### 4.1 Account

```ts
const DEFAULT_IMAGE_ACCOUNT = 'account2';
```
Deliberately a **different** ChatGPT account from blog text's `social-image`, so the two always run in separate Chrome profiles/windows and can run concurrently without colliding.

### 4.2 The two prompts

`buildImagePrompt(name, reportUrl, promptChoice)`: `promptChoice === '2' ? imagePrompt2(...) : imagePrompt1(...)` — **'1' is the default** (`blogGenLoop.ts` passes `opts.imagePromptChoice ?? '1'`).

#### 4.2.1 Image Prompt 1 (default) — full text, interpolates `${name}` (market/report title) and `${reportUrl}`

> Act as a senior market researcher and premium editorial data-visualization designer.
> Your task is to independently research the supplied market, validate its most important statistics, select an industry-appropriate visual identity, and create a production-ready market-intelligence cover image.
>
> **USER INPUT** — Market/Report Title: "${name}"; Primary Report URL: "${reportUrl}"; Current Year: use the actual current year. Do not ask the user to supply market values, CAGR, forecast figures, statistics, colors, or visual concepts — research and select them yourself.
>
> **PHASE 1: MARKET RESEARCH.** Before generating the image, search the internet and verify the market information. Research in this priority order: open and analyze the exact Primary Report URL; use official government departments, regulators, statistical agencies, and ministries; use recognized multilateral organizations such as the World Bank, WHO, OECD, IEA, ITU, FAO, UN agencies, or regional authorities where relevant; use credible industry associations, public company filings, and authoritative sector publications; avoid using competing market-research-company pages when the supplied report or official sources provide the required data.
>
> **Find and validate the following:** correct market name and geographic scope; base year; base-year market value; forecast year; forecast market value; forecast CAGR; leading product/technology/application/channel/segment; one verified market-share or adoption statistic; two or three additional quantitative market indicators; one important qualitative trend if a reliable numerical statistic is unavailable. Possible supporting indicators: unit shipments; user/subscriber count; online channel share; production volume; installed capacity; average selling price; technology adoption; import/export value; regulatory target; infrastructure coverage; premium-product adoption; digital penetration; regional contribution.
>
> **DATA-VALIDATION RULES.** Never fabricate a market value, CAGR, percentage, year, unit, currency, or forecast. Never mix global data with country-/region-specific data. Never mix adjacent markets unless clearly disclosed. Keep market definitions, geography, currency, base year, forecast period consistent. Give priority to the exact supplied report when credible sources show different estimates. Recalculate the CAGR when base and forecast values are available: `CAGR = ((Forecast Value ÷ Base Value) ^ (1 ÷ Number of Years) − 1) × 100`. If the recalculated CAGR materially conflicts with the published CAGR, use the published figure only when the report clearly defines a different forecast period. Do not create intermediate annual values unless published. If only base and forecast values exist, label only those two endpoints. Do not present estimated/interpolated values as published facts. If no reliable valuation exists, use verified adoption/shipment/capacity/penetration/regulatory statistics instead. When reliable numerical data is unavailable, use concise qualitative language rather than inventing a number.
>
> **RESEARCH OUTPUT.** Before generating the image, provide a concise validation table containing: Metric / Selected value / Year / Source name / Direct source URL. Keep this table outside the image — do not display source URLs or citations inside the final cover.
>
> **PHASE 2: INDUSTRY AND COLOR SELECTION.** Identify the market's primary industry and select the color palette yourself. Choose one dominant accent color and one supporting accent color matching the industry's visual language. Suggested direction: Healthcare/medical devices/pharma → crimson, medical red, cyan, or clinical blue. Banking/fintech/insurance → electric blue, violet, cyan, or deep emerald. Renewable energy/sustainability → emerald, teal, or clean green. Oil/gas/mining/heavy industry → amber, copper, orange, or steel blue. Automotive/mobility → electric blue, orange, or metallic cyan. Consumer electronics/ICT/software → violet, indigo, blue, or neon cyan. Food/agriculture/natural products → green, olive, gold, or warm amber. Logistics/warehousing/supply chain → navy, cyan, teal, or orange. Construction/infrastructure → amber, safety orange, yellow, or steel blue. Luxury/beauty/hospitality/travel → magenta, burgundy, gold, or rose. Aerospace/defense → steel blue, graphite, cyan, or restrained red. Education/professional services → blue, indigo, or turquoise. These are guidelines, not fixed assignments — select the palette that best represents the specific market.
>
> **Color requirements:** state the selected industry and hex codes in the research summary; use a dark near-black background; maintain strong contrast between text and background; use the dominant accent for figures/chart lines/icons/highlights; use the supporting accent sparingly for depth; avoid oversaturation and excessive neon; do not automatically use purple for every market.
>
> **PHASE 3: IMAGE GENERATION.** Create a premium 16:9 landscape market-intelligence cover. Generate at 2048×1152 pixels in high quality — composition must remain suitable for export at 1920×1080.
>
> **VISUAL STANDARD.** The cover should resemble a sophisticated editorial intelligence visual from Bloomberg Intelligence, Bain, McKinsey, or a premium financial publication. It must feel: authoritative, data-driven, cinematic, contemporary, photorealistic, executive-grade, suitable for LinkedIn/report promotion/corporate publishing. Follow the canvas architecture and layout rules directly — do not copy products, text, statistics, maps, branding, or exact designs from any outside source.
>
> **CANVAS ARCHITECTURE.** Left information zone ≈ 38–42%. Center/right hero zone ≈ 58–62%. Minimum 6% safe margin on every side. Clear reading sequence: Market title → Base-year valuation → CAGR and forecast → Supporting market insight → Hero visual → Forecast chart → Bottom indicator panel.
>
> **BACKGROUND.** Cinematic dark gradient built from near-black, charcoal, and the selected industry colors. Add: subtle atmospheric haze; restrained volumetric lighting; fine digital texture; soft reflections; faint analytical gridlines; a low-opacity map or geographic outline representing the market region (must remain subtle, must not interfere with the title).
>
> **TITLE AREA.** Render the researched market title EXACTLY. Bold premium geometric sans-serif typeface. Display across two to four balanced lines. Typography treatment: geographic region/country in white; primary market keywords in the dominant accent color; strong contrast; clean spacing; no awkward word breaks; no text touching the canvas edges. Add a short horizontal accent line beneath the title.
>
> **PRIMARY VALUATION.** Display "[VERIFIED BASE-YEAR MARKET VALUE]" / "([BASE YEAR])". Make the market value the most prominent numerical element on the left. White for currency, dominant accent color for the numerical value.
>
> **CAGR AND FORECAST.** Add a clean growth icon and display "[VERIFIED CAGR]% CAGR" / "to [VERIFIED FORECAST VALUE] by [FORECAST YEAR]". Highlight CAGR and forecast value with the dominant accent color; keep supporting text white. If CAGR/forecast can't be verified, remove this block and replace with a verified market indicator.
>
> **SECONDARY MARKET INSIGHT.** Display one concise verified insight, e.g. "Online channel share rising to [VALUE]% by [YEAR]" or "[SEGMENT] accounts for [VALUE]% of demand." Use one simple sector-relevant outline icon. Keep under 12 words wherever possible.
>
> **HERO VISUAL.** Independently determine the most relevant hero scene. Show two to four high-quality visual elements representing the market ecosystem — e.g. products/equipment, relevant infrastructure, digital devices/interfaces, industrial machinery, healthcare technology, vehicles/mobility systems, renewable-energy infrastructure, consumer goods, agricultural environments, logistics facilities. Place the primary hero object near the center-right, smaller supporting objects for depth/context. Requirements: photorealistic; generic and unbranded; realistic materials/proportions; cinematic rim lighting; controlled depth of field; subtle reflections; industry-relevant environment; no copied commercial-product design.
>
> **DATA-VISUALIZATION LAYER.** Integrate a premium upward-trending line/area chart in the upper-right background. Requirements: dominant accent color; subtle glow; restrained gridlines; circular markers only when meaningful; kept visually behind the hero subject; never crosses important text; label only verified values (only base+forecast endpoints if that's all that's known — never invent intermediate figures). At the final data point display "[VERIFIED FORECAST VALUE]" / "[FORECAST YEAR]". If no reliable forecast exists, use a qualitative trend visualization without numerical labels.
>
> **BOTTOM INTELLIGENCE PANEL.** A semi-transparent dark glass panel across the lower-left or lower-middle area. Styling: rounded corners; thin border using the dominant accent; subtle internal glow; clean vertical dividers; high text contrast. Maximum three verified indicators, recommended structure: Indicator 1 "[SHORT LABEL]" / "[CURRENT VALUE] → [FORECAST VALUE]"; Indicator 2 same shape; Indicator 3 "[SHORT LABEL]" / "[VERIFIED VALUE OR SHORT TREND]." One simple outline icon per indicator. No paragraphs, citations, disclaimers, or tiny typography inside this panel.
>
> **TEXT-CONTROL RULES.** Render only the approved title and verified data. Preserve spelling, currency, decimals, units, percentages, years exactly. Do not paraphrase the report title. Do not add random text. Do not repeat a statistic unnecessarily. Do not invent company names. Keep text readable on mobile. Use no more than ~65–75 words across the entire cover. Prefer three accurate statistics over many unreadable ones.
>
> **BRANDING RESTRICTIONS.** No Ken Research name unless explicitly requested. No company names. No logos. No monograms. No trademarks. No watermarks. No branded products. No copied user interfaces. No competitor branding.
>
> **FINAL QUALITY CONTROL.** After generating, inspect carefully — verify: market title spelled correctly; geographic region correct; all figures match the research table; currency units correct; CAGR/forecast years correct; no fabricated values; text legible and correctly placed; no clipped text; no random characters; no logo/brand name; map matches market geography; color palette suits the industry; hero visual accurately represents the market; layout readable at LinkedIn-feed size; chart doesn't imply unsupported annual figures. Repair or regenerate before presenting the final result if anything is incorrect or unreadable.
>
> **NEGATIVE PROMPT:** No fabricated statistics, incorrect market values, conflicting forecast years, fake citations, competitor data presented as primary data, random text, spelling mistakes, tiny paragraphs, clipped typography, duplicate objects, distorted products, inaccurate maps, irrelevant hero visuals, logos, company names, trademarks, watermarks, cluttered dashboards, excessive neon, oversaturated colors, cartoon graphics, cheap stock-photo aesthetics, low resolution, weak contrast, or generic template appearance.
>
> **FINAL RESPONSE.** Return: the research validation table with direct source links; the identified industry; the selected dominant and supporting colors with hex codes; the completed 16:9 cover image. Do not stop after research — proceed directly to image generation once the selected statistics have been validated.

#### 4.2.2 Image Prompt 2 (alternate, `promptChoice='2'`) — immersive/cinematic single-scene layout

> Act as an elite market-intelligence researcher, creative director, and editorial data-visualization designer.
> Create one visually striking, production-ready 16:9 market-intelligence cover for: MARKET TITLE: "${name}"; REPORT URL: "${reportUrl}". REFERENCE STYLE: use this image only as a benchmark for premium quality and data-rich storytelling — not as a layout that must be copied: `https://lh3.googleusercontent.com/d/13G9f9b25YxH3UUniIzHYaBBK3zPo3Dzf`. Complete the research, creative direction, color selection, composition, and image generation as one continuous task — do not stop to present a research table, design plan, or intermediate output. Proceed directly to the finished image.
>
> **RESEARCH AND DATA ACCURACY.** Privately research the market using the supplied report URL as the primary source. Identify: correct market title and geographic scope; most recent reliable market value; valuation year; forecast market value; forecast year; CAGR; one leading segment/channel/technology/application; two additional high-value quantitative indicators. If information is missing, search reliable government sources, regulators, statistical agencies, international organizations, industry associations, and authoritative sector publications. Do not use conflicting competitor-firm estimates when the supplied report has the required info. Never fabricate a value, CAGR, percentage, currency, year, segment share, shipment figure, or forecast. Do not combine statistics from different geographies or adjacent markets. If unverifiable, omit it and use a concise qualitative trend instead. Use no more than five major statistics in the image — prioritize accuracy, relevance, and visual impact over volume.
>
> **AUTONOMOUS CREATIVE DIRECTION.** Identify the industry and independently choose the most appropriate visual language, hero subject, environment, lighting style, data-visualization treatment, and color palette. Choose one dominant industry-appropriate accent color, one complementary supporting color, a dark cinematic background family, and a high-contrast neutral color for typography. Do not automatically use purple, red, or blue for every market. The palette should feel psychologically/commercially appropriate: Healthcare → clinical, trusted, advanced, human. Technology → intelligent, connected, futuristic. Finance → secure, precise, premium. Renewable energy → clean, progressive, sustainable. Industrial markets → powerful, engineered, operational. Consumer markets → desirable, contemporary, energetic. Luxury markets → refined, exclusive, editorial. Logistics → connected, efficient, infrastructure-led. Agriculture → natural, productive, innovation-driven. Automotive → dynamic, engineered, performance-oriented.
>
> **VISUAL CONCEPT.** Create one cohesive full-bleed editorial scene — not a rigid split-screen template and not a collection of disconnected infographic boxes. Immersive, cinematic composition with natural visual flow across the entire canvas. Use an asymmetrical editorial layout that adapts to the market: position the market title within clean negative space; make the industry hero visual the central storytelling element; integrate statistics into the environment instead of a fixed dashboard; allow selected objects/charts/lighting/data signals to visually connect different parts of the composition; maintain balance without an obvious 50/50 division; avoid repetitive "text on the left, product on the right" execution when a more compelling composition is possible.
>
> **HERO SCENE.** Create a photorealistic hero scene that immediately communicates the market. Select the most meaningful combination of: products; technology; infrastructure; equipment; professional users; digital interfaces; geographic context; industrial environments; consumer-use scenarios; supply-chain elements. One dominant focal subject, supported by two or three secondary elements. The primary subject should have: realistic scale/proportions; premium material detail; cinematic rim lighting; natural reflections; controlled depth of field; strong silhouette; clear separation from the background. Build depth using foreground/middle-ground/background layers. Add restrained atmospheric elements where appropriate: volumetric light; soft haze; reflections; subtle particles; network signals; energy trails; data streams; environmental texture; geographic contours. These effects enhance the subject rather than making the image excessively futuristic or artificial.
>
> **DATA STORYTELLING.** Integrate data visualization organically into the hero scene, related to the industry: Technology → network paths, signal waves, connected nodes. Finance → analytical curves, secure transaction flows, digital grids. Energy → capacity curves, power flows, infrastructure networks. Logistics → routes, movement paths, warehouse/port connections. Healthcare → patient pathways, clinical signals, diagnostic interfaces. Automotive → mobility routes, telemetry, charging/traffic patterns. Consumer products → adoption curves, channel growth, product ecosystems. Industrial markets → production paths, capacity indicators, operational systems. Use one principal visualization — a luminous growth curve, a restrained area chart, a geographic data path, a network visualization, an adoption trajectory, or a capacity/volume indicator. Do not add a generic chart simply to fill space. Label only verified values — never invent intermediate annual data points; if only start/forecast values are available, show only those verified endpoints.
>
> **TYPOGRAPHY AND INFORMATION HIERARCHY.** Render the exact market title prominently and verbatim: "${name}". Premium geometric sans-serif typeface, strong kerning, clean line spacing. Break the title into two to four balanced lines, avoiding awkward single-word lines. Clear hierarchy: market title → primary market value → CAGR and forecast value → one high-impact market insight → up to two supporting indicators. Make the market value the strongest numerical element. Suggested data treatment: "[VERIFIED MARKET VALUE]" / "[VALUATION YEAR]"; "[VERIFIED CAGR]% CAGR" / "to [VERIFIED FORECAST VALUE] by [FORECAST YEAR]". All text short, bold, high-contrast, readable at LinkedIn-feed size. Render every required text element exactly once. Do not display source URLs, citations, methodology, paragraphs, or disclaimers inside the image.
>
> **INTEGRATED STATISTIC CALLOUTS.** Display supporting statistics as elegant editorial callouts integrated into available negative space — minimal floating glass capsules; large standalone numbers; fine-line annotations; labels connected to relevant objects; geographic data markers; subtle translucent overlays. Do not create a large bottom dashboard. Do not place all statistics inside identical boxes. Use no more than three supporting callouts, each with a short label and one meaningful value.
>
> **PREMIUM ART DIRECTION.** The final image should feel comparable to a high-end Bloomberg Intelligence feature, global consulting publication, institutional-investor presentation, or premium technology campaign. Aim for: strong visual tension; clear focal hierarchy; sophisticated asymmetry; photorealistic materials; rich but controlled contrast; elegant negative space; cinematic lighting; editorial restraint; modern data storytelling; premium commercial finish. The cover must remain visually engaging even when viewed without reading every statistic.
>
> **OUTPUT REQUIREMENTS.** 16:9 landscape, 1920×1080 pixels, high-resolution rendering, sharp/legible typography, minimum 6% safe margin, no clipped text, no important elements touching the edges. Suitable for LinkedIn, blogs, report pages, PR distribution, and social media.
>
> **STRICT RESTRICTIONS.** No fabricated statistics; no incorrect currencies/years; no competitor market-research figures presented as primary data; no logos; no Ken Research branding unless explicitly requested; no company names; no trademarks; no branded products; no watermarks; no random decorative words; no stock-photo collage; no rigid corporate-template appearance; no large bottom dashboard; no excessive infographic boxes; no crowded composition; no excessive neon; no cartoon/illustration style; no distorted products/people/machinery/infrastructure; no meaningless futuristic holograms; no repeated title or statistics; no unreadable microtext.
>
> **FINAL SELF-CHECK.** Before delivering, visually inspect and confirm: title spelled exactly as supplied; market geography correct; every displayed statistic verified; currency/units/decimals/percentages/years accurate; colors appropriately represent the industry; hero scene clearly communicates the market; statistics feel integrated into the visual story; image doesn't resemble a rigid split-screen template; composition remains clear at thumbnail size; no random text/logo/brand name/watermark; no text clipped, duplicated, misspelled, or unreadable. Repair the image before delivering if anything is wrong.
>
> Return only the completed market-intelligence cover image — no research process, source table, explanation, or design rationale.

### 4.3 `runCoverImageGeneration()` flow

Params: `{ marketName, reportUrl, promptChoice?: '1'|'2', accountHandle?, outputDir? }` → returns `{ localPath, imageText }`.

1. `accountName = params.accountHandle || DEFAULT_IMAGE_ACCOUNT` ('account2'). `promptChoice = params.promptChoice || '1'`. Builds the prompt.
2. `outputDir = params.outputDir || TMP_DIR` (`generated_images/` at repo root), created if missing.
3. `sessionDir = sessionDirForAccount(accountName)`, mkdir, `killChromeForProfile(sessionDir)`.
4. Launches its own `chromium.launchPersistentContext` — viewport 1280×900, `acceptDownloads: true`, `ignoreDefaultArgs: ['--enable-automation']`, `--disable-blink-features=AutomationControlled`, `--no-first-run`, `--no-default-browser-check` (no explicit `--window-size`/`--window-position` here, unlike blogGenAgent.ts's context).
5. Opens page, minimizes it, navigates to `https://chatgpt.com/new`, waits 2s, logs session state.
6. `pasteIntoChatGptComposer(page, prompt)`; dismisses modals; `trySendClick(page)` (tries each of `SEND_SELECTORS` in order, `.last()` locator) or falls back to `Enter`; retries once through another modal-dismiss on throw.
7. `findGeneratedImage(page)` — polls every 60s up to 15 times. Each poll: queries every `<img>` on the page, filters to `Math.max(naturalWidth, naturalHeight) >= 800`, takes the **last** such candidate (most recently rendered). Throws after 15 min if none found.
8. **"Stability wait"** — an unconditional extra 30s sleep after the image is first found (ChatGPT swaps the low-res preview for the full-res image shortly after), then re-runs the exact same ≥800px query to get the final settled image (falls back to the originally-found image if the re-query returns nothing).
9. Downloads via an in-page `fetch()` + `FileReader.readAsDataURL` (preserves ChatGPT's auth cookies since it runs inside the page context) → base64 → `Buffer`. Retries the fetch itself up to 4 times with a 4s pause ("'Failed to fetch' here is almost always a transient network blip... retry the fetch in place rather than closing the browser and losing the already-generated, already-found image entirely").
10. Builds `publicId` = slugified `marketName` (lowercased, non-alphanumerics → `-`, truncated to 55 chars) + `-` + unix-seconds timestamp; writes the PNG to `<outputDir>/<publicId>.png`.
11. Captures `imageText` — whatever text ChatGPT wrote alongside the image (research notes/validation table) — purely observational, wrapped so it can never fail the run.
12. On success: `recordChatGptSuccess()`, returns `{ localPath, imageText }`. On failure: `recordChatGptFailure()` (same rotation-message-append behavior as blogGenAgent.ts). `finally`: `context.close()`.

### 4.4 Extraction — image + accompanying text

Unlike blog TEXT generation (§3.5), there's no structured label-delimited text to parse here — "extraction" for the image pipeline means two separate things: (a) finding the actual generated `<img>` in ChatGPT's DOM and pulling its `src`, and (b) best-effort capturing whatever text ChatGPT wrote alongside it.

**(a) Finding the generated image — `findGeneratedImage(page)`:**
```ts
const POLL_MS = 60 * 1000;
const MAX_POLLS = 15;
async function findGeneratedImage(page: Page): Promise<{ src: string; naturalWidth: number; naturalHeight: number }> {
  const started = Date.now();
  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    await page.waitForTimeout(POLL_MS);
    const found = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const candidates = imgs.filter((img: any) => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
      if (!candidates.length) return null;
      const target = candidates[candidates.length - 1] as any;
      return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
    });
    if (found && found.src) {
      console.log(`   Image found: ${found.naturalWidth}x${found.naturalHeight}`);
      return found;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`   …check ${poll}/${MAX_POLLS} at ${elapsed}s: no image yet`);
  }
  throw new Error('Generated image not found after timeout (no img with naturalWidth/Height >= 800)');
}
```
Every `<img>` tag on the page is queried; the extraction filter is purely size-based (`naturalWidth`/`naturalHeight` ≥ 800px) — this is what separates the actual generated cover image from ChatGPT's small UI icons/avatars, since there's no stable `data-*` attribute or class ChatGPT puts on a generated-image element specifically. If multiple images pass the size filter (rare, but possible if the page still has a stale image from an earlier turn), the **last** one in DOM order is taken as the most recently rendered.

**Stability re-check** — immediately after `findGeneratedImage` returns, the code waits an unconditional 30s ("ChatGPT swaps the low-res preview for the full-res image shortly after"), then runs the **exact same** ≥800px query a second time to get the final, settled `src`:
```ts
console.log('   Stability wait (30s)...');
await page.waitForTimeout(30 * 1000);

const finalImage = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('img'));
  const candidates = imgs.filter((img: any) => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
  if (!candidates.length) return null;
  const target = candidates[candidates.length - 1] as any;
  return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
});
const imgSrc = finalImage?.src || generatedImage.src; // falls back to the first-found src if the re-query comes up empty
if (!imgSrc) throw new Error('Could not resolve final image src after stability wait');
```

**Downloading the extracted `src`** — once the final `src` is resolved, it's fetched from **inside the page's own JS context** (not from Node), specifically so ChatGPT's auth cookies apply automatically:
```ts
const MAX_DOWNLOAD_ATTEMPTS = 4;
let base64Data = '';
let downloadErr: any = null;
for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
  try {
    base64Data = await page.evaluate(async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      const blob = await response.blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, imgSrc);
    downloadErr = null;
    break;
  } catch (err: any) {
    downloadErr = err;
    console.log(`   ⚠️ Image download attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS} failed: ${err.message}`);
    if (attempt < MAX_DOWNLOAD_ATTEMPTS) await page.waitForTimeout(4000);
  }
}
if (downloadErr) throw downloadErr;

const imageBuffer = Buffer.from(base64Data, 'base64');
const publicId = `${params.marketName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 55)}-${Math.floor(Date.now() / 1000)}`;
const localPath = path.resolve(path.join(outputDir, `${publicId}.png`));
fs.writeFileSync(localPath, imageBuffer);
```
The `fetch()`/`FileReader.readAsDataURL` round-trip converts the image to a base64 string inside the browser, which Playwright then hands back to Node as a plain string — `Buffer.from(base64Data, 'base64')` turns it into a real PNG buffer written to disk. Comment on the retry loop: *"'Failed to fetch' here is almost always a transient network blip, not a real failure — confirmed live 2026-09-18 the image WAS found and stable, only the fetch() call itself hiccuped. Retry the fetch in place rather than closing the browser and losing the (already-generated, already-found) image entirely."*

**(b) Extracting the accompanying text — `lastAssistantText(page)`:**
```ts
async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    return msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '';
  }, ASSISTANT_MESSAGE_SELECTOR).catch(() => '');
}
```
Same `ASSISTANT_MESSAGE_SELECTOR` as the blog-text pipeline (§3.2/§3.5) — takes the innerText of the **last** matching assistant-message element, no label-parsing since this is free-form research notes, not a structured deliverable. Called once, right after the image download succeeds:
```ts
const imageText = await lastAssistantText(page);
recordChatGptSuccess();
return { localPath, imageText };
```
Per its own comment: *"Best-effort capture of whatever text ChatGPT wrote alongside the image (research notes, a validation summary, etc.) — purely observational for now (written to New Logic!Z 'Image text' so it can be reviewed over the next few days), never allowed to fail or block image generation itself."* The `.catch(() => '')` on the `page.evaluate(...)` call means a failure here silently returns an empty string rather than throwing — it can never fail the row.

### 4.5 Upload / where the URL lands

Three exported wrappers all call `runCoverImageGeneration` then differ only in what they do with the local file:
- `generateBlogCoverImage(params)` → `uploadFileToGoogleDrive(localPath)` → returns just the Drive URL.
- **`generateBlogCoverImageWithText(params)`** → same upload, plus returns `imageText` — `{ url, imageText }`. **This is the one the live pipeline actually calls** (`blogGenLoop.ts`).
- `generateCoverImageLocalOnly(params)` → skips the upload, returns just the local file path (not used by this pipeline).

In `blogGenLoop.ts`, the `.then()` callback attached to `generateBlogCoverImageWithText(...)` immediately calls `saveCoverImageUrlToPool(row, url, 'newLogic')` — writing the "Cover Image URL" column right away, before the ~12–15 min blog text even finishes — and `saveNewLogicImageText(row, imageText)` for the observational "Image text" column. Later, once the blog HTML is ready, `injectCoverImage()` prepends `<img src="${imageUrl}">` above the `<h1>`, and that full HTML is what gets written to "Blog Content" via `saveGeneratedBlogToPool`.

---

## 5. Orchestration — `src/coordinator/blogGenLoop.ts`

This is the actual entry point that ties everything above together for one batch pass.

### 5.1 `runBlogGenBatch(opts)`

```ts
interface BlogGenBatchOptions {
  limit?: number;               // default 3
  withImage?: boolean;
  imagePromptChoice?: '1' | '2';
  blogAccountHandle?: string;
  imageAccountHandle?: string;
  retryOnVerifyFail?: boolean;  // default true
}
```

1. `getContentPoolRowsNeedingGeneration(limit, 'newLogic')` — picks rows (see §2).
2. For each row (sequentially, one row's blog+image pair at a time — **not** parallel across rows):
   - `attemptsLeft = retryOnVerifyFail ? 2 : 1`.
   - A **separate**, independent retry budget (`MAX_BLOCKED_RETRIES = 2`) exists specifically for `LINK_VALIDATION_BLOCKED` / `RESEARCH_BLOCKED` / `PREAMBLE_ONLY` errors — these get their own counter (`blockedRetries`), not the generic `attemptsLeft`.
   - `coverImageUrl` starts as `''` and is **never re-generated on a retry within the same row** — if the image already succeeded on attempt 1, a blog-text-only retry (attempt 2, e.g. after a `PREAMBLE_ONLY`) reuses that same image, since the up-to-15-min image generation has no reason to re-run just because the blog side failed validation. (The comment notes: prior to a 2026-09-16 fix, the code reused whatever was **already saved in the sheet** from a previous, unrelated run — silently skipping image generation entirely. That's fixed; only the same-row, same-pass reuse described here remains.)
   - **If `withImage` and no image yet**: runs `generateBlogCoverImageWithText(...)` and `generateBlogViaChatGpt(...)` concurrently via `Promise.all` — two Chrome windows at once. The image call's own `.catch()` swallows failures (`"Cover image failed — continuing without one"`, returns `''`) so a failed image never fails the row.
   - **Else** (image already have, or `withImage` false): runs only `generateBlogViaChatGpt(...)`.
   - **Snapshot chart injection** (non-fatal): if `blog.imageData` is present, calls `generateAndUploadSnapshotImage({ marketName: blog.seoTitle || title, imageData: blog.imageData })` and replaces `YOUR_IMAGE_URL_HERE` in the HTML with the resulting chart PNG URL. Must run **before** the cover-image prepend below, since the cover step assumes the snapshot placeholder is already resolved.
   - **Cover image prepend**: if `coverImageUrl` is set, `injectCoverImage()` prepends `<img src="${coverImageUrl}">` before the `<h1>` — always prepends, never replaces an existing `<img>` (the old "replace the first `<img>` tag" behavior grabbed the mid-article snapshot placeholder instead and put the cover image mid-article — fixed 2026-09-18).
   - **Preferred Source CTA**: `applyPreferredSourceCTA(htmlWithImage, { mode: PREFERRED_SOURCE_MODE, title })` — see §6. Logged, then `validatePreferredSourceCTA(...)` runs a non-fatal post-check (logged only).
   - `saveGeneratedBlogToPool(row, { coverImageUrl, html: preferredSource.html, seoTitle: blog.seoTitle, metaDescription: blog.description, imageData: blog.imageData }, 'newLogic')`.
   - `verifyWrite(row.rowIndex, !!opts.withImage)` — re-reads the row, computes a rough word count from `blogContent` (strips HTML tags), and:
     - fails if word count < `MIN_WORDS = 400` (a "did anything land at all" floor, not a quality bar — real articles run 1,450–1,600 words),
     - otherwise **passes** even with no cover image (`"no cover image, but text content is fine — accepting"`) — a missing image is never treated as a row failure.
   - If verification fails and `attemptsLeft > 0`, the whole loop body retries (re-generates blog text — note this does *not* explicitly reset `coverImageUrl`, so a previously-successful image URL from attempt 1 carries into the retry's write).
3. `runBlogSanityChecks` / `validateBrandAuthority` are currently **disabled** (imports commented out, 2026-09-18) — "their KPI checks are being redesigned around the new image pipeline." The row is written straight through without them for now.
4. Returns `{ attempted, generated, failed }`, also logged as `[BLOG GEN] Pass complete: X generated, Y failed, out of Z.`

### 5.2 Error classification inside the retry loop

```ts
const BLOCKED_ERROR_PREFIXES = ['LINK_VALIDATION_BLOCKED', 'RESEARCH_BLOCKED', 'PREAMBLE_ONLY'];
```
- If the thrown error's message starts with one of these prefixes: increments `blockedRetries`; if it exceeds `MAX_BLOCKED_RETRIES` (2), gives up on the row (`attemptsLeft = 0`); otherwise closes/reopens ChatGPT and resends (logged as `"(retry N/2) — reopening ChatGPT and resending..."`).
- Any other error: falls into the generic `attemptsLeft` retry (up to 1 retry by default) or gives up.

### 5.3 `injectCoverImage()` / `injectSnapshotImage()`

```ts
function injectCoverImage(html: string, imageUrl: string): string {
  if (!imageUrl) return html;
  return `<img src="${imageUrl}">\n${html}`;
}
function injectSnapshotImage(html: string, snapshotUrl: string): string {
  if (!snapshotUrl) return html;
  return html.replace(/YOUR_IMAGE_URL_HERE/g, snapshotUrl);
}
```
Order matters — snapshot placeholder resolution must happen first, since it's the *only* `<img>` the model's raw output contains; the cover-image step then unconditionally prepends a second, brand-new `<img>` rather than searching for/replacing anything.

### 5.4 `verifyWrite()`

```ts
const MIN_WORDS = 400;
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
```

### 5.5 `runBlogGenLoop(opts)`

```ts
export async function runBlogGenLoop(opts: BlogGenBatchOptions & { intervalSeconds?: number } = {}): Promise<void> {
  const intervalSeconds = opts.intervalSeconds ?? 1800; // 30 min default
  for (;;) {
    try { await runBlogGenBatch(opts); }
    catch (err: any) { console.log(`[BLOG GEN] Pass errored: ${err.message}`); }
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }
}
```
Runs forever — a pass-level error is logged and swallowed, never crashing the loop.

---

## 6. Supporting agents (secondary, non-fatal add-ons)

### 6.1 `src/agents/blogPreferredSourceAgent.ts`

Runs **after** the blog HTML (with cover + snapshot images already injected) is fully assembled, **before** the sheet write. Uses `cheerio` to deterministically insert exactly one "Google Preferred Source" CTA link at a heuristically-chosen placement (keyed off heading-text regexes: `DECISION_HEADING_RE`, `FAQ_HEADING_RE`, `METHODOLOGY_HEADING_RE`, `COMMERCIAL_CTA_RE`), pointing either to:
- a direct Google deeplink: `DIRECT_URL = 'https://www.google.com/preferences/source?q=kenresearch.com'`, or
- a tracked short-URL: `TRACKED_URL = 'https://www.encurtador.dev/redirecionamento/acesse.one/xar1pvr'`,

depending on `PreferredSourceMode` (`'direct' | 'tracked'`). `blogGenLoop.ts` currently hardcodes:
```ts
const PREFERRED_SOURCE_MODE: PreferredSourceMode = 'direct';
```
(The in-code comment above this line still describes the *original* rationale for defaulting to `'tracked'` — "lets us start collecting Preferred Source CTA Click data from day one" — but the value actually set is `'direct'`; worth reconciling if this file is edited again.)

Exports `applyPreferredSourceCTA()` (does the insertion, returns `{ html, applied, placement }`) and `validatePreferredSourceCTA()` (non-fatal post-check, logged but never blocks the write).

### 6.2 `src/agents/blogSnapshotImageAgent.ts`

Consumes the raw "Key Snapshot Metrics for Image" text block (the `imageData` field from `generateBlogViaChatGpt`, also stored in the sheet's "Image Data" column) and renders it into the actual mid-article snapshot PNG that replaces the prompt's `YOUR_IMAGE_URL_HERE` placeholder. Ported from an older Python (`html2image`) script into TypeScript using Playwright (already a project dependency).

`parseSnapshotMetrics(imageData)` splits the block into `{label, value}` pairs, defensively stripping the same "N supported metrics" instruction-echo and citation-chip-line patterns `blogGenAgent.ts`'s `extractBlog()` already strips (kept here too "in case imageData ever comes from somewhere else"). Renders one of several chart types per the label/value shape the master prompt mandates:
- **trend bar-comparison** — chained "→" values,
- **donut** — labels containing "Share",
- **gauge** — CAGR/Growth/Adoption/Penetration/Utilization/Conversion %,
- **competitor name list** — "Key Players",
- **ranked competitor bar chart** — "Market Share".

Uploads the rendered PNG via the same `uploadFileToGoogleDrive()` util the cover image uses; `blogGenLoop.ts`'s `injectSnapshotImage()` regex-replaces `YOUR_IMAGE_URL_HERE` with the resulting URL.

Both of these are **non-fatal**: a failure in either is caught and logged, and the row still gets written with whatever partial result it has (unresolved placeholder image, or no Preferred Source CTA) — never failing the whole row.

---

## 7. Account/session management

### 7.1 `src/config/chatGptAccountTracker.ts` (123 lines)

Purpose (its own header comment): *"Multi-account rotation for the ChatGPT browser session... Mirrors the OpenRouter key-rotation / X account-tracker pattern: if the ChatGPT browser session keeps failing (rate limit, 'too many prompts', flaky response, etc.), rotate to the next saved account after N consecutive failures instead of hammering the same one forever."*

- `ROTATION_STATE_FILE = '.sessions/chatgpt-rotation.json'` — persists `{ currentAccount, consecutiveFailures }`.
- `ACCOUNTS_ROOT = '.sessions/chatgpt-accounts'` — one subfolder per named Playwright persistent profile (e.g. `social-image`, `account2`).
- `DEFAULT_ACCOUNT = 'default'` — resolves specially to `.sessions/chatgpt` (**not** under `chatgpt-accounts/`), excluded from `listChatGptAccounts()`'s pool unless no named accounts exist at all.
- `ROTATE_AFTER_FAILURES = 10` — rotate after 10 **consecutive** failures on the current account.
- `listChatGptAccounts()` — lists subdirectories of `ACCOUNTS_ROOT`; returns `['default']` if none exist.
- `sessionDirForAccount(accountName)` — `accountName === 'default' ? '.sessions/chatgpt' : '.sessions/chatgpt-accounts/<accountName>'`. Both `blogGenAgent.ts` and `blogImageAgent.ts` call this directly with their own hardcoded account names.
- `getCurrentChatGptAccount()` — reads the persisted rotation state (self-healing: restarts from `accounts[0]` if the saved current-account no longer exists in the pool).
- `recordChatGptFailure()` — increments `consecutiveFailures`; at 10, advances round-robin to the next account, resets the counter, returns `{ rotated, account, cycleExhausted }` (`cycleExhausted` = true when the round-robin wraps back to index 0, i.e. *every* known account just failed 10-in-a-row).
- `recordChatGptSuccess()` — resets `consecutiveFailures` to 0 for the current account.

**Important subtlety**: this rotation state is written/read consistently by both generation agents, but **neither agent actually consults `getCurrentChatGptAccount()` to decide which Chrome profile to launch** — they always use their own hardcoded `DEFAULT_BLOG_ACCOUNT` (`'social-image'`) / `DEFAULT_IMAGE_ACCOUNT` (`'account2'`) unless a caller explicitly overrides via `accountHandle`, which `blogGenLoop.ts` (the live automated path) never does. **In practice, the rotation state is recorded but never actually changes which account gets used.**

### 7.2 `src/browser/chatgpt/login.ts` (166 lines)

Not used directly by either generation agent's automated calls (both launch their own persistent contexts independently, per their own header comments) — this module is the shared "one browser" singleton used by interactive/manual login tooling.

- `launchBrowser(accountName)` — reuses an existing page/context if already open for the **same** account, otherwise closes whatever's open and starts fresh (a persistent context is tied to one profile directory).
- `ensureChatGptPage(accountName)` — unattended variant: launches/reuses, logs whether the composer is visible (diagnostic only, never blocks), returns the page.
- `ensureChatGptPageInteractive(accountName)` — manual login variant: if the composer isn't visible, clicks "Log in" if present, then blocks on an actual `readline` prompt in the terminal ("Press Enter here once you have finished logging in...") before re-checking.
- `COMPOSER_SELECTOR` is defined here canonically and re-exported — though both `blogGenAgent.ts` and `blogImageAgent.ts` keep their own **local copy** of the identical selector string rather than importing it (a minor duplication; all three copies must stay in sync if ChatGPT's DOM changes again — see §8).

Session setup CLI: `npx tsx src/tools/loginChatGpt.ts <accountName>` (e.g. `social-image`, `account2`) — opens a visible browser, waits for manual login, saves the session.

---

## 8. Composer/DOM mechanics (pointer, not re-documented here)

`pasteIntoChatGptComposer()` and `dismissBlockingModals()` live in `src/utils/chatgptComposer.ts`, imported by both generation agents. They:
- dispatch a synthetic `paste` `ClipboardEvent` with a `DataTransfer` payload into the composer (Playwright's `.fill()` truncates multi-line ChatGPT prompts to their first line — this bypasses that),
- fall back to `page.keyboard.insertText()` if the paste event undersizes,
- detect ChatGPT's "Extended mode" behavior where a very long paste gets silently converted into a text-file attachment instead of landing in the composer, and accept that as valid delivery,
- repeatedly dismiss blocking modals (rate-limit popups, session nudges, etc.) since one can re-render itself seconds after being removed.

**2026-09-26 UI redesign incident**: ChatGPT dropped the `#prompt-textarea` id and the `data-message-author-role="assistant"` attribute entirely, replacing them with a bare `div[contenteditable="true"].ProseMirror` (no id) and `div[data-markdown-text-style="assistant-message"]` respectively. The rollout was **staggered per-account** — some ChatGPT accounts got the new UI before others — which is why this broke blog-text generation (`social-image` account) and the 7-slide carousel pipeline (`storyline` account) silently for a period while cover-image generation (`account2`) kept working fine on the old UI. Every selector constant across the codebase (`blogGenAgent.ts`, `blogImageAgent.ts`, `browser/chatgpt/login.ts`, `browser/chatgpt/promptRunner.ts`, `newsletter-outlook/chatgptGenerator.ts`, `tools/tmpRunPulsePrompts.ts`, and the standalone `li-carousel-storyline/scripts/generateStoryline.ts`/`generateImages.ts` copies) now matches **both** the old and new DOM shapes, comma-separated, e.g.:
```ts
const COMPOSER_SELECTOR = '#prompt-textarea, div[contenteditable="true"].ProseMirror';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
```
If ChatGPT changes its DOM again, every one of these locations needs the same fix — they are **not** shared from one canonical constant (see the duplication note in §7.2).

---

## 9. Scheduling / entry points

### 9.1 Automated (cron) path

`blogGenLoop.ts` is **deliberately not wired into `scheduler-new.ts`'s node-cron jobs** — its own header comment explains why: each row takes ~12–15 min (blog) / up to ~9 min (image) of real ChatGPT generation time through visible, logged-in Chrome windows, which would block or collide with the tightly-timed 10:30–18:00 posting cron if run in the same process.

The actual automated trigger is **indirect**, via the nightly RSS feed job:
```ts
// scheduler-new.ts:187
cron.schedule('30 18 * * *', wrap('Nightly RSS Feed', runNightlyRssFeed), { timezone: tz });
```
Every day at **18:30 IST** (right after the last 18:00 posting slot), `runNightlyRssFeed()` (`src/coordinator/rssFeeder.ts`) refreshes RSS Extraction and feeds the New Logic/Social Media sheets, then calls `runGenerationOnly()` (`rssFeeder.ts:149-156`):
```ts
const genResult = await runBlogGenBatch({ limit: NEW_LOGIC_NIGHTLY_QUOTA, withImage: true });
```
with `NEW_LOGIC_NIGHTLY_QUOTA = 100` — the nightly cron attempts **up to 100** New Logic rows' worth of blog+image generation, one row's blog+image pair at a time (sequential across rows, concurrent only within a single row's own blog-text + cover-image pair).

`src/tools/runNightlyFeed.ts` — a standalone manual trigger for `runGenerationOnly()`, for use if the 18:30 tick is ever missed.

### 9.2 Manual / on-demand CLI paths

```
npm run dev -- run-blog-gen [count] [--no-image]
```
Generates up to `[count]` (default 3) pending New Logic rows, then exits. `--no-image` skips the cover-image step (blog text only). Full generation (blog + image, two parallel Chrome windows) is the default.

```
npm run dev -- run-blog-gen-loop [count] [--no-image] [--interval SECONDS]
```
Same, but runs forever — checks again every `SECONDS` (default 1800 = 30 min) after each pass. Meant to be started as its **own** long-lived process, separate from the posting cron daemon (`npm run dev`).

Implementation (`src/index.ts`):
```ts
if (mode === 'run-blog-gen') {
  const limit = Number(process.argv[3]) || 3;
  const withImage = !process.argv.includes('--no-image');
  const { runBlogGenBatch } = await import('./coordinator/blogGenLoop.js');
  const result = await runBlogGenBatch({ limit, withImage });
  console.log(`✅ Blog-gen pass complete: ${result.generated}/${result.attempted} generated`);
  return;
}

if (mode === 'run-blog-gen-loop') {
  const limit = Number(process.argv[3]) || 3;
  const withImage = !process.argv.includes('--no-image');
  const intervalArgIdx = process.argv.indexOf('--interval');
  const intervalSeconds = intervalArgIdx !== -1 ? Number(process.argv[intervalArgIdx + 1]) : undefined;
  const { runBlogGenLoop } = await import('./coordinator/blogGenLoop.js');
  await runBlogGenLoop({ limit, withImage, intervalSeconds }); // never returns — Ctrl+C to stop
}
```

Other standalone scripts (not listed `npm run dev -- <mode>` entries):
- `src/tools/generateBlogAndImage.ts` — one-off script, also calls `generateBlogViaChatGpt` directly and supports an explicit `promptVersion` param (the only place `'v2'` can actually be reached).
- `src/tools/runNightlyFeed.ts` — manual trigger for the nightly job (§9.1).

---

## 10. Known quirks / things to watch

- **Prompt selection is random, not caller-controlled**: every automated blog-text generation is a 50/50 coin flip between the master V1.3 prompt and one of 4 Prompt B variants, decided fresh inside `generateBlogViaChatGpt()` each call. There's no way to force a specific variant from `blogGenLoop.ts` without passing `promptVersion: 'v2'`, which routes to the (identical-to-v1) `buildMasterBlogPromptV2` — the Prompt B pool can currently only be reached via the 50% random branch.
- **Account rotation is recorded but not acted on**: `recordChatGptFailure()`/`recordChatGptSuccess()` maintain a real rotation state file, but nothing in the live pipeline reads `getCurrentChatGptAccount()` back to actually switch Chrome profiles — both agents always use their fixed `social-image`/`account2` accounts.
- **`COMPOSER_SELECTOR`/`ASSISTANT_MESSAGE_SELECTOR` are duplicated** across 7+ files rather than imported from one canonical source — a future ChatGPT DOM change needs the same fix applied everywhere, not just once (see §8).
- **`PREFERRED_SOURCE_MODE`'s in-code comment is stale** relative to its actual value (`'direct'`) — the comment still describes the old `'tracked'`-by-default reasoning.
- **A missing cover image never fails a row** — `verifyWrite()` explicitly accepts text-only rows. If cover-image generation is broken for an extended period, rows will keep landing successfully but silently without images.
- **`runBlogSanityChecks`/`validateBrandAuthority`** are currently disabled (commented out in `blogGenLoop.ts`, since 2026-09-18) pending a redesign around the new image pipeline.
- Both generation agents' Chrome sessions live under `.sessions/chatgpt-accounts/<name>/` — see the earlier "junk vs essential session size" cleanup in this project's history if disk usage there ever balloons (Service Worker cache, HTTP cache, etc. dominate; only Cookies/Login Data/Preferences are actually needed for the session to persist).
