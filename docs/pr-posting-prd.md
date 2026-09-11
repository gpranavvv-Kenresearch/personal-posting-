# PR (Press Release) Distribution Automation — PRD / POC Plan

## 1. Context

Ken Research wants to distribute press releases across free online PR distribution sites (PRLog, OpenPR, 1888PressRelease, free-press-release.com, etc.). Unlike guest posting — where every site's pitch process is bespoke and largely un-automatable without a human-authored pitch — free PR distribution sites are far more standardized: a headline, body, category, and contact-info form that either submits immediately or requires a lightweight free account.

That standardization is why this POC's scope is wider than guest posting's: **this one actually submits**, not just discovers and qualifies. The full loop is: **generate a press release from an existing content row → find/qualify free PR sites → submit to the ones that don't require signup.**

## 2. Decisions Locked For This POC

| Decision | Choice |
|---|---|
| Site scope | **Free sites only.** No payment-flow automation (PR Newswire, Business Wire, etc. are out of scope). |
| Content source | **Auto-generated.** A new `generatePressRelease()` in `contentAgentNew.ts` builds the press release from the same `Blogs` sheet row every other platform already posts from (title, market data, targetUrl) — same LLM-generation pattern as blog/social content. No manual-authoring tab. |
| Posting scope | **Find + actually submit.** A real `PosterAgent` fills and submits qualifying forms — not stubbed like guest posting's `OutreachAgent`. |

## 3. Additional Scoping Recommendation (flagging, not assuming)

Many free PR sites require a free account before you can submit; others accept fully anonymous submissions. Building per-site login/session infrastructure (mirroring `browser/<platform>/login.ts`) for a long tail of PR sites is a lot of surface area for a first POC.

**Recommendation:** Phase 1 targets only sites that accept **anonymous submission** (no signup) — fully automatable with zero account/session management, same one-shot pattern as filling any web form. Sites that require signup get discovered and tracked (`ClassifierAgent` marks them `signup_required`) but are **not** auto-submitted to yet — that's a Phase 2 needing the same login/session pattern the platform agents already use.

This keeps the POC's posting logic simple and reliable rather than half-working across a wide, inconsistent long tail. Flag if you'd rather include signup-required sites from the start.

## 4. Architecture

```
PRCoordinator
        │
        ├── ContentAgent       — generatePressRelease(row) — new fn in contentAgentNew.ts (not a new file)
        ├── SearchAgent        — Bing (primary) / Google (fallback) query automation
        ├── FilterAgent        — dedupe search results against sheet before insert
        ├── ScanAgent          — navigate, clear popups, extract raw signals (form fields, signup requirement)
        ├── ClassifierAgent    — raw signals → submissionType (anonymous_form / signup_required / email / unknown)
        ├── PosterAgent        — fills + submits anonymous_form sites with ContentAgent's generated release
        └── TrackerAgent       — thin wrapper around sheets.ts PR read/write functions
```

Same coordinator + named-sub-agent shape as the guest-posting plan, for the same reason: this pipeline has more distinct sequential steps than a simple login→post flow.

### Shared discovery infrastructure (avoid duplicating guest posting's search logic)

`SearchAgent`/`FilterAgent` here solve the same problem guest posting's do — "find sites matching queries, dedupe against what's already tracked" — just with PR-specific query templates and a different sheet tab. Rather than forking that logic twice, **factor a shared `src/discovery/` module** (`searchEngine.ts` for Bing/Google query automation, `dedupe.ts` for domain-dedup logic) that both `src/guestpost/agents/searchAgent.ts` and `src/prposting/agents/searchAgent.ts` call into, each supplying their own query templates and sheet target.

### Three flows — discovery is decoupled from posting

Site discovery/qualification and actual posting are **separate concerns on separate cadences**: discovery builds a reusable backlog of qualified sites; posting is triggered per content row, same `row <rowNumber> <platform>` convention every other platform in this codebase already uses.

**1. Discover batch** (builds/maintains the site backlog, independent of any specific release):
```
SearchAgent.search(prQueries) → FilterAgent.dedupe(results) → TrackerAgent.addPrTarget(...)
```

**2. Scan batch** (qualifies whatever's in the backlog):
```
TrackerAgent.getUnscannedPrTargets() → ScanAgent.scan(url) → ClassifierAgent.classify(signals) → TrackerAgent.saveScanResult(...)
```

**3. Post** (per-row, matches `npm run dev -- row <n> prposting`):
```
ContentAgent.generatePressRelease(row) → TrackerAgent.getQualifiedAnonymousSites()
  → for each site: PosterAgent.submit(url, release) → TrackerAgent.saveSubmissionResult(...)
  → saveUnifiedPrResult(row, consolidatedResult)
```

## 5. File Layout

```
src/prposting/
  coordinator/
    prCoordinator.ts            — orchestrates discover, scan, and per-row post flows
  agents/
    searchAgent.ts              — PR-specific query templates, calls src/discovery/searchEngine.ts
    filterAgent.ts               — dedupe-by-domain against sheet
    scanAgent.ts                 — navigate + extract raw signals (form fields, signup wall detection)
    classifierAgent.ts           — raw signals → submissionType
    posterAgent.ts               — fills + submits anonymous_form sites
    trackerAgent.ts              — sheet read/write wrapper

src/discovery/                   — NEW shared module (see §4)
  searchEngine.ts                — Bing-primary/Google-fallback query automation (generic, query-list in)
  dedupe.ts                      — domain-dedup helper
```

`ContentAgent` is **not** a new file — `generatePressRelease()` is added directly to the existing `src/agents/contentAgentNew.ts`, alongside every other platform's content generator.

## 6. Sheet Schema

Same spreadsheet as `Blogs`/`Social Media`/`Guest Post Targets`. Only **one** new tab — content comes from the existing `Blogs` tab (same row every other platform posts from), not a separate manually-authored tab.

**"PR Distribution Targets"** (site directory — mirrors Guest Post Targets):

| Column | Purpose |
|---|---|
| Site URL | candidate site's URL (dedupe key) |
| Discovered Via | `Bing` or `Google` |
| Submission Type | `anonymous_form` / `signup_required` / `email` / `unknown` — empty means unscanned |
| Contact/Form URL | the actual submission form |
| Status | `new` / `scanned` / `submitted` / `live` / `skipped_signup_required` |
| Live URL | once the PR is confirmed live on that site |
| Notes | ClassifierAgent's reasoning, scan/submit errors |
| Discovered Date | ISO date |

**Existing `Blogs` tab** gains the same per-platform result columns every other platform already has: `PR Post Status`, `PR Post URLs` (plural/append — one row can submit to multiple sites), `PR Batch`, `Last Posted PR` — following `saveUnifiedNaverResult`'s exact shape.

## 7. Sheet Functions (in `sheets.ts`)

- `getSheetConfig('prposting')` → `{ id: BLOG_SHEET_ID, name: 'PR Distribution Targets' }`
- `addPrTarget(target)` — dedupe-by-URL insert, mirrors `addGuestPostTarget`
- `getUnscannedPrTargets(limit = 15)` — mirrors `pickRowsByEmptyStatus`
- `saveScanResult(rowIndex, result)` — for non-anonymous sites (no submission attempted)
- `getQualifiedAnonymousSites(limit)` — reads "PR Distribution Targets" for `Submission Type = anonymous_form` rows ready to receive a submission
- `saveUnifiedPrResult(row, result)` — writes back to the `Blogs` tab, mirrors `saveUnifiedNaverResult`'s shape exactly (this is what makes `row <n> prposting` consistent with every other platform)

## 8. Search Strategy

Same Bing-primary/Google-fallback mechanics as guest posting. PR-specific query templates: `"submit press release free"`, `"free PR distribution site"`, `"post press release online free"`, `"free press release submission"`, combined with Ken Research's niches where relevant.

## 9. Scan Strategy

`ScanAgent` gathers, per candidate site:
- Whether a submission form is reachable without login (checks for login-wall redirects, "sign up to continue" prompts)
- The form's field set (headline/title, body, category dropdown, contact name/email, optional media upload)
- Any `mailto:` fallback if no form exists

`ClassifierAgent` turns that into one of: `anonymous_form`, `signup_required`, `email`, `unknown`.

## 10. Content Generation (`ContentAgent`)

- `generatePressRelease(row: SheetRow)` — new function in `contentAgentNew.ts`, same pattern as `generateSlideShareContent`/`generateGoogleSitePost`/etc.
- Builds from the row's existing `title`, `marketValue`, `cagr`, `blogContent`/`targetUrl` — same source data every other platform already generates from, so no new content-input surface is needed.
- Output shape: `{ headline, body, category, contactName, contactEmail, boilerplate, targetUrl }` — matches the field set `ScanAgent` looks for on real PR forms (§9).

## 11. Posting Strategy (`PosterAgent`)

- Triggered per-row via `npm run dev -- row <n> prposting` (same convention as `naver`/`speakerdeck`/`issuu`), not a standalone batch — mirrors every other platform's `runRetryRow` case.
- Calls `ContentAgent.generatePressRelease(row)` once, then submits that same release to every currently-qualified `anonymous_form` site from `TrackerAgent.getQualifiedAnonymousSites()`.
- Maps headline/body/category/contact fields onto whatever `ScanAgent` found for that site, using `resilientType`/`resilientClick` (never raw selectors — third-party site DOM is unknown and will vary wildly).
- `clearPopups(page)` before interacting, same as guest posting.
- On submit, waits for a confirmation signal (URL change, "thank you"/"submitted" text, or a returned live URL) — if none found within a timeout, marks that site's `Status = submitted` but `Live URL` empty and flags in Notes for manual follow-up, rather than guessing.
- Any CAPTCHA/verification wall mid-submission → `classifyError()` → `NEEDS_HUMAN` → skip that site, continue to the next.
- Writes one consolidated result back to the `Blogs` row via `saveUnifiedPrResult` once all qualified sites have been attempted.

## 12. Reused Infrastructure

Same as guest posting: `resilientClick`/`resilientType`/`classifyError` (`resilientBrowser.ts`), `clearPopups`/`startPopupGuard` (`popupGuard.ts`), `humanDelay()` (`stagehand.ts`) — plus the new shared `src/discovery/` module described in §4.

## 13. Identity & Config

Single outreach identity (not per-account rotation): `.accounts/prposting-profile.json`, `.sessions/prposting/default` — matches guest posting's model, since PR distribution is one company submitting under one identity, not per-nickname accounts like the social platforms. The profile supplies contact-field defaults (name/email/boilerplate), not login credentials — Phase 1 targets anonymous-submission sites only (§3).

## 14. CLI & Cron Wiring

- `src/index.ts`:
  - `prposting-discover` mode — runs the discover batch (site backlog building).
  - `prposting-scan` mode — runs the scan batch (qualify backlog).
  - `case 'prposting'` added to `runRetryRow`'s platform switch in `masterCoordinator.ts` — so `npm run dev -- row <n> prposting` generates + submits that row's release, consistent with every other platform.
- `package.json`: `"prposting:discover"` and `"prposting:scan"` scripts (posting itself uses the existing `row <n> <platform>` pattern — no new script needed).
- `src/scheduler-new.ts`: low cadence for discover/scan (not a high-volume pipeline) — one discover run + one scan run per day/week, off-peak IST, via the existing `cron.schedule(...)` + `wrap(name, fn)` pattern. Posting stays per-row/manual initially, not its own cron — could be added once discover/scan have built a reliable backlog.

## 15. Verification / Acceptance Criteria

1. `npm run prposting:discover` — new rows appear in "PR Distribution Targets" with no duplicate URLs on a second run.
2. `npm run prposting:scan` — for 5–10 real free PR sites, confirm `anonymous_form`/`signup_required`/`email`/`unknown` are classified correctly (spot-check manually).
3. `npm run dev -- row <n> prposting` — confirm a press release is generated from that row and actually submitted to the currently-qualified `anonymous_form` sites; spot-check at least 2 submissions manually on the target site to confirm the release actually appears (not just that the form "looked" submitted).
4. Confirm a CAPTCHA/signup-wall mid-flow triggers `NEEDS_HUMAN` and skips that site gracefully rather than hanging the whole row.
5. Confirm cron entries fire without colliding with existing batch times.

## 16. Non-Goals (explicit)

- Paid PR distribution networks (PR Newswire, Business Wire, etc.) — no payment automation.
- Auto-submission to `signup_required` sites in this phase (tracked/classified only — see §3).
- Multi-identity/account rotation.

## 17. Setup Prerequisites

- [ ] Create "PR Distribution Targets" tab with the columns in §6.
- [ ] Add `PR Post Status` / `PR Post URLs` / `PR Batch` / `Last Posted PR` columns to the existing `Blogs` tab.
- [ ] Create `.accounts/prposting-profile.json` with the outreach identity (contact-field defaults, not login).
