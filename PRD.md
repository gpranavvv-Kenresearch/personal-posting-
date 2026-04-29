# Product Requirements Document
## Ken Research — Automated Content Distribution Agent

**Version:** 3.0
**Date:** April 17, 2026
**Status:** Production

---

## 1. Overview

The Ken Research Content Distribution Agent is a fully autonomous system that takes blog articles from a Google Sheet and distributes them across **12 platforms** — 3 social media platforms and 9 blog/content platforms. It handles SEO analysis, AI content generation, browser-based posting, error detection, and self-healing without human intervention during operation.

**Daily throughput: ~674 posts/day**

---

## 2. Problem Statement

Ken Research publishes high-value market research articles that need broad online distribution to maximize SEO backlinks and audience reach. Manually posting across 12 platforms and 45 accounts is not feasible. The system must:

- Distribute content at scale across all platforms every day
- Generate platform-appropriate content for each destination
- Detect and recover from browser/login/API errors without stopping
- Learn from errors so the same issue never requires human intervention twice
- Repost valuable content weekly using fresh angles

---

## 3. System Architecture

```
Google Sheet (source of truth)
        ↓
[Scheduler — node-cron, Asia/Kolkata]
        ↓
[Master Coordinator — per-platform batch runners]
        ↓                     ↓                     ↓
[SEO Agent]          [Content Agent]        [Browser Agents]
 SerpAPI/Zenserp/     Claude AI              Playwright
 Serpstack             per platform           per platform
        ↓                     ↓                     ↓
[Google Sheets — write back results, URLs, status, errors]
        ↓
[Error Interceptor → Error KB → Auto-Fix → Monitor]
        ↓
[Claude CLI /loop — human-review-code fixes only]
```

---

## 4. Platforms

### 4.1 Social Media

| Platform | Accounts | Batches/Day | Posts/Day | Schedule (IST) |
|----------|----------|-------------|-----------|----------------|
| X (Twitter) | 15 | 9 | 135 | 11:00, 12:00, 12:30, 13:30, 14:30, 15:00, 15:30, 16:30, 17:00 |
| Facebook | 13 | 5 | 65 | 11:30, 12:30, 13:30, 14:30, 15:30 |
| LinkedIn | 15 | 3 | 45 | 11:30, 13:30, 15:30 |

### 4.2 Blog/Content Platforms — Wave 1 (11:30–13:30 IST)

| Platform | Batches/Day | Posts/Day | Time (IST) |
|----------|-------------|-----------|------------|
| Google Sites | 2 | 32 | 11:30 (FIRST — sets P1/P2/P3) |
| HackMD | 2 | 30 | 11:45 |
| Linkmate | 2 | 30 | 12:00 |
| Guffiz | 2 | 30 | 12:15 |
| Calisthenics | 2 | 2 | 12:30 |
| Substack | 1 | 15 | 12:45 |
| Dev.to | 1 | 15 | 13:00 |
| LinkedIn Pulse | 1 | 15 | 13:15 |
| Medium | 1 | 15 | 13:30 |

### 4.3 Blog/Content Platforms — Wave 2 (14:30–15:30 IST)

| Platform | Time (IST) |
|----------|------------|
| Google Sites Batch 2 | 14:30 (FIRST) |
| HackMD Batch 2 | 14:45 |
| Linkmate Batch 2 | 15:00 |
| Guffiz Batch 2 | 15:15 |
| Calisthenics Batch 2 | 15:30 |

**Google Sites always runs FIRST in each wave** — it sets P1/P2/P3 SEO priority that all other blog platforms read.

### 4.4 Daily Totals

| Category | Posts/Day |
|----------|-----------|
| Social (X + FB + LI) | 245 |
| Blog platforms | ~429 |
| **Grand Total** | **~674** |

---

## 5. Data Model (Google Sheet — "insta" tab)

### Input Columns (user-populated)

| Column | Description |
|--------|-------------|
| `targetUrl` | Ken Research blog URL |
| `title` | Article title |
| `marketValue` | Market size mentioned in article |
| `name` | X/FB/LI account handle to post from |

### SEO Columns (system-written by SEO Agent)

| Column | Description |
|--------|-------------|
| `seoRanking` | Google search rank number |
| `seoIndexed` | yes / no / unknown |
| `seoPage` | Google result page (1, 2, 3, 4, 5+) |
| `priority` | P1 / P2 / P3 |
| `lastSerpCheckDate` | Date of last SERP check (YYYY-MM-DD) |

### Content Columns (system-written by Content Agent)

| Column | Description |
|--------|-------------|
| `xPost` | Generated tweet text |
| `fbPost` | Generated Facebook post |
| `liPost` | Generated LinkedIn post |
| `googleSitePost` | Google Sites article content |
| `hackmdPost` | HackMD article content |
| `mediumPost` | Medium article content |
| `substackPost` | Substack newsletter content |
| `guffizPost` | Guffiz article content |
| `devtoPost` | Dev.to article content |
| `linkedinPulsePost` | LinkedIn Pulse article content |
| `linkmatePost` | Linkmate post content |
| `calisthenicsPost` | Calisthenics blog content |

### Result Columns (system-written per platform)

| Column | Description |
|--------|-------------|
| `xPostUrl` | URL of posted tweet |
| `xStatus` | Posted / Failed / Error |
| `xError` | Error message if failed |
| `xBatch` | Batch number (e.g. "Batch 5") |
| `fbPostUrl` | URL of posted Facebook post |
| `fbStatus` / `fbError` / `fbBatch` | Same pattern |
| `liPostUrl` | URL of posted LinkedIn post |
| `liStatus` / `liError` / `liBatch` | Same pattern |
| *(same for medium, hackmd, substack, devto, guffiz, linkmate, googlesite, linkedinpulse, calisthenics)* | |

---

## 6. Agent Pipeline (per batch)

### 6.1 X Batch Flow

```
1. getRowsForContinuousXPosting(15) — repost-eligible rows (P1 daily, P2 alt days, P3 Mon-Sat)
2. Fill remaining slots from getUnassignedRowsAsSheetRows()
3. For each row:
   a. runSeoAnalysis() → rank + priority → saveUnifiedSeoData()
   b. generateTweet() → Claude AI (230 char limit)
   c. runXAgent() → Playwright browser post
   d. If TWEET_OVER_LIMIT:N → regenerate with tighter limit (up to 3 attempts)
   e. savePostingResult() → write URL + status + batch to sheet
   f. If exception → recordError() → applyFix() → save error to sheet
```

### 6.2 FB / LI Batch Flow

```
1. getRowsForContinuousFbPosting(15) or LI equivalent
2. Fill from unassigned rows
3. For each row:
   a. Read SEO data already written by X batch (no re-analysis)
   b. generateFbPost() / generateLiPost() → Claude AI
   c. Browser post via Playwright
   d. saveFbBatchResult() / saveLiBatchResult()
   e. Error handling → KB → auto-fix
```

### 6.3 Blog Platform Batch Flow

```
1. getRowsForContinuous[Platform]Posting(15 or 16)
2. For each row:
   a. Read SEO priority from sheet (set by Google Sites batch)
   b. generate[Platform]Post() → Claude AI (long-form content)
   c. Browser automation → post on platform
   d. save[Platform]Result() → URL + status + batch
   e. Error handling → KB → auto-fix
```

---

## 7. SEO Agent

**Provider rotation:** Round-robin across 3 providers — SerpAPI, Zenserp, Serpstack. State persisted in `.sessions/provider-rotation.json`. Rotates after every call (success or failure). 403 is treated as exhausted (same as 401/429).

**Priority assignment:**

| Rank | Priority | Posting frequency |
|------|----------|-------------------|
| 1–30 (Page 1–3) | P1 | Every day |
| 31–69 (Page 4–7) | P2 | Alternate days (Mon/Wed/Fri) |
| 70+ or not indexed | P3 | Mon–Sat only |

**Weekly recheck:** Saturday 22:00 IST — re-runs SERP for all URLs older than 7 days. Updates priority. If priority changed, generates fresh content.

---

## 8. Content Agent

All content generated by Claude AI (`claude-opus-4-6`).

**Tweet generation:**
- Base limit: 230 characters (leaves buffer for X's URL shortening)
- If `TWEET_OVER_LIMIT:N` thrown by poster → regenerate with `230 - N` character limit
- Up to 3 regeneration attempts
- Unique content per URL: past tweets stored in `.sessions/tweet-history.json` (max 5 per URL) and injected into prompt as "DO NOT reuse" list
- Angle, CTA, and structure must differ each time same URL is reposted

**Blog content:**
- Long-form, 600–1200 words depending on platform
- Platform-specific tone (technical for Dev.to/HackMD, professional for LinkedIn Pulse, conversational for Medium/Substack)

---

## 9. Error Detection & Self-Healing

### 9.1 Error Knowledge Base (`logs/error-kb.json`)

Every error is normalized (timestamps/IDs stripped), hashed, and stored with:

```
id                  — SHA-256 hash of normalized pattern (first 8 chars)
normalizedPattern   — stable error string for deduplication
rawSamples          — last 3 actual error messages
platform            — which platform failed
classification      — RETRYABLE / NEEDS_HUMAN / FATAL / FIXABLE
count               — how many times seen
auto_resolvable     — can code fix this without human?
auto_trusted        — true after 3 successful fixes (fully autonomous)
resolution_type     — action to take
worked_count        — successful fix applications
failed_count        — failed fix applications
diagnosis           — Claude-generated 1-2 sentence fix suggestion
```

### 9.2 Resolution Types

| Resolution | Action |
|------------|--------|
| `wait-and-retry` | Skip row, continue — transient timeout/network |
| `clear-session` | Delete `.sessions/<platform>/<account>/` — stale login |
| `restart-browser` | Close browser context — browser crash |
| `rotate-account` | Add to `.sessions/skip-accounts.json` — rate limited |
| `fatal-skip` | Permanently skip account — suspended/banned |
| `human-review-login` | Write to `logs/human-alerts.json` — OTP/2FA/CAPTCHA |
| `human-review-code` | Write to `logs/human-alerts.json` — selector broke |

### 9.3 Auto-Trust Learning Loop

```
Batch run N:
  Row 1 → ERROR: "still on /login page"
  → KB: unknown → diagnoseError() via Claude API
  → resolution_type: 'clear-session' saved to KB
  → applyFix(): session directory deleted
  → Row 1 marked Failed (NOT retried)

Row 2 → same platform, runs with cleared session
  → SUCCESS → recordFixOutcome(entry.id, true) → worked_count = 1

Next 2 batch runs: same pattern → worked_count = 3 → auto_trusted = true

Future batches: same error → fix applied fully automatically, no Claude API call needed
```

### 9.4 Monitor Cycle

Internal `node-cron` inside the daemon runs every 3 minutes:
- Reads `logs/runtime.log` from last byte offset (no re-processing)
- Parses ERROR JSON lines
- Looks up KB → applies fix or escalates
- Unknown errors → calls `diagnoseError()` → saves to KB → writes `logs/human-alerts.json`
- Returns summary: `{newErrors, autoFixed, humanAlerts, unknownErrors}`

**Log rotation:** If `logs/runtime.log` exceeds 50MB → renamed to `runtime.log.bak` → fresh file started.

### 9.5 Claude CLI Role

Claude CLI `/loop 3m npm run dev -- monitor` runs alongside the daemon. It reads the monitor output and handles `human-review-code` alerts — reading source files, editing selectors, updating the KB. It does NOT retry failed rows.

**Key rule:** Failed row N is never retried. The fix is verified when row N+1 runs on the same platform.

---

## 10. Scheduler

All times are Asia/Kolkata (IST). Implemented with `node-cron` in `src/scheduler-new.ts`.

```
11:00  — X Batch 1
11:30  — X Batch 2 · FB Batch 1 · LI Batch 1 · Google Sites Batch 1
11:45  — HackMD Batch 1
12:00  — X Batch 3 · Linkmate Batch 1
12:15  — Guffiz Batch 1
12:30  — X Batch 4 · Calisthenics Batch 1
12:45  — Substack Batch
13:00  — Dev.to Batch
13:15  — LinkedIn Pulse Batch
13:30  — X Batch 5 · FB Batch 2 · LI Batch 2 · Medium Batch
14:30  — X Batch 6 · FB Batch 3 · Google Sites Batch 2
14:45  — HackMD Batch 2
15:00  — X Batch 7 · Linkmate Batch 2
15:15  — Guffiz Batch 2
15:30  — X Batch 8 · FB Batch 4 · LI Batch 3 · Calisthenics Batch 2
16:30  — X Batch 9
17:00  — X Batch 10 (if needed)

*/3    — Monitor cycle (every 3 min, all day)
00:00  — Reset daily batch counters
22:00 Sat — Weekly SERP recheck
10:00 Sun — Sunday Examination (move failed posts to end of sheet for retry)
```

---

## 11. File Structure

```
src/
  agents/
    seoAgentNew.ts          — SERP analysis, priority assignment
    contentAgentNew.ts      — tweet/FB/LI/blog generation per platform
    xAgentNew.ts            — X posting agent loop
    guffizBatchAgentNew.ts  — Guffiz batch agent
    hackmdBatchAgentNew.ts  — HackMD batch agent
    instagramBatchAgentNew.ts
    substackBatchAgentNew.ts
    youtubeBatchAgentNew.ts

  browser/
    twitter/login.ts        — Playwright stealth login
    twitter/poster.ts       — Playwright tweet posting + char counter
    facebook/login.ts
    facebook/poster.ts
    linkedin/login.ts
    linkedin/poster.ts (via pulse)
    medium/                 — Medium browser automation
    hackmd/                 — HackMD browser automation
    substack/               — Substack browser automation
    guffiz/                 — Guffiz browser automation
    linkmate/               — Linkmate browser automation
    devto/                  — Dev.to browser automation
    googlesite/             — Google Sites browser automation
    linkedin-pulse/         — LinkedIn Pulse browser automation
    calisthenics/           — Calisthenics browser automation
    resilientBrowser.ts     — Shared aria/screenshot helpers

  coordinator/
    masterCoordinator.ts    — All batch runners + error wiring

  config/
    serpApiClient.ts        — Round-robin SERP provider rotation
    openRouterClient.ts     — LLM client
    accounts.ts             — Account config loader

  sheets/
    sheets.ts               — All Google Sheets read/write functions

  tools/
    browserTools.ts         — Browser tool wrappers
    getPendingRows.ts
    postToFacebook.ts
    postToLinkedin.ts
    postToX.ts
    saveResult.ts

  errorInterceptor.ts       — console.error patch → runtime.log + Error KB
  autoFix.ts                — Resolution executor (clear-session, restart, etc.)
  monitor.ts                — Log tail + KB lookup + human alert writer
  scheduler-new.ts          — All cron jobs
  index.ts                  — Entry point + CLI modes

logs/
  runtime.log               — All ERROR/WARN lines (JSON, streamed)
  error-kb.json             — Error knowledge base
  human-alerts.json         — Errors needing human/code fix
  .monitor-state.json       — Byte offset for log tailing

.sessions/
  batch-counters.json       — Ever-incrementing batch numbers per platform
  provider-rotation.json    — Current SERP provider index
  skip-accounts.json        — Rate-limited or banned accounts
  tweet-history.json        — Past tweets per URL (deduplication)
  chrome-*/                 — Persistent browser profiles per account
```

---

## 12. CLI Modes

```bash
npm run dev                              # Start cron daemon
npm run dev -- run-x-batch              # Run X batch once now
npm run dev -- run-fb-batch             # Run FB batch once now
npm run dev -- run-li-batch             # Run LI batch once now
npm run dev -- run-medium-batch         # Run Medium batch once now
npm run dev -- run-linkmate-batch       # Run Linkmate batch once now
npm run dev -- run-devto-batch          # Run Dev.to batch once now
npm run dev -- run-googlesite-batch     # Run Google Sites batch once now
npm run dev -- run-linkedin-pulse-batch # Run LinkedIn Pulse batch once now
npm run dev -- run-calisthenics-batch   # Run Calisthenics batch once now
npm run dev -- run-substack-batch       # Run Substack batch once now
npm run dev -- run-guffiz-batch         # Run Guffiz batch once now
npm run dev -- run-hackmd-batch         # Run HackMD batch once now
npm run dev -- monitor                  # Run one monitor cycle (JSON output)
npm run dev -- status                   # Show sheet stats
npm run dev -- reset-medium-posts       # Clear Medium posting data for retesting
npm run dev -- save-x-session <nick>    # Login and save X browser session
npm run dev -- save-medium-session <nick>
npm run dev -- save-linkmate-session <nick>
npm run dev -- save-googlesite-session <nick>
npm run dev -- save-calisthenics-session <nick>
npm run dev -- save-substack-session <nick>
npm run dev -- save-guffiz-session <nick>
npm run dev -- save-hackmd-session <nick>
```

---

## 13. Environment Variables

```
ANTHROPIC_API_KEY       — Claude AI (content generation + error diagnosis)
SERPAPI_KEY             — SerpAPI provider
ZENSERP_API_KEY         — Zenserp provider
SERPSTACK_API_KEY       — Serpstack provider
GOOGLE_SERVICE_ACCOUNT_JSON — Google Sheets access
```

---

## 14. Account Storage

Account credentials stored outside the repo in `.accounts/`:

```
.accounts/
  accounts.json           — X accounts (handle, email, password, sessionDir)
  facebook-accounts.json  — Facebook accounts
  linkedin-accounts.json  — LinkedIn accounts
```

Browser sessions (persistent Chrome profiles) stored in `.sessions/`:
```
.sessions/
  x/<handle>/              — X session per account
  facebook/<nickname>/     — Facebook session
  linkedin/<nickname>/     — LinkedIn session
  medium/<nickname>/       — Medium session
  hackmd/<nickname>/       — HackMD session
  substack/<nickname>/     — Substack session
  guffiz/<nickname>/       — Guffiz session
  linkmate/<nickname>/     — Linkmate session
  googlesite/<nickname>/   — Google Sites session
  calisthenics/<nickname>/ — Calisthenics session
```

---

## 15. Weekly Maintenance Events

| Time | Event | Action |
|------|--------|--------|
| Saturday 22:00 IST | Weekly SERP Recheck | Re-checks ranking for all URLs > 7 days old. Updates priority. Clears old post URLs if priority changed so they can be reposted with fresh content. |
| Sunday 10:00 IST | Sunday Examination | Moves all rows with Failed/Error status to the end of the sheet so the batch picks them up again next week. |
| Daily 00:00 IST | Counter Reset | Resets `batch-counters.json` so next day's batches start at Batch 1. |

---

## 16. Constraints & Rules

- **No parallel browser sessions** — all posting is sequential (one account at a time) to avoid detection
- **Google Sites first** — must run before all other blog platforms in each wave to set SEO priority
- **Failed row rule** — a failed row is never retried in the same batch. Fix is verified on the next row
- **Tweet quality** — over-limit tweets are regenerated (not trimmed) to preserve content quality
- **SERP rotation** — providers rotate equally regardless of success/failure; 403 = exhausted
- **Tweet uniqueness** — past tweets per URL are tracked; each repost must use a different angle, CTA, and structure
- **Session management** — Chrome profiles persist across runs; never re-login unless session is explicitly cleared
- **Content model** — always `claude-opus-4-6` for content generation and error diagnosis
- **Posting window** — no hard window enforced in code; cron schedule limits posting to 11:00–17:00 IST

---

## 17. Known Error Patterns (Pre-seeded KB)

| Error Pattern | Classification | Resolution |
|---------------|----------------|------------|
| `Timeout Nms exceeded` | RETRYABLE | wait-and-retry |
| `net::ERR_` / `ECONNRESET` | RETRYABLE | wait-and-retry |
| `Target page/context closed` | RETRYABLE | restart-browser |
| `still on /login page` | FIXABLE | clear-session |
| `Unable to log in` | FIXABLE | clear-session |
| `OTP` / `2FA` / `captcha` / `verify` | NEEDS_HUMAN | human-review-login |
| `suspended` / `banned` | FATAL | fatal-skip |
| `Send button not found` | FIXABLE | human-review-code |
| `locator.click: Timeout` | FIXABLE | human-review-code |
| `TWEET_OVER_LIMIT:N` | FIXABLE | regenerate (handled inline, not KB) |

---

## 18. Success Metrics

| Metric | Target |
|--------|--------|
| Daily posts | ~674 across 12 platforms |
| Error auto-resolution rate | >90% after KB warm-up |
| Human interventions/day | <2 (code-level only) |
| Tweet regeneration rate | <5% of X posts |
| SERP provider uptime | 100% (3-provider rotation) |
| Session re-login rate | <1% per day (persistent profiles) |
