# Ken Research Content Distribution Agent — Supervisor Instructions

## Goal
Automatically distribute Ken Research blog content across 12 platforms (3 social + 9 blog) via 45+ accounts, generating ~674 posts/day on a cron schedule.

## Supervisor Rules (Claude Code follows these)
1. Before ANY task — read the relevant file first
2. Before fixing ANY bug — read the broken file first
3. Never make changes without reading current code first
4. After fixing — run `npm run dev` and check output
5. If same error appears twice — try a completely different approach
6. Never spend more than 3 attempts on the same error
7. Log every fix and what caused it

## Never Do This
- Never open a second browser window per platform
- Never use Stagehand for login — use plain Playwright only
- Never use CSS selectors without waitForSelector first
- Never skip humanDelay between browser actions
- Never run npm run dev more than 3 times without fixing something
- Never hardcode API keys — use key rotation from config/

## Tech Stack
- **Runtime:** TypeScript, Node.js, ES2020
- **Browser:** Playwright with persistent Chrome profiles (.sessions/)
- **Content Generation:** OpenRouter API (15-key rotation), NVIDIA NIM fallback
- **SEO:** SerpAPI / Zenserp / Serpstack (30+ keys), Tavily (10 keys)
- **Scheduling:** node-cron (Asia/Kolkata timezone)
- **Data:** Google Sheets API (source + result tracking)
- **Validation:** Zod schemas
- **Accounts:** JSON files in .accounts/

## File Structure
```
src/
  index.ts                    Entry point (15+ CLI modes)
  scheduler-new.ts            Cron daemon (Asia/Kolkata)
  monitor.ts                  Error monitoring + auto-fix
  errorInterceptor.ts         Error KB + logging
  autoFix.ts                  Self-healing (session clear, restart, rotate)

  coordinator/
    masterCoordinator.ts      Batch orchestration for all 12 platforms

  agents/
    contentAgentNew.ts        Content generation (11 generator functions)
    seoAgentNew.ts            SEO analysis (SerpAPI/Tavily, P1/P2/P3 ranking)
    xAgentNew.ts              X posting agent
    fbBatchAgentNew.ts        Facebook batch (15 accounts)
    liBatchAgentNew.ts        LinkedIn batch (15 accounts)
    sanityAgent.ts            Pre-post validation (14 checks)
    reportDataAgent.ts        Ken Research report data scraper
    mediumBatchAgentNew.ts    Medium batch agent
    substackBatchAgentNew.ts  Substack batch agent
    guffizBatchAgentNew.ts    Guffiz batch agent
    hackmdBatchAgentNew.ts    HackMD batch agent
    instagramBatchAgentNew.ts Instagram batch agent
    youtubeBatchAgentNew.ts   YouTube Shorts agent
    [+ devto, linkmate, googlesite, linkedin-pulse, calisthenics agents]

  browser/
    twitter/                  login.ts + poster.ts
    facebook/                 login.ts + poster.ts
    linkedin/                 login.ts + poster.ts
    medium/                   login.ts + poster.ts
    substack/                 login.ts + poster.ts
    guffiz/                   login.ts + poster.ts
    hackmd/                   login.ts + poster.ts
    linkmate/                 login.ts + poster.ts
    devto/                    login.ts + poster.ts
    googlesite/               login.ts + poster.ts
    linkedin-pulse/           login.ts + poster.ts
    calisthenics/             login.ts + poster.ts
    instagram/                login.ts + poster.ts
    youtube/                  grokVideo.ts + uploader.ts
    stagehand.ts              humanDelay() utility only
    resilientBrowser.ts       Error classification + retry
    popupGuard.ts             Popup detection/suppression

  config/
    accounts.ts               X account CRUD
    accountTracker.ts         Daily posting limits per account
    openRouterClient.ts       OpenRouter API (15-key rotation)
    serpApiClient.ts           SERP lookup (3 providers, 30+ keys)
    tavilyClient.ts           Tavily web search (10 keys)
    settings.ts               Global config

  sheets/
    sheets.ts                 Google Sheets read/write (social + blog sheets)

  tools/
    browserTools.ts           Anthropic tool definitions (20+ tools)
    getPendingRows.ts         Query pending sheet rows
    saveResult.ts             Write results back to sheet
    [+ legacy: contentTools, seoTools, postToX, postToFacebook, postToLinkedin]

  utils/
    utm.ts                    UTM parameter injection (11 platforms)
    killChrome.ts             Browser cleanup
```

## Data Flow
```
Google Sheets (source rows)
  -> scheduler-new.ts (cron daemon, IST)
    -> masterCoordinator.ts (batch runners)
      -> seoAgentNew.ts (ranking + priority)
      -> contentAgentNew.ts (generate platform-specific content)
      -> browser/<platform>/poster.ts (post via Playwright)
    -> sheets.ts (write results + URLs back)
    -> errorInterceptor.ts (log errors to KB)
    -> monitor.ts (diagnose + auto-fix)
```

## Key npm Scripts
```bash
npm run dev              # Start cron daemon
npm run once             # Run once immediately
npm run schedule         # Start scheduler
npm run accounts         # Manage X accounts
npm run login            # Login to account
npm run fb-post          # Facebook posting
npm run linkedin-post    # LinkedIn posting
```

## Platforms & Schedule (IST)
| Platform        | Batches/Day | Accounts | Posts/Day |
|-----------------|-------------|----------|-----------|
| X               | 9           | 15       | ~135      |
| Facebook        | 5           | 13       | ~65       |
| LinkedIn        | 3           | 15       | ~45       |
| Google Sites    | 2           | 16       | ~32       |
| HackMD          | 2           | 15       | ~30       |
| Linkmate        | 2           | 15       | ~30       |
| Guffiz          | 2           | 15       | ~30       |
| Calisthenics    | 2           | 1        | ~2        |
| Substack        | 1           | 15       | ~15       |
| Dev.to          | 1           | 15       | ~15       |
| LinkedIn Pulse  | 1           | 15       | ~15       |
| Medium          | 1           | 15       | ~15       |

## Environment Variables
- `ANTHROPIC_API_KEY` — Claude API
- `OPENROUTER_API_KEY_1..15` — OpenRouter (15-key rotation)
- `NVIDIA_API_KEY_1..4` — NVIDIA NIM fallback
- `ZENSERP_API_KEY_1..10`, `SERPSTACK_API_KEY_1..10`, `SERPAPI_KEY_1..12` — SERP providers
- `TAVILY_API_KEY_1..10` — Web search
- `X_USERNAME`, `X_PASSWORD`, `X_HANDLE` — Default X account
- Account credentials stored in `.accounts/` JSON files

## Known Working Code Patterns
- Login uses: `chromium.launchPersistentContext` with `channel:'chrome'`
- Tweet box: `[data-testid="tweetTextarea_0"]`
- Post button: `div[role="button"]:has(span:has-text("Post"))`
- Typing: `page.keyboard.type(text, { delay: 80 })`
- API key rotation: round-robin with automatic fallback on rate limit
- Batch counters persisted in `.sessions/batch-counters.json`

## Past Mistakes (Never Repeat)
- Used Stagehand for login -> browser closed mid-login
- Used `page.fill()` -> target closed error
- Opened Stagehand after login -> second browser opened
- Used `networkidle` -> timeout on X.com
- Hardcoded single API key -> rate limited immediately
