# Skill: Generate LinkedIn Carousel

End-to-end pipeline. Picks the next Ken Research report from the Social Media sheet,
generates a 7-slide PDF carousel via ChatGPT, saves it locally, and writes the PDF
path + LinkedIn caption back to the sheet.

Run from: `agents/li-carousel/`

---

## HARD RULES

- Never skip the sheet write at the end
- Never invent stats — every number must come from the scraped page or verified web search
- No "Ken Research" text inside any slide image — the logo zone must be empty
- No em dashes anywhere in captions or slide text
- Local PDF path → column E | LinkedIn caption → column Y (LinkedIn Post)

---

## STEP 1 — Pick URL from sheet

```
node scripts/carousel_sheet.js next
```

Returns: `{ row, targetUrl, title }`

If `row: null` → queue is empty, stop.

Set: `sheetRow`, `targetUrl`, `title`
Derive: `slug` = title lowercased, spaces → hyphens, max 50 chars
        e.g. "India Cold Storage Market" → `india-cold-storage-market`

---

## STEP 2 — Scrape + Research

**2a. Scrape the Ken Research report page** (`targetUrl`)

Extract:
- Market name (clean, title-case)
- Market size (current, with currency + year)
- CAGR (as %)
- Forecast size + forecast year
- Key segments (top 3-4 with shares if available)
- Key players (top 4-5 named companies)
- 3-5 key stats / policy names

**2b. Run 3 web searches in parallel:**
1. `"{market name} market size CAGR forecast 2025 2026"` — enrich numbers
2. `"{market name} key players companies market share"` — named players + deals
3. `"{market name} {country} government regulation policy 2026"` — official data

**CAGR rule:** if gated or missing, resolve via web search. Never leave blank.

Build fact bank:
```json
{
  "marketName": "...",
  "marketSizeCurrent": "USD X billion (2026)",
  "cagr": "X%",
  "forecastSize": "USD Y billion",
  "forecastYear": "20XX",
  "segments": [{ "name": "...", "share": "X%" }],
  "keyPlayers": ["..."],
  "keyStats": ["stat with source"],
  "regulatoryBody": "..."
}
```

---

## STEP 3 — Plan 7-Slide Arc

| Slide | Type | Content |
|-------|------|---------|
| 1 | Cover | Market name + biggest hook stat + sector visual |
| 2 | Market Sizing | Current size → forecast → CAGR trajectory chart |
| 3 | Segment Breakdown | Top 3-4 segments with shares |
| 4 | Key Players | Top 4-5 players + competitive dynamic |
| 5 | Growth Drivers | 3 key drivers, one verified stat each |
| 6 | Key Insight | One contrarian or surprising finding |
| 7 | CTA | Forward-looking question + report link invite |

For each slide:
- Headline: named entity + specific number (mandatory — no vague headlines)
- 2-3 exact data points to show
- Visual mechanic: A (grid) / B (chart-hero) / C (photo-hero) / D (typography-hero) / E (annotated-diagram)
- No two adjacent slides use the same mechanic

Cover rule: headline must name the exact market segment ("INDIA COLD STORAGE MARKET")
NOT abstract concepts ("the cold chain opportunity").

Save arc to: `images/briefs/arc_{YYYY-MM-DD}_{slug}.md`

---

## STEP 4 — Build Per-Slide Prompts

For each slide, write a full ChatGPT image prompt.

**Prompt template:**
```
You are a premium editorial data visualization designer.

Create a finished LinkedIn carousel slide (1080×1350 px, portrait) for Ken Research.

SLIDE: [N] of 7 — [type]
MARKET: [exact market name]
HEADLINE: [named entity + specific number]

VISUAL REGISTER: Cinematic dark
BACKGROUND: #000000 with atmospheric depth and subtle texture
TEXT COLOR: #FFFFFF for headlines, #C7373C Ken-red for accent/emphasis
FONT STYLE: Bold condensed sans-serif headlines, clean sans for body

CONTENT TO SHOW (use only these — no other numbers):
- [data point 1 — exact value]
- [data point 2 — exact value]
- [data point 3 — exact value if available]

VISUAL MECHANIC: [describe specifically — chart type, axes, layout]

DESIGN RICHNESS (mandatory for every slide):
1. Size hierarchy — dominant element larger, supporting elements smaller
2. One line-art icon per data cell or pillar
3. One verified figure per visual zone
4. Atmospheric depth — gradient bg, subtle glow on key data

BOTTOM-LEFT: Source line small grey text:
"Source: Ken Research [report name]; [other source if applicable]."

BOTTOM-RIGHT: Page indicator "[N]/07" small grey text

TOP-RIGHT SAFE ZONE: Leave as clean dark background only.
DO NOT place any text, logo, or branding in the top-right zone.

[Slide 1 only — add] BOTTOM-RIGHT ALSO: "Swipe Right ▶" small Ken-red text
[Slide 7 only — add] Ken-red CTA pill: "Full report below ↓"

STRICT BANS:
- NO text "Ken Research" or any brand name on the canvas
- NO fabricated sub-brands ("Insights Platform" etc.)
- NO em dashes — use colon or comma
- NO stock handshakes, no rocket emojis, no glassmorphism
- NO invented numbers — only the figures listed above
- NO literal engineering blueprints with dimensions
```

Save each prompt to:
`images/briefs/creative_{YYYY-MM-DD}_{slug}_slide0N.txt`

---

## STEP 5 — Generate Slides (one by one)

For each slide (01 → 07):

```
node scripts/generate_image.js \
  --prompt-file=images/briefs/creative_{YYYY-MM-DD}_{slug}_slide0N.txt \
  --slug={slug}_slide0N
```

Output: `images/image_{YYYY-MM-DD}_{slug}_slide0N.png`

After each slide: navigate browser to `https://chatgpt.com/new` (keep session alive).
Review immediately (Step 6) before generating the next slide.

---

## STEP 6 — Review + Correct Each Slide

After each PNG saves, read it visually and check:

| Check | Pass condition |
|-------|----------------|
| Numbers | Match fact bank exactly |
| Headline | Named entity + specific number present |
| "Ken Research" text | Must NOT appear anywhere |
| Top-right zone | Clean dark background — empty |
| Source line | Bottom-left, small grey |
| Page indicator | Bottom-right, NN/07 |
| Em dashes | Zero |
| Anti-AI elements | No stock hands, rockets, glassmorphism |

If error → run correction:
```
node scripts/renderer/correct_slide.js \
  --input=images/image_{YYYY-MM-DD}_{slug}_slide0N.png \
  --correction="[exact single-element fix — leave everything else unchanged]" \
  --slug={slug}_slide0N_fix1
```

Max 2 correction attempts per slide. On 3rd failure, accept current version and log it.

After review passes, copy final PNG to:
`images/carousel_{YYYY-MM-DD}_{slug}/slide_0N.png`

(Create the folder if it doesn't exist.)

---

## STEP 7 — Combine into PDF

```
node scripts/renderer/combine_pdf.js \
  --folder=images/carousel_{YYYY-MM-DD}_{slug} \
  --output=images/carousel_{YYYY-MM-DD}_{slug}.pdf \
  --width=1080 \
  --height=1350
```

Local PDF path (for sheet):
`C:\Users\Pranav Gupta\OneDrive - Ken Research Private Limited\Desktop\agents\li-carousel\images\carousel_{YYYY-MM-DD}_{slug}.pdf`

---

## STEP 8 — Write LinkedIn Caption

150-250 word LinkedIn post caption.

Structure:
- Line 1: hook — contrarian insight or surprising stat. No "Excited to share."
- Gap
- "Ken Research just published the full breakdown of the [Market Name]."
- Gap
- 3-4 bullets starting with ✅ — key takeaways (different words from slide text)
- Gap
- "Swipe through the carousel to see the full breakdown."
- Gap
- 5-7 hashtags: market-specific + #KenResearch + #MarketIntelligence

Rules: no em dashes, no "Thrilled to announce", every bullet has a specific number.

Save to: `C:/tmp/caption_{slug}.txt`

---

## STEP 9 — Write to Sheet

```
node scripts/carousel_sheet.js write \
  --row={sheetRow} \
  --path="C:\Users\Pranav Gupta\OneDrive - Ken Research Private Limited\Desktop\agents\li-carousel\images\carousel_{YYYY-MM-DD}_{slug}.pdf" \
  --caption-file="C:/tmp/caption_{slug}.txt"
```

Expected response: `{ "ok": true, "row": N, "wrote": { "colE": true, "colY": true } }`

---

## Return

```
marketName:  {name}
sheetRow:    {N}
slides:      7
pdfPath:     ...li-carousel\images\carousel_{date}_{slug}.pdf
colE:        written ✓
colY:        written ✓
status:      done
```

---

## One-time Setup

1. Share the Social Media sheet with `sheet-agent@agentic-494304.iam.gserviceaccount.com` (Editor)
2. Run `npm install` once from `agents/li-carousel/`
3. ChatGPT must be logged in — profile auto-loaded from `CHATGPT_PROFILE_DIR` in `.env`
