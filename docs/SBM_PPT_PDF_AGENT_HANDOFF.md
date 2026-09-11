# SBM and PPT/PDF Platform Handoff

## Purpose

This document transfers the current implementation knowledge for the social-bookmarking (SBM) and document-sharing platforms to another Claude Code agent. It describes what exists now, how data moves, what can be run, and what remains incomplete.

Evidence date: 2026-08-20 (re-verified; SlideShare export mismatches confirmed still present). Treat the source code as authoritative if it changes after this date.

## Read This First

The receiving agent must read these files before changing anything:

1. `AGENTS.md`
2. `package.json`
3. `src/scheduler-new.ts`
4. `src/coordinator/masterCoordinator.ts`
5. `src/sheets/sheets.ts`
6. The target platform's `src/browser/<platform>/login.ts` and `poster.ts`
7. The matching `src/tools/run*Batch.ts`, if present
8. `src/utils/contentConverter.ts`, `src/utils/pptGenerator.ts`, and `src/utils/utm.ts` for PDF/PPT platforms

Do not use Stagehand for login. These integrations use Playwright persistent Chrome profiles. Keep one browser context per platform/account operation, wait for selectors before using them, retain `humanDelay` calls, and do not use `networkidle`.

## Platform Inventory and Current Readiness

| Platform | Type | Sheet source | Artifact/content | Batch entry point | Cron status | Confidence/readiness |
|---|---|---|---|---|---|---|
| Pearltrees | SBM | Social Media | Title + target URL | `runPearltreesBatch.ts` | 3/day | Implemented and scheduled; verify live selectors |
| Instapaper | SBM | Social Media | Title + URL + generated/stored note | `runInstapaperBatch.ts` | 3/day | Implemented and scheduled; verify live selectors |
| Raindrop | SBM | Social Media | Title + URL + generated/stored note | `runRaindropBatch.ts` | 3/day | Implemented and scheduled; verify live selectors |
| Tumblr | social/SBM-adjacent | Social Media | Generated/stored Tumblr link caption | `src/index.ts run-tumblr-batch` | 2/day | Implemented and scheduled |
| Hatena | SBM | Social Media | Title + target URL | `runHatenaBatch.ts` | Not scheduled | Manual batch exists |
| PDFHost | PDF hosting | New Logic | PDF generated from `blogContent` | `runPdfhostBatch.ts` | 3/day | Implemented and scheduled; confirm current site behavior |
| FlipHTML5 | PDF/flipbook | New Logic | PDF generated from `blogContent` | `runFliphtml5Batch.ts` | Not scheduled | Manual batch exists |
| 4shared | file/PDF sharing | New Logic | PDF generated from `blogContent` | `runFourSharedBatch.ts` | Not scheduled | Manual batch exists |
| Scribd | document sharing | New Logic | PDF generated from `blogContent` | `runScribdBatch.ts` | Not scheduled | Manual batch exists |
| Yumpu | PDF/flipbook | New Logic | PDF generated from `blogContent` | `runYumpuBatch.ts` | Not scheduled | Manual batch exists; poster contains a locator TODO |
| Issuu | PDF publishing | New Logic | PDF generated from `blogContent` | `runIssuuBatch.ts` | Not scheduled | Manual batch exists |
| Speaker Deck | PDF presentation | Retry-row flow only | PDF generated from `blogContent` | `src/index.ts row <n> speakerdeck` | Not scheduled | Login/poster and sheet functions exist; no normal batch runner |
| SlideShare | PPT/PDF presentation | Blog row/manual | Generated PPTX or existing `PDF File Path` | `runSlideshareRow.ts` | Not scheduled | Partial/broken integration; see gaps below |

“Implemented” means the code path exists. It does not prove that current third-party UI selectors, account sessions, CAPTCHA handling, or publication visibility work today.

## End-to-End Architecture

```text
Google Sheet row
  -> sheets.ts selects rows whose platform status is empty
  -> masterCoordinator.ts runs a sequential batch (maximum 15 rows)
  -> optional content/artifact generation
       SBM note: contentAgentNew.ts -> generateBookmarkNote()
       Tumblr: contentAgentNew.ts -> generateTumblrPost()
       PDF: contentConverter.ts -> htmlToPdf()
       PPTX: contentAgentNew.ts -> generateSlideShareContent()
             pptGenerator.ts -> generatePptx()
  -> browser/<platform>/login.ts opens .sessions/<platform>/<nickname>
  -> browser/<platform>/poster.ts publishes using the same Playwright page
  -> sheets.ts writes URL, status, error, batch, and last-posted date
  -> errorInterceptor.ts records failures; autoFix.ts receives recoverable errors
```

Rows are processed sequentially. Account selection normally comes from `row.name`, which must match a nickname in the platform account JSON. Most standard batches request up to 15 pending rows.

## Shared Data Rules

### Account files

Each platform reads `.accounts/accounts-<platform>.json`. Examples:

- `.accounts/accounts-pearltrees.json`
- `.accounts/accounts-pdfhost.json`
- `.accounts/accounts-slideshare.json`

Typical record shape:

```json
{
  "nickname": "account nickname matching the sheet Name column",
  "email": "account@example.com",
  "password": "secret",
  "active": true,
  "sessionDir": ".sessions/platform/nickname"
}
```

Transfer account files and `.env` only through an approved encrypted secret-transfer channel. Do not commit them. Prefer recreating sessions on the new laptop because Chrome persistent profiles can contain sensitive cookies and may not be portable across machines/Chrome versions.

### Browser sessions

- Root: `.sessions/<platform>/<safe-nickname>`
- Runtime: `chromium.launchPersistentContext(...)`
- Browser: installed Google Chrome, default path `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Override: `CHROME_PATH`
- Headless behavior varies slightly by platform; several use `HEADLESS !== 'false'`
- Before launch, `killChromeForProfile(sessionDir)` prevents profile locks
- Login modules hold one module-level context/page and expose a matching close function

### Sheet columns

Each integration depends on exact platform columns such as:

- `<Platform> Post URL`
- `<Platform> Status`
- `<Platform> Error`
- `<platform>Batch` or `<Platform> Batch`
- `Last Posted <Platform>`

Instapaper and Raindrop also use `<Platform> Note`. PDF platforms reuse `PDF Path`. Selection is status-driven: an empty platform status is considered pending. Confirm headers in `src/sheets/sheets.ts` before editing the Google Sheet.

### UTM behavior

Platform UTM suffixes live in `src/utils/utm.ts`. Posters or content generators attach the matching suffix. Do not append a second UTM string if the input URL already contains tracking parameters without checking the current helper behavior.

## Platform Logic

### Pearltrees

`runPearltreesBatch()` reads up to 15 pending Social Media rows, logs into the account named by `row.name`, and posts `row.title` plus `row.targetUrl`. It saves URL/status/error/batch metadata. Browser files are `src/browser/pearltrees/login.ts` and `poster.ts`.

### Instapaper and Raindrop

Both use the same coordinator pattern. If the sheet note is empty, `generateBookmarkNote()` creates it from target URL, title, and market value. The poster saves the bookmark URL and note. Generated notes are written back only as part of result saving; a generation failure skips the row.

### Tumblr

Tumblr generates a link-post caption when the sheet has no caption, removes hashtags, logs in through the browser-tool dispatcher, posts a Tumblr Link block, and writes the result. It is the only platform in this group with a direct `src/index.ts` mode: `npm run dev -- run-tumblr-batch`.

### Hatena

Hatena constructs the bookmark entry-panel URL using the tracked target URL and title, submits it, and returns the public Hatena entry URL. It has a manual batch wrapper but no cron entry.

### PDFHost, FlipHTML5, 4shared, Scribd, Yumpu, and Issuu

These share the main PDF pipeline:

1. Select a pending New Logic row.
2. Require `row.blogContent`; rows without it are skipped.
3. Use `row.pdfPath` if present.
4. Otherwise call `htmlToPdf(blogContent, makeSlug(title), rowIndex)` and save the path with `savePdfPath(..., 'newLogic')` where implemented.
5. Open the platform's persistent session.
6. Upload and publish the PDF with platform-specific metadata.
7. Save result columns and close the platform browser in `finally`.

PDFHost is currently the only one of this subgroup connected to cron. Yumpu's poster explicitly documents an unresolved locator-validation TODO.

### Speaker Deck

Speaker Deck has login/poster code and sheet read/write functions, but no exported normal batch in the coordinator. It is currently reachable through `runRetryRow(..., 'speakerdeck')`, exposed by the index row-mode flow. It generates/reuses a PDF and uploads it. Build a standard batch wrapper and schedule only after a successful one-row test.

### SlideShare

There are two intended flows:

- `slideshareBatchAgentNew.ts`: select up to 15 active accounts and supplied rows, generate structured slide content, build a PPTX, upload sequentially, close the browser, and delete the temporary PPTX.
- `runSlideshareRow.ts`: manually upload an existing file from the row's `PDF File Path`.

The generated PPTX flow uses `generateSlideShareContent()` and `generatePptx()`. It is not connected to the scheduler or master coordinator.

Current compile blockers in the manual row tool:

- It imports `saveUnifiedSlideshareResult`, which is not exported by `sheets.ts`.
- It imports `getSlideshareAccountByNickname` and `getActiveSlideshareAccount`, but the actual exports capitalize “SlideShare”: `getSlideShareAccountByNickname` and `getActiveSlideShareAccount`.

Fix these before treating SlideShare as runnable, then add sheet columns/selection, a coordinator batch, a wrapper command, and finally a cron slot.

## Current Cron Schedule (IST)

Only these new-platform jobs are present in `src/scheduler-new.ts`:

| Time | Job |
|---|---|
| 10:35 | Pearltrees 1/3 |
| 11:05 | PDFHost 1/3 |
| 11:35 | Instapaper 1/3 |
| 12:05 | Raindrop 1/3 |
| 12:35 | Tumblr 1/2 |
| 13:05 | Pearltrees 2/3 |
| 13:35 | PDFHost 2/3 |
| 14:05 | Instapaper 2/3 |
| 14:35 | Raindrop 2/3 |
| 15:05 | Tumblr 2/2 |
| 15:35 | Pearltrees 3/3 |
| 16:05 | PDFHost 3/3 |
| 16:35 | Instapaper 3/3 |
| 17:05 | Raindrop 3/3 |

The `:05`/`:35` offsets avoid the established `:00`/`:15`/`:30`/`:45` jobs. Do not schedule the remaining platforms until each passes the staged acceptance process below.

## Manual Commands

Install and type-check:

```powershell
npm ci
npx tsc --noEmit
```

Run one batch (optional final argument is batch number):

```powershell
npx tsx src/tools/runPearltreesBatch.ts 1
npx tsx src/tools/runInstapaperBatch.ts 1
npx tsx src/tools/runRaindropBatch.ts 1
npx tsx src/tools/runPdfhostBatch.ts 1
npx tsx src/tools/runFliphtml5Batch.ts 1
npx tsx src/tools/runFourSharedBatch.ts 1
npx tsx src/tools/runHatenaBatch.ts 1
npx tsx src/tools/runScribdBatch.ts 1
npx tsx src/tools/runYumpuBatch.ts 1
npx tsx src/tools/runIssuuBatch.ts 1
npm run dev -- run-tumblr-batch
```

Manual SlideShare row (currently blocked until the compile issues above are fixed):

```powershell
npx tsx src/tools/runSlideshareRow.ts <rowIndex>
```

Start the scheduler only after manual smoke tests:

```powershell
npm run schedule
```

## Laptop-to-Laptop Transfer Plan

### Phase 1: Freeze and inventory

1. Record the source commit hash and `git status --short`.
2. Resolve or intentionally package all untracked platform files. Many of these integrations are currently untracked; cloning only committed Git history will omit them.
3. Make a manifest of `.env`, account JSONs, Google credentials, and session directories without placing secret values in documentation.
4. Export the exact Google Sheet headers and identify which tab supplies Social Media versus New Logic rows.

Acceptance: the receiving agent can name every required tracked file, untracked file, secret, account file, and external dependency.

### Phase 2: Transfer code and dependencies

1. Transfer through a private Git branch/commit or an encrypted archive.
2. Exclude `node_modules`, generated PDFs/PPTX files, logs, screenshots, and debug output unless needed as evidence.
3. On the new laptop, install Node.js compatible with this project, Google Chrome, and dependencies using `npm ci`.
4. Configure `CHROME_PATH` if Chrome is not installed at the default Windows path.

Acceptance: `npm ci` succeeds and source files match the source manifest/hash.

### Phase 3: Transfer configuration safely

1. Transfer `.env`, Google service-account/OAuth material, and `.accounts/accounts-*.json` using an approved secret manager or encrypted channel.
2. Confirm every `row.name` has a matching active platform nickname.
3. Do not commit credentials or cookies.
4. Prefer fresh manual logins on the new laptop; copy `.sessions` only when policy permits and fresh login is impossible.

Acceptance: the receiving agent can load account lists without printing passwords and can access the sheet read-only.

### Phase 4: Establish a clean baseline

1. Run `npx tsc --noEmit` and save the complete baseline output.
2. The repository currently has pre-existing TypeScript failures outside this platform group, plus the SlideShare failures listed above. Do not claim a clean build until they are resolved.
3. Confirm PDF generation locally with a non-production row/content sample.
4. Confirm no production scheduler is running during validation.

Acceptance: baseline failures are documented and no new errors are introduced by subsequent fixes.

### Phase 5: Recreate sessions

For each platform, set `HEADLESS=false`, start with one account, and use the platform login module with the persistent session directory. Complete CAPTCHA/2FA manually. Close and reopen the session to prove persistence before attempting a post.

Recommended order:

1. Pearltrees, Instapaper, Raindrop, Hatena
2. Tumblr
3. PDFHost, FlipHTML5, 4shared
4. Issuu, Scribd, Yumpu, Speaker Deck
5. SlideShare after its integration gaps are fixed

Acceptance: reopening the profile reaches an authenticated page without typing credentials again.

### Phase 6: One-row smoke tests

1. Use a dedicated test row and one account per platform.
2. Disable or do not start cron.
3. Verify the public result in a separate logged-out browser, not merely inside the owner session.
4. Verify sheet URL/status/error/batch/last-posted columns.
5. Verify UTM parameters and linked target URL.
6. Confirm generated PDFs/PPTX files are valid and temporary files are cleaned appropriately.

Acceptance: one externally visible post and correct sheet write-back per platform.

### Phase 7: Batch validation

1. Run a 2–3 account controlled batch.
2. Confirm account-to-row mapping through `row.name`.
3. Confirm sequential browser cleanup and no profile-lock errors.
4. Exercise one deliberate failure and verify `Failed`/error output without corrupting other rows.
5. Expand to the intended 15-account batch only after the small batch passes.

Acceptance: successful rows are not reposted, failed rows are diagnosable, and all browser contexts close.

### Phase 8: Production scheduling

1. Enable only the five existing scheduled platforms first.
2. Run `npm run dev` as required by project supervisor rules and inspect startup output/schedule lines.
3. Monitor one full posting window in IST.
4. Add unscheduled platforms one at a time, choosing non-colliding time slots and updating both cron calls and printed schedule documentation.
5. Log every fix and root cause in `docs/FIX_LOG.md` or `logs/fixes.md` according to the project's current convention.

Acceptance: a complete window runs without overlapping persistent profiles, duplicate row selection, or incorrect sheet writes.

## Receiving Agent Prompt

Give the following instruction to the Claude Code agent after transferring the repository:

> You are taking ownership of the Ken Research SBM and PPT/PDF posting integrations. First read `AGENTS.md` and `docs/SBM_PPT_PDF_AGENT_HANDOFF.md`, then inspect the exact source files named there. Do not change code before reading the relevant files. Build an evidence-based readiness matrix and verify the source commit/untracked-file manifest. Never expose `.env`, account passwords, Google credentials, or session cookies. Use plain Playwright persistent Chrome profiles for login, one platform browser context at a time; never use Stagehand for login. Start with TypeScript baseline diagnostics, then fresh-session validation, one-row smoke tests, small batches, and only then cron. Treat only Pearltrees, PDFHost, Instapaper, Raindrop, and Tumblr as currently scheduled. Treat SlideShare as incomplete until its sheet saver and export-name errors are fixed. After every bug fix run `npm run dev`, inspect output, and log the cause and fix. Stop after three attempts on the same error and change approach.

## Known Risks and Gaps

- High confidence: cloning the repository as-is may omit many platform files because they are currently untracked.
- High confidence: only Pearltrees, PDFHost, Instapaper, Raindrop, and Tumblr are scheduled.
- High confidence: SlideShare's manual row tool does not compile due to missing/mismatched exports.
- High confidence: the repository-wide TypeScript check currently fails in several unrelated modules; preserve the baseline.
- High confidence: Yumpu's poster has an explicit unresolved locator TODO.
- Medium confidence: third-party selectors and authentication checks may have drifted since last live validation.
- Medium confidence: copied Chrome profiles may fail because of OS encryption, Chrome version differences, policy, or platform security challenges.
- Medium confidence: a returned URL is not sufficient proof of public publication; verify logged out.

## Definition of Complete Handoff

The handoff is complete only when the receiving agent can:

1. Explain sheet selection, account mapping, content/PDF/PPT generation, login, posting, result saving, and error handling.
2. Recreate at least one persistent session without assistance.
3. Run one safe test row for each intended production platform.
4. Distinguish scheduled, manual-only, retry-only, and incomplete integrations.
5. Start the scheduler and explain every new-platform cron entry.
6. Diagnose failures without exposing secrets or opening conflicting browser profiles.
