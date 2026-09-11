# Ken Research Content Distribution Agent — Integration Context

> Hand this file to any AI working on the blog generation project so it understands the existing distribution system and can integrate cleanly.

---

## What This Project Does

This is a **fully automated content distribution agent** for Ken Research. It:

1. Reads blog/article rows from **Google Sheets**
2. Generates platform-specific content using **LLM APIs** (OpenRouter 15-key pool + NVIDIA 4-key fallback)
3. Posts to **12+ platforms** (3 social + 9+ blog) via **Playwright browser automation**
4. Writes results (post URLs, status, batch label) back to **Google Sheets**
5. Runs on a **node-cron schedule** (Asia/Kolkata timezone, 10:30–18:30 IST)
6. Self-heals via an **error knowledge base + auto-fix system**

Target throughput: ~674 posts/day across 45+ accounts.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | TypeScript + Node.js (ES2020, tsx for dev) |
| Browser | Playwright with persistent Chrome profiles |
| LLM | OpenRouter API (15-key rotation) + NVIDIA NIM (4-key fallback) |
| SEO | SerpAPI / Zenserp / Serpstack (30+ keys), Tavily (10 keys) |
| Scheduling | node-cron (Asia/Kolkata) |
| Data | Google Sheets API v4 (googleapis package) |
| Validation | Zod schemas |
| Accounts | JSON files in `.accounts/` |

---

## Directory Structure

```
src/
  index.ts                        CLI entry point (30+ modes)
  scheduler-new.ts                Cron daemon — fires 33 batches/day
  monitor.ts                      Error monitoring + auto-fix trigger
  errorInterceptor.ts             Error KB + runtime.log patching
  autoFix.ts                      Self-healing (re-login, rotate key, retry)

  coordinator/
    masterCoordinator.ts          Master orchestrator — all 20+ batch runners live here

  agents/
    contentAgentNew.ts            11 LLM generator functions (one per platform)
    seoAgentNew.ts                SERP ranking + P1/P2/P3 priority scoring
    xAgentNew.ts                  X (Twitter) posting via twitter-api-v2
    fbBatchAgentNew.ts            Facebook batch agent (15 accounts)
    liBatchAgentNew.ts            LinkedIn batch agent (15 accounts)
    mediumBatchAgentNew.ts        Medium batch agent
    substackBatchAgentNew.ts      Substack batch agent
    hackmdBatchAgentNew.ts        HackMD batch agent
    noteBatchAgentNew.ts          Note.com batch agent
    notionBatchAgentNew.ts        Notion batch agent
    patreonBatchAgentNew.ts       Patreon batch agent
    [+ devto, linkmate, googlesite, linkedin-pulse, calisthenics agents]

  browser/
    twitter/login.ts + poster.ts
    facebook/login.ts + poster.ts
    linkedin/login.ts + poster.ts
    medium/login.ts + poster.ts
    substack/login.ts + poster.ts
    hackmd/login.ts + poster.ts
    devto/login.ts + poster.ts
    googlesite/login.ts + poster.ts
    wordpress/login.ts + poster.ts
    blogger/login.ts + poster.ts
    linkedin-pulse/poster.ts
    calisthenics/login.ts + poster.ts
    linkmate/login.ts + poster.ts
    notion/login.ts + poster.ts
    note/login.ts + poster.ts
    patreon/login.ts + poster.ts
    ameba/login.ts + poster.ts
    instagram/login.ts + poster.ts
    stagehand.ts                  humanDelay() utility only
    resilientBrowser.ts           Error classification + retry
    popupGuard.ts                 Popup detection/suppression

  config/
    accounts.ts                   X account CRUD + CLI
    accountTracker.ts             Daily posting limits per account
    openRouterClient.ts           OpenRouter API (15-key round-robin)
    serpApiClient.ts              SERP lookup (3 providers, 30+ keys)
    tavilyClient.ts               Tavily web search (10 keys)
    settings.ts                   Global config (delays, limits, timeouts)

  sheets/
    sheets.ts                     Google Sheets read/write (Social + Blogs tabs)

  tools/
    browserTools.ts               Tool dispatcher (40+ named browser actions)
    getPendingRows.ts             Query unposted sheet rows
    saveResult.ts                 Write results to sheet

  utils/
    utm.ts                        UTM parameter injection (12 platforms)
    killChrome.ts                 Force-kill stray Chrome processes
```

---

## Google Sheets Schema

**Sheet ID**: `1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ`

### Tab: "Social Media"
Each row = one Ken Research report to promote socially.

Key columns:
```
Title         | Blog/report title
targetUrl     | Ken Research report URL
Batch         | Which batch number this row belongs to
Date          | Scheduled post date (or YYYY-MM-DD prefixed content)
Name          | Account nickname to post from
X Post        | Generated tweet text (empty = needs generation)
X Status      | "Posted" | "Failed" | "Error"
X Post URL    | Live tweet URL after posting
X Batch       | "Batch 1", "Batch 2", etc.
FB Post/Status/URL/Batch  (same pattern)
LI Post/Status/URL/Batch  (same pattern)
seoPage       | Google ranking position (1, 55, 100+, N/A)
seoRanking    | P1 / P2 / P3
seoKeywords   | Comma-separated trending keywords
lastSerpCheckDate
```

### Tab: "Blogs"
Each row = one article to publish on blog platforms.

Key columns:
```
Blog Title          | Article title
Seed Keyword        | Primary SEO keyword
Blog Description    | Short description / meta
targetUrl           | Ken Research report URL
Blog Content        | Full HTML content (pre-written or generated)
Medium Post URL     | Live URL after posting
Dev.to Post URL
Substack Post URL
HackMD Post URL
Google Sites URL
LinkedIn Pulse URL
WordPress URL
Blogger URL
[+ status columns for each platform: Medium Status, Dev.to Status, etc.]
```

---

## SheetRow Interface

```typescript
export interface SheetRow {
  rowIndex: number;          // 1-based row number in sheet
  title: string;
  targetUrl: string;
  batch: number;
  date: string;
  name: string;              // account nickname
  priority?: string;         // P1 | P2 | P3
  seoPage?: string;
  seoRanking?: string;
  seoKeywords?: string;
  // Social
  xPost?: string;
  xPostUrl?: string;
  xStatus?: string;
  fbPost?: string;
  fbPostUrl?: string;
  fbStatus?: string;
  linkedinPost?: string;
  linkedinPostUrl?: string;
  linkedinStatus?: string;
  // Blog
  blogContent?: string;       // shared HTML column
  mediumPostUrl?: string;
  mediumStatus?: string;
  devtoPostUrl?: string;
  devtoStatus?: string;
  substackPostUrl?: string;
  substackStatus?: string;
  // ... (similar for all 12 blog platforms)
}
```

---

## Data Flow (per batch, e.g. Medium)

```
Cron fires at scheduled time
  └─> masterCoordinator.runMediumBatch()
        └─> sheets.getRowsForContinuousMediumPosting(15)
              └─> Returns rows where Medium Status is empty
        └─> For each row:
              a. If blogContent is empty → contentAgentNew.generateMediumPost(row)
                    └─> Fetches market data via Tavily
                    └─> Calls LLM (OpenRouter pool)
                    └─> Returns HTML article
              b. Login to Medium account (row.name)
                    └─> browser/medium/login.ts → launchPersistentContext()
              c. Post content
                    └─> browser/medium/poster.ts → postToMedium(page, title, html)
                    └─> Returns { success, postUrl }
              d. Save result
                    └─> sheets.saveUnifiedMediumResult(row, postUrl, 'Posted', 'Batch N')
        └─> Log: "[MEDIUM BATCH] Batch N complete: 12/15 posted"
```

---

## Content Generator Functions (src/agents/contentAgentNew.ts)

| Function | Output | Use |
|---|---|---|
| `generateTweet(params)` | ≤280 char tweet | X social |
| `generateXThread(params)` | Array of 4 tweets | X thread |
| `generateFbPost(params)` | 300-500 char post | Facebook |
| `generateLiPost(params)` | 200-400 char post | LinkedIn |
| `generateMediumPost(row)` | HTML article | Medium |
| `generateGoogleSitePost(row)` | HTML page | Google Sites |
| `generateDevtoPost(row)` | Markdown article | Dev.to |
| `generateLinkedinPulsePost(row)` | HTML article | LinkedIn Pulse |
| `generateSubstackPost(row)` | HTML newsletter | Substack |
| `generateHackmdPost(row)` | Markdown document | HackMD |
| `generateLinkmatePost(row)` | Link post | Linkmate |

**LLM calling pattern**:
```typescript
// OpenRouter 15-key rotation + NVIDIA 4-key fallback
const response = await callLLMWithRetry(prompt, { maxRetries: 3 });
// Refusal detection: checks for "I'm sorry", "I cannot", output < 100 chars
```

---

## Browser Automation Patterns

**Login pattern** (all platforms use this):
```typescript
const context = await chromium.launchPersistentContext(sessionDir, {
  channel: 'chrome',
  headless: false,
});
const page = await context.newPage();
// ... fill credentials, handle 2FA if needed
// session saved to .sessions/<platform>-<handle>/
```

**Post pattern** (X example):
```typescript
await page.waitForSelector('[data-testid="tweetTextarea_0"]');
await page.click('[data-testid="tweetTextarea_0"]');
await humanDelay(500, 1000);
await page.keyboard.type(tweetText, { delay: 80 });
await humanDelay(500, 1000);
await page.click('div[role="button"]:has(span:has-text("Post"))');
```

**Key rules**:
- Always `waitForSelector` before interacting with any element
- Always `humanDelay()` between actions
- Never use `page.fill()` — use `page.keyboard.type()` instead
- Never use `networkidle` — use `domcontentloaded` or specific selectors
- One browser context per account, persistent sessions in `.sessions/`

---

## Account Files

| Platform | File |
|---|---|
| X | `.accounts/accounts.json` |
| Facebook | `.accounts/accounts-facebook.json` |
| LinkedIn | `.accounts/linkedin-accounts.json` |
| Medium | `.accounts/accounts-medium.json` |
| Substack | `.accounts/accounts-substack.json` |
| HackMD | `.accounts/accounts-hackmd.json` |
| Dev.to | `.accounts/accounts-devto.json` |
| Google Sites | `.accounts/accounts-googlesite.json` |
| WordPress | `.accounts/accounts-wordpress.json` |
| Blogger | `.accounts/accounts-blogger.json` |
| Notion | `.accounts/accounts-notion.json` |
| Note | `.accounts/accounts-note.json` |
| Patreon | `.accounts/accounts-patreon.json` |
| Ameba | `.accounts/accounts-ameba.json` |

All follow the same shape:
```json
[
  {
    "nickname": "acct1",
    "email": "...",
    "password": "...",
    "sessionDir": ".sessions/medium-acct1",
    "active": true
  }
]
```

---

## Environment Variables

```
ANTHROPIC_API_KEY
OPENROUTER_API_KEY_1 .. OPENROUTER_API_KEY_15
NVIDIA_API_KEY_1 .. NVIDIA_API_KEY_4
ZENSERP_API_KEY_1 .. ZENSERP_API_KEY_10
SERPSTACK_API_KEY_1 .. SERPSTACK_API_KEY_10
SERPAPI_KEY_1 .. SERPAPI_KEY_12
TAVILY_API_KEY_1 .. TAVILY_API_KEY_10
GOOGLE_SERVICE_ACCOUNT_JSON    (or path to .accounts/google-service-account.json)
```

---

## Cron Schedule (Asia/Kolkata, 10:30–18:30 IST)

33 batches/day spread at ~15-min intervals:

```
10:30 FB-1        11:30 LI-1*      12:30 FB-3        13:30 LI-2*
10:45 Notion-1    11:45 HackMD-1   12:45 HackMD-2    13:45 DevTo-1
11:00 GSites-1    12:00 Blogger-1  13:00 GSites-2    14:00 Calist-1
11:15 Linkmate-1  12:15 FB-2       13:15 Linkmate-2  14:15 Paragraph-1
...
17:30 LI-Pulse-1* 18:00 Calist-3   18:30 Ameba-2
```

`*` = protected 15-min exclusive window (no other batches overlap)

---

## Adding a New Platform — Checklist

To add any new posting platform:

1. **Account file**: `.accounts/accounts-<platform>.json` (same schema as others)
2. **Browser login**: `src/browser/<platform>/login.ts` → export `loginTo<Platform>(nickname)`
3. **Browser poster**: `src/browser/<platform>/poster.ts` → export `postTo<Platform>(page, content)`
4. **Content generator**: add `generate<Platform>Post(row)` to `src/agents/contentAgentNew.ts`
5. **Batch agent**: create `src/agents/<platform>BatchAgentNew.ts` (copy any existing agent, swap function names)
6. **Coordinator**: add `run<Platform>Batch()` to `src/coordinator/masterCoordinator.ts`
7. **Scheduler**: add cron entry to `src/scheduler-new.ts`
8. **Sheet columns**: add `<Platform> Post URL`, `<Platform> Status`, `<Platform> Batch` columns to Blogs tab
9. **Sheet reader**: add `getRowsForContinuous<Platform>Posting()` to `src/sheets/sheets.ts`
10. **Sheet writer**: add `saveUnified<Platform>Result()` to `src/sheets/sheets.ts`

---

## Integration Point for Blog Generation Project

If you're integrating a **blog generation project** into this system:

**Option A — Plug into existing pipeline** (recommended):
- Blog generation output = HTML string
- Drop into `blogContent` column of the Blogs sheet tab
- Existing batch runners (`runMediumBatch`, `runDevtoBatch`, etc.) will pick it up automatically on next cron fire
- Generation project only needs to write to Google Sheets

**Option B — Add as a new batch agent**:
- Create `src/agents/blogGeneratorAgent.ts` 
- Call from `masterCoordinator.ts` before any posting batches
- Store generated HTML in `blogContent` column
- Subsequent posting batches read it from the same row

**Option C — Standalone with shared LLM pool**:
- Import `openRouterClient.ts` and `tavilyClient.ts` for LLM + market data
- Use same key rotation so you don't double-bill
- Write results to the same Google Sheet

**Shared utilities you get for free**:
- LLM with 15+4 key rotation (`src/config/openRouterClient.ts`)
- Market data enrichment (`tavilyClient.ts`)
- UTM injection (`src/utils/utm.ts`)
- Error logging & auto-fix (`src/errorInterceptor.ts`, `src/autoFix.ts`)
- Google Sheets R/W (`src/sheets/sheets.ts`)

---

## Error Handling Conventions

```typescript
// In any batch runner:
try {
  const result = await postTo<Platform>(page, content);
  await saveResult(row, result.url, 'Posted');
} catch (err) {
  recordError(err, '<platform>', 'post');       // logs to error-kb.json
  const fix = lookupError(normalizeError(err));
  if (fix) await applyFix(fix, { accountName: row.name });
  await saveResult(row, '', 'Failed');          // don't halt the batch
}
```

---

## Key File Paths Quick Reference

| What you need | Where it is |
|---|---|
| Main entry | `src/index.ts` |
| All batch runners | `src/coordinator/masterCoordinator.ts` |
| Content generators | `src/agents/contentAgentNew.ts` |
| Google Sheets R/W | `src/sheets/sheets.ts` |
| LLM client | `src/config/openRouterClient.ts` |
| Cron schedule | `src/scheduler-new.ts` |
| Browser utilities | `src/browser/stagehand.ts` (humanDelay) |
| Account files | `.accounts/*.json` |
| Session storage | `.sessions/` |
| Error logs | `logs/runtime.log`, `logs/error-kb.json` |
| Env vars | `.env` |
