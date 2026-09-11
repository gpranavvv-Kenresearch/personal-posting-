# Guest Posting Automation — PRD

## 1. Context

The existing 12 platform agents post to Ken Research's **owned** accounts (Medium, Substack, Notion, Naver, etc.) — no gatekeeper, fully automatable end to end.

Guest posting is fundamentally different: it targets **third-party sites** Ken Research doesn't control. Before any post can happen, the system has to *find* sites that accept guest contributions and *work out how* to submit to them. That's a discovery-and-qualification problem, not a login-and-post problem — hence a separate pipeline rather than a 13th platform agent bolted onto the existing pattern.

## 2. Goals

- Discover candidate guest-posting sites in Ken Research's niches (market research, BFSI, healthcare, industry reports, etc.) using free, API-key-free browser automation.
- Scan discovered sites to determine how they accept submissions (form vs. email vs. unknown).
- Track everything in a sheet, following the same dynamic-column-lookup convention the rest of the codebase already uses.
- Do all of this at a low, safe cadence — this is a prospecting/research pipeline, not a 674-posts/day pipeline.

## 3. Non-Goals (explicitly out of scope this phase)

- **Pitch/outreach message generation.** Deferred to a later session once messaging strategy is decided.
- **Actual form-fill submission.** `OutreachAgent` is a stub only (`throw new Error('Not implemented')`).
- **Multi-identity/account rotation.** Guest posting uses a single persistent outreach identity, not per-account rotation like X/FB/LI.
- **Any new paid API dependency.** No SerpAPI/Tavily/etc. for discovery — search is Playwright-driven against Bing/Google directly.

## 4. Architecture

```
GuestPostCoordinator
        │
        ├── SearchAgent        — Bing (primary) / Google (fallback) query automation
        ├── FilterAgent        — dedupe search results against sheet before insert
        ├── ScanAgent          — pure data-gathering: navigate, clear popups, extract raw signals
        ├── ClassifierAgent    — interprets ScanAgent's signals → submissionType/contactOrFormUrl/notes
        ├── TrackerAgent       — thin wrapper around sheets.ts guest-post read/write functions
        └── OutreachAgent      — (future) stub only, not implemented this phase
```

This is a **new orchestration pattern** for this codebase — `masterCoordinator.ts` today is a flat file of `runXBatch()` functions calling straight into `browser/*/login.ts` + `poster.ts` + `sheets.ts`, not a class/agent-based coordinator. The coordinator+named-sub-agents shape was chosen deliberately here because guest posting has more distinct sequential steps (search → filter → scan → classify → track) than a normal login→post flow, and separating scan (data-gathering) from classify (decision-making) means classification heuristics can be improved later without touching navigation code.

### Two batch flows

**Prospect batch:**
```
SearchAgent.search(queries) → FilterAgent.dedupe(results) → TrackerAgent.addGuestPostTarget(...)
```

**Scan batch:**
```
TrackerAgent.getUnscannedGuestPostTargets() → ScanAgent.scan(url) → ClassifierAgent.classify(signals) → TrackerAgent.saveGuestPostScanResult(...)
```

## 5. File Layout

New standalone directory (not scattered across `src/agents/`, `src/browser/`, etc.):

```
src/guestpost/
  coordinator/
    guestPostCoordinator.ts     — orchestrates prospect + scan batches
  agents/
    searchAgent.ts              — Bing/Google query automation
    filterAgent.ts              — dedupe-by-domain against sheet
    scanAgent.ts                — navigate + extract raw signals (forms, mailto links, page text)
    classifierAgent.ts          — raw signals → submissionType/contactOrFormUrl/notes
    trackerAgent.ts             — sheet read/write wrapper
    outreachAgent.ts            — stub, throws Not implemented
  config/
    guestPostProfile.ts         — loads .accounts/guestpost-profile.json (single identity)
```

Sheet layer additions live in the existing shared `src/sheets/sheets.ts` (same file every platform already extends).

## 6. Sheet Schema — new "Guest Post Targets" tab

Same spreadsheet as `Blogs`/`Social Media` (they share one spreadsheet ID already — `getSheetConfig('guestpost')` just points at a new tab name, no new spreadsheet needed). **Setup prerequisite: this tab must be created manually in the Google Sheet with these headers before any code runs.**

| Column | Purpose |
|---|---|
| Site URL | candidate site's URL (dedupe key) |
| Niche/Keyword Used | which search query surfaced it |
| Discovered Via | `Bing` or `Google` |
| Submission Type | `form` / `email` / `unknown` — empty means unscanned |
| Contact/Form URL | the actual submission form or mailto target |
| Status | `new` / `scanned` / `pitched` / `accepted` / `rejected` / `live` |
| Live URL | once a guest post goes live (future) |
| Notes | free text — ClassifierAgent's reasoning, scan errors, etc. |
| Discovered Date | ISO date |

Uses the existing dynamic `getColumnMap()` lookup pattern — adding columns later won't break anything, same as every other platform's sheet integration.

## 7. Sheet Functions (in `sheets.ts`)

- `getSheetConfig('guestpost')` → `{ id: BLOG_SHEET_ID, name: 'Guest Post Targets' }`
- `addGuestPostTarget(target: {siteUrl, niche, discoveredVia, ...})` — append-only insert, dedupe-by-URL check before insert
- `getUnscannedGuestPostTargets(limit = 15)` — mirrors the existing `pickRowsByEmptyStatus` pattern; picks rows where Submission Type is empty
- `saveGuestPostScanResult(rowIndex, result: {submissionType, contactOrFormUrl, notes})` — mirrors `saveUnifiedNotionResult`'s shape

## 8. Search Strategy

- **Bing primary** (`bing.com/search?q=...`) — far more tolerant of Playwright-driven automated queries than Google.
- **Google fallback** only if Bing returns nothing for a query.
- Query templates: Ken Research niches (market research, industry reports, BFSI, healthcare, etc.) combined with operators like `"write for us"`, `"guest post guidelines"`, `"contribute"`, `intitle:"guest post"`.
- Paginate 2–3 pages per query.
- Dedupe against domains already in the sheet before returning results.

## 9. Site Scanning

- `clearPopups(page)` first — third-party sites are full of unknown cookie/consent modals.
- Try common paths if the landing page doesn't obviously have submission info: `/write-for-us`, `/contribute`, `/guest-post-guidelines`.
- ScanAgent gathers raw signals only (forms present + their field types, `mailto:` links, relevant page text) — every DOM read goes through `waitForSelector`/`.waitFor()` first, never a raw `page.evaluate()` without a wait guard.
- ClassifierAgent turns those signals into `form` / `email` / `unknown` + notes.

## 10. Reused Infrastructure (no forking)

| Utility | Source | Purpose |
|---|---|---|
| `resilientClick` / `resilientType` / `classifyError` | `src/browser/resilientBrowser.ts` | 5-layer fallback interaction + error classification |
| `clearPopups` / `startPopupGuard` | `src/browser/popupGuard.ts` | Cookie/consent modal handling on unknown sites |
| `humanDelay()` | `src/browser/stagehand.ts` | All timing — no local `sleep()` deviation (the anti-pattern seen in the Notion pipeline) |

## 11. Identity & Config

Single outreach identity, not multi-account:
- `.accounts/guestpost-profile.json` — `{name, email, bio, websiteUrl}`, same convention as every other `.accounts/*.json` file
- `.sessions/guestpost/default` — one persistent browser profile, no `accountTracker.ts`-style per-nickname daily caps (not applicable — could add a soft per-day search-query cap later purely to avoid triggering bot detection, not for account-rotation reasons)

## 12. Error Handling

- Any CAPTCHA hit → `classifyError()` returns `NEEDS_HUMAN` → the current query/site is skipped, batch continues to the next item rather than retrying or hanging.

## 13. CLI & Cron Wiring

- `src/index.ts`: `guestpost-prospect` and `guestpost-scan` modes, following the existing `if (mode === 'run-notion-batch') {...}` + dynamic `import()` pattern.
- `package.json`: `"guestpost:prospect"` and `"guestpost:scan"` scripts.
- `src/scheduler-new.ts`: one daily prospect run + one daily scan run, off-peak IST hours, via the existing `cron.schedule(...)` + `wrap(name, fn)` pattern — must not collide with existing platform batch times.

## 14. Verification / Acceptance Criteria

1. `npm run guestpost:prospect` — new rows appear in "Guest Post Targets" with `Discovered Via` populated; running it twice produces no duplicate URLs.
2. `npm run guestpost:scan` — `Submission Type`/`Contact or Form URL` get filled for previously-empty rows; spot-check 5–10 real sites to confirm popups/cookie banners don't block scanning.
3. Manually trigger a Bing CAPTCHA scenario (rapid repeated queries) — confirm `classifyError` marks it `NEEDS_HUMAN` and the batch skips gracefully instead of hanging or retrying forever.
4. Confirm the two cron entries fire at their scheduled IST times via `npm run dev` logs, without colliding with existing platform batch times in `scheduler-new.ts`.

## 15. Setup Prerequisites (before implementation can be tested)

- [ ] Create the "Guest Post Targets" tab in the shared Google Sheet with the column headers listed in §6.
- [ ] Create `.accounts/guestpost-profile.json` with the outreach identity.
