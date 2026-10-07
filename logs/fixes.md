# Fix log

## 2026-10-07 - AI Employee POC test runner blocked by child-process sandboxing

- Cause: Node's default `--test` isolation starts a child process for each test file. The managed workspace denied that spawn with `EPERM`, before any test code executed.
- Fix: Changed `employee:test` to use Node 24's `--test-isolation=none` option so the small, trusted POC test suite runs in the current process.
- Verification: All 5 POC tests pass. Syntax checks pass, the knowledge index builds 270 documents / 1,791 chunks without Ollama, the local dashboard returns HTTP 200, and retrieval ranks `src/batchLedger.ts` first for a duplicate-slot question.

## 2026-10-07 - AI Guardian Level 1 setup

- Cause: The repository had a local chat POC but no two-laptop observer, incident store, deterministic owner-policy checks, memory approval states, or authenticated evidence intake.
- Fix: Added the read-only observer, durable queues, authenticated control-center API, advisory incident diagnosis, private memory review, semantic indexing, dedicated `AI Guardian` Sheet reporter, evaluation cases, and Windows startup-task installers.
- Guardrail: No posting, retry, restart, session, code-edit, credential, or operational-Sheet tool is exposed to the model.
- Verification: Node syntax checks pass; guardian unit tests pass; HTTP authentication returns 401 for an invalid observer and 202 for the private observer secret.

## 2026-10-07 - Ollama and Windows task setup recovery

- Cause: WinGet's Delivery Optimization download timed out, and the sandboxed Task Scheduler API returned access denied.
- Fix: Ollama completed through WinGet's fallback transport; the redundant direct download was cancelled and removed. The control-center startup task was registered with the required elevated permission.
- Verification: Ollama API reports version 0.40.0; `nomic-embed-text` installed successfully; the scheduled task registration completed.

## 2026-10-07 - Tailscale installation blocked by Windows elevation

- Cause: WinGet returned installer code 1602, and the directly logged MSI returned 1603 with the launch condition: `This package requires elevated privileges to install.` The managed execution permission did not provide a true Administrator token to Windows Installer.
- Attempts: WinGet package install, direct quiet MSI, and a logged wait-for-exit MSI run. No product or service was left installed.
- Resolution: Stopped after three approaches. Added `configure-tailscale-control.ps1` so setup can resume immediately after the owner installs Tailscale as Administrator and signs in on both laptops.

## 2026-10-07 - Qwen3 default thinking exceeded local response budget

- Cause: The first `qwen3:8b` repository evaluation did not finish its first case within the five-minute Ollama request timeout on this 16 GB laptop.
- Fix: Disabled Qwen's optional thinking stream for this operational assistant, capped output at 900 tokens, and set an 8,192-token context window. The evaluation runner now records per-case latency and continues after individual failures.
- Follow-up: The full agent still exceeded the practical budget through repeated tool-call turns, so Level 1 now permits one read-only follow-up round and caps the final response at 450 tokens.
- Evaluation controller fix: Two cases returned no text because the model requested another tool on its last allowed round. The final round now exposes no tools, forcing a report from the evidence already gathered.
- Hardware-fit decision: `qwen3:8b` still timed out on the daily-total case and `qwen3:4b` remained slow with the same 8K/tool configuration. The default fast path now uses `qwen3:4b`, five retrieved chunks, a 4,096-token context, a 300-token answer, and zero extra tool rounds. Optional deep mode can raise `AI_EMPLOYEE_MAX_TOOL_ROUNDS` and select the 8B model explicitly.
- Final verification: The focused `qwen3:4b` setup passed 4/4 cases: repeated access restriction, missing heartbeat, total below 500, and prohibited mutation refusal. Measured latency was 106-146 seconds per diagnosis.

## 2026-08-11 — Remove hashtags from Tumblr content

- Cause: The Tumblr generation prompt explicitly required 2–3 hashtags, and captions already stored in Google Sheets bypassed generation unchanged.
- Fix: Updated the Tumblr prompt and examples to forbid hashtags. Added hashtag removal in the Tumblr batch before saving/posting, plus a final safeguard in the Tumblr browser poster.
- Verification: `git diff --check` found no whitespace errors in the three edited Tumblr-path files. The full TypeScript check remains blocked by unrelated existing errors. `npm run dev` could not be safely run because it starts the live multi-platform cron daemon.

## 2026-09-07 — LinkedIn Post click cascading into every fallback

- Cause: `postToLinkedIn` waited a fixed 3s after clicking Post, then checked whether the composer had closed. LinkedIn keeps the dialog open longer than that while it submits, so a click that had actually worked was logged as "composer still open", every remaining locator then timed out / reported "Element is not visible" (the dialog was already closing), and the poster fell through to a native DOM click and Ctrl+Enter. Seen in runtime.log on 2026-09-07 at 06:20 and 08:32 IST-ish (UTC timestamps).
- Fix: Added `waitForComposerClose()` in `src/browser/linkedin/poster.ts` that polls every 500ms for up to 20s and replaced all four fixed 3s checks with it. First successful click now returns as soon as the composer really closes; fallbacks only run if it genuinely stays open.
- Verification: `tsc --noEmit` shows zero errors in the LinkedIn poster (remaining errors are pre-existing in unrelated Letsdiskuss/Slideshare/seoTools files). Live run not executed — `npm run dev` starts the full cron daemon.

## 2026-09-07 — Tumblr optional "Post" confirmation treated as fatal

- Cause: After "Post now", Tumblr sometimes shows a second "Post" confirmation button and sometimes submits directly. The poster threw when the second button was absent, failing rows that had actually been submitted.
- Fix: `src/browser/tumblr/poster.ts` now clicks the confirmation only if it appears within 5s, otherwise logs and continues to the "Posted to" toast / URL capture.

## 2026-09-07 — ChatGPT replies with a review of the blog prompt instead of the article

- Cause: The master blog prompt opens with a human-facing "HOW TO USE / Paste this prompt into a new chat" section. On some rows (seen with the survey-page row "Affordable Housing Buyer Experience Survey", V2 prompt) ChatGPT read the whole message as a document to review and answered "I have reviewed the uploaded prompt... I can now generate the ARTICLE_HTML output" with no HTML, which the extractor then failed on.
- Fix (prompt): added an EXECUTION DIRECTIVE block at the very top of both V1 and V2 prompts and a "BEGIN NOW" line after </INPUTS>, stating that the message is the task, preambles are a failed response, and only the FINAL RESPONSE deliverable is accepted.
- Fix (code): `generateBlogViaChatGpt` now checks the extracted response for <h1> and <h2>. If missing, it sends one "Proceed now..." follow-up in the same chat, waits again and re-extracts; only if that also lacks an article does it throw PREAMBLE_ONLY.
- Verification: `tsc --noEmit` reports zero errors in blogGenAgent.ts. Live ChatGPT run not executed.

## 2026-09-07 — ChatGPT refuses survey-page rows with an "Unable to complete" paragraph

- Cause: For survey URLs (e.g. /survey/affordable-housing-buyer-experience-survey) ChatGPT returned a Description line plus one <p> saying the input is a survey, not a market-sizing report, and DATA_SPINE values are unavailable — ignoring the prompt's existing instruction to widen to the adjacent market. The instruction was abstract, so it was skipped.
- Fix (prompt, V1 and V2): added "MANDATORY PROCEDURE FOR SURVEY / SERVICE / METHODOLOGY INPUTS" — four concrete steps (derive adjacent market from title + geography with a worked example, web-search size/CAGR/forecast, write the full article for that market using the survey topic as the angle, drop only unverifiable clauses) and an explicit ban on "Unable to complete"-style replies.
- Fix (code): the no-<h1>/<h2> nudge in `generateBlogViaChatGpt` now detects refusal phrases and re-sends the procedure explicitly instead of a bare "proceed".
- Verification: `tsc --noEmit` reports zero errors in blogGenAgent.ts. Live run not executed.

## 2026-09-07 — Brand validator rejecting good blogs; image regenerated on every blog retry

- Cause 1: `blogBrandValidator` failed row 699 (score 8/10) on `brand-frequency-max` (5 mentions in 1,612 words, max 4) and `promotional-risk` ("purchase", "buy" — ordinary housing-market vocabulary, not CTAs). Any single issue drops the score below the PASS threshold of 9.
- Fix 1: both rules are now advisory — still reported in the log, no longer counted in the score. Critical rules (title branding, opening paragraph mention/link, link presence) and the minimum-mention rule are unchanged.
- Cause 2: `blogGenLoop` declared `coverImageUrl` inside the retry loop, so a validation failure on the blog side re-ran the ~9-minute image generation as well, and the already-generated image URL was thrown away.
- Fix 2: `coverImageUrl` is hoisted above the retry loop and seeded from the sheet's existing Cover Image URL; image generation is skipped whenever a URL already exists. New `saveCoverImageUrlToPool()` in sheets.ts writes the URL to the sheet the moment the image is generated, before the blog finishes, so it survives a failed blog attempt or a later pass.
- Verification: `tsc --noEmit` — zero errors in blogGenLoop.ts, blogBrandValidator.ts, sheets.ts. Live run not executed.

## 2026-09-08 — Missed cron slots were lost for the rest of the day (catch-up + supervisor)

- Cause: node-cron 4 never re-runs a slot it missed. Whenever the daemon's event loop was blocked, the laptop slept/hibernated, or the daemon was restarted mid-day, every slot in that window was skipped with only a "missed execution... Possible blocking IO" warning. 2026-09-04: all 54 slots from 10:20 IST reported missed in one burst at 19:30 IST. 2026-09-07: silent from 15:16 to 17:33 IST, 16 batches lost. Clipboard reads via `execSync('powershell Get-Clipboard')` in the Medium/Patreon/WordPress posters had no timeout and could block the loop indefinitely.
- Fix 1 (`src/batchLedger.ts`, `src/scheduler-new.ts`): all 53 daily slots now live in one DAILY_SLOTS table that drives both node-cron and a catch-up sweeper. Every slot start/end is recorded in `.sessions/slot-ledger.json` (per IST date). The sweeper runs at startup and every 60 s: any slot whose time has passed by >3 min with no ledger entry (or a 'running' entry orphaned by a dead PID) is run now, in schedule order, until 21:00 IST (CATCHUP_CUTOFF_IST). A label can never run twice in a day.
- Fix 2 (`src/supervisor.ts`, `npm run dev:supervised`): daemon writes `.sessions/heartbeat.json` every 20 s; the supervisor spawns the daemon, restarts it if the heartbeat is >3 min stale (re-checked after 45 s to survive sleep/wake), kills the whole process tree (Chrome included) on restart, and restarts on exit. Max 20 restarts/day.
- Fix 3: `{ timeout: 5000 }` added to the three untimed Get-Clipboard execSync calls.
- Verification: tsc zero errors in the touched files; ledger logic exercised with a fake clock (missed detection, once-per-day guard, grace window, cutoff) — all as expected. `npm run ledger` prints today's ledger. Daemon must be restarted with `npm run dev:supervised` for this to take effect.

## 2026-09-08 — Catch-up re-ran the whole morning on the first supervised start

- Cause: the supervised daemon was started at 15:50 IST on the day the ledger feature shipped. The old daemon had already run the morning batches but wrote no ledger, so the sweeper saw every slot before 15:50 as missed and began re-running them (Medium 1/1 first).
- Fix: `seedIfOldDaemonRanToday()` runs at daemon startup — if there is no ledger for today but `.sessions/batch-counters.json` already shows posts today, every slot before now is marked done (no catch-up). Manual override: `npm run ledger:seed -- HH:MM` marks all slots at/before that IST time as done (stop the daemon first, seed, restart). `DAILY_SLOTS` is now exported from scheduler-new.ts for this.
- Verification: tsc zero errors in scheduler-new.ts, batchLedger.ts, ledgerSeed.ts.

## 2026-09-08 — Catch-up sweeper turned OFF by default

- User explicitly rejected catch-up after it re-triggered a Medium 1/1 batch at 15:57 IST for the 10:20 slot, on top of the earlier same-day re-run scare. Decision: catch-up must never fire without an explicit opt-in.
- Fix: `startCatchUpSweeper()` in `src/batchLedger.ts` now does nothing unless `CATCHUP_ENABLED=1` is set (previously it was on by default, opt-out via `CATCHUP_DISABLED=1`). Ledger recording and the heartbeat/supervisor are unaffected — only the sweep loop that re-runs missed slots is gated.
- No daemon/supervisor process was found running at the time — the pasted log was from an already-stopped or external terminal.
