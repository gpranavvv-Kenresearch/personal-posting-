# Authentication and Execution Architecture

Status: **living document.** Created during Milestone 0 (safety harness).
Last verified: 2026-11-13.

This document records how this repository authenticates to external services
and how it is executed. It is kept separate from the distribution-intelligence
design work so that facts about the running system are not mixed with proposals
about future systems.

Everything below was verified against the source on 2026-11-13. Where
something could not be verified, it is recorded as UNKNOWN rather than
inferred.

---

## 1. Production execution location — ANSWERED (2026-11-18), with an open risk

**Pranav confirmed, 2026-11-18:** the daemon runs on **Pranav's own Windows
laptop**, from a **git checkout with no auto-pull**. Account sessions and
credentials live in **OneDrive**; code backup is **GitHub, but stale**.

What was checked on this machine (`c:\Users\Abhinav\personal-posting-`) on
2026-11-13, for contrast — this machine is a development clone, not
production:

| Check | Result |
|---|---|
| `node_modules/` present before Milestone 0 | No — the checkout could not run at all |
| `.env` present | No |
| `.accounts/` present | No |
| `.sessions/` present | No |
| Scheduler daemon process running | None found |
| Windows scheduled task for the daemon | None found |
| Other copies of `scheduler-new.ts` on this disk | None |

**What this means for deployment:**

- **Merging PR #1 does NOT make it live.** No auto-pull means Pranav must
  manually `git pull` (or merge locally) on his laptop and restart the
  daemon process himself, every time.
- **Single point of failure, not yet a verified one.** Everything — the
  live daemon, its sessions, its credentials — is on one person's laptop.
  Two separate backup gaps, **neither fixed by the other**:
  1. **Code** (this repository) is backed up to GitHub, but that mirror is
     **stale** — Pranav's laptop has commits/state GitHub doesn't.
  2. **Sessions and credentials** (`.accounts/`, `.sessions/`) are backed up
     to OneDrive — but that backup has **never been tested as a restore**
     (no one has proven that wiping the laptop and restoring from OneDrive
     actually brings the daemon back up with working logins).

  **These two must stay separate.** Sessions/credentials are sensitive and
  must never go to GitHub (or anywhere else shared/public) — this repo's
  `.gitignore` already blocks `.accounts/`, `.sessions/`, and `.env` from
  ever being committed, on purpose. OneDrive (private, already restricted to
  the account that needs it) is the right place for that data; GitHub is
  only ever the right place for code.

**Recommended next step (not yet done), two separate actions:**
1. **Code:** push Pranav's laptop's code state to GitHub so that mirror
   stops being stale — ordinary `git push`, nothing sensitive in it.
2. **Credentials/sessions:** a *local* restore drill, with nothing leaving
   OneDrive/the laptop — e.g. copy the OneDrive `.accounts/`/`.sessions/`
   folders to a fresh temp directory (or a second machine, if one exists)
   and confirm the daemon can actually log in and run from that copy. This
   proves the backup works without ever uploading credentials anywhere.

Until both happen, this project has no proven disaster recovery.

---

## 2. Hermes is not part of this repository

**There is no Hermes code, configuration, credential, or reference in this
repository.** The name appears in no source file, dependency, environment
variable, or committed configuration.

Whatever Hermes is in the wider Ken Research context, it is **out of scope for
this codebase** and must not be assumed to provide authentication, scheduling,
orchestration, or any other service to it. If Hermes does interact with this
system, that interaction happens outside this repository and needs to be
documented by whoever owns it.

---

## 3. Authentication surfaces

### 3.1 Google Sheets — service account

- Library: `googleapis`.
- Scope: `https://www.googleapis.com/auth/spreadsheets` (read **and** write).
- Credential resolution order, in `src/sheets/sheets.ts`:
  1. `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable (the full JSON as a string)
  2. `.accounts/google-service-account.json` on disk
- The same credential is used by the `ai-employee` sub-project
  (`ai-employee/lib/google-sheet.mjs`), which resolves it identically.
- `.accounts/` is gitignored and has never been committed.

Two distinct production spreadsheets exist. Since Milestone 0 both resolve
through `src/config/sheetIds.ts`:

| Constant | Env override | Used by |
|---|---|---|
| `MAIN_SHEET_ID` | `MAIN_SHEET_ID` | `sheets.ts` (7 tabs), `tracker.ts`, 12 tools |
| `DISTRIBUTED_URL_SHEET_ID` | `DISTRIBUTED_URL_SHEET_ID` | `reportDiscovery/distributedUrlPool.ts` |

### 3.2 Browser platforms — persistent Chrome profiles

Posting platforms are **not** authenticated by API key. Each uses a persistent
Chrome profile under `.sessions/`, launched with
`chromium.launchPersistentContext({ channel: 'chrome' })`. The session cookie
in that profile *is* the credential. Consequences:

- Sessions expire and must be re-established by an interactive login.
- A profile directory is as sensitive as a password.
- `.sessions/` is gitignored and has never been committed.
- Profiles are deliberately **excluded** from Milestone 0 backups: they are
  large, binary, and rebuildable by logging in again.

### 3.3 LLM and search providers — rotating key pools

Credentials come from environment variables only; none are committed.

| Provider | Variables | Role |
|---|---|---|
| Groq | key pool | Tier 1 text generation |
| OpenRouter | `OPENROUTER_API_KEY_1..15` | Tier 2 fallback |
| NVIDIA NIM | `NVIDIA_API_KEY_1..4` | Tier 3 fallback |
| SerpAPI / Zenserp / Serpstack | `SERPAPI_KEY_*`, `ZENSERP_API_KEY_*`, `SERPSTACK_API_KEY_*` | SERP lookups |
| Tavily | `TAVILY_API_KEY_1..10` | Web search |
| Anthropic | `ANTHROPIC_API_KEY` | Claude API |

Keys rotate round-robin with automatic failover on rate limit.

### 3.4 Platform API tokens

HackMD is the notable exception to browser automation: it has a real REST
client (`src/browser/hackmd/apiPoster.ts`) using `Authorization: Bearer`, with
`GET`/`POST`/`PATCH`/`DELETE`. This makes it the lowest-risk candidate for any
future feature that needs to **edit** already-published content.

---

## 4. Execution architecture

### 4.1 Runtime

TypeScript executed directly by `tsx` under Node.js. **There is no build
step** — no `dist/` is produced for normal operation, and `npx tsc --noEmit`
is a type check only. Node v24.15.0 on this machine.

### 4.2 Scheduler

`src/scheduler-new.ts` is the single source of truth for what runs when.

- `node-cron`, timezone `Asia/Kolkata`.
- `DAILY_SLOTS` (lines 83–146) defines **61 slots** across **24 posting
  platforms**, roughly 10:20–18:20 IST.
- Collision-avoidance grid by minute: `:00/:15/:30/:45` social;
  `:05/:35` social-bookmarking and PDF; `:10/:20/:25/:40/:50` blogs.
- Additional jobs: RSS discovery every 30 min (10:00–18:00), nightly RSS feed
  at 18:30, weekly SERP recheck Sat 22:00, Sunday examination Sun 10:00,
  midnight counter reset.

> The platform tables in `CLAUDE.md`, `README.md` and other docs do **not**
> match `scheduler-new.ts`. Trust the scheduler.

### 4.3 Supervision and recovery

- `src/supervisor.ts` — watchdog that restarts a frozen daemon, driven by a
  heartbeat file. Started via `npm run dev:supervised`.
- `src/batchLedger.ts` — per-slot ledger in `.sessions/slot-ledger.json`,
  heartbeat in `.sessions/heartbeat.json` (20 s), missed-slot catch-up sweep
  every 60 s.
- `src/errorInterceptor.ts` — error knowledge base; entries graduate to
  `auto_trusted` after 3 successful fixes.
- `src/autoFix.ts` — session clear, browser restart, key rotation.
- `src/monitor.ts` — **not scheduled.** Reachable only via the `monitor` CLI
  mode. Its `diagnoseError()` returns a fixed string; it performs no real
  diagnosis.

### 4.4 Runtime state

All runtime state resolves relative to the process working directory, via
three idioms: `path.resolve('.sessions/...')`, `path.resolve('logs/...')`,
and `path.join(process.cwd(), '.accounts')`.

| Path | Contents |
|---|---|
| `.sessions/*.json` | slot ledger, heartbeat, batch counters, seen-store, RSS poll state, tweet history, key rotation |
| `.sessions/<platform>/` | Chrome persistent profiles (credentials) |
| `logs/` | `runtime.log`, `error-kb.json`, `.monitor-state.json` |
| `.accounts/` | account credentials and the Google service-account key |
| `data/` | reserved for Milestone 3; **nothing uses it yet** |

Because all three idioms are cwd-relative, launching with a different working
directory redirects every one of them at once. Milestone 0 uses exactly this
property for development isolation (`src/tools/devRun.mjs`) rather than editing
~200 individual path references.

### 4.5 Environment selection (added in Milestone 0)

`KEN_ENV` is strictly validated — only `development` and `production` are
accepted, and anything else throws at startup rather than being coerced.
Unset behaves as `production`, so existing production behaviour is unchanged.

In `development`, both spreadsheet IDs are mandatory and must not be
production IDs; the process refuses to start otherwise. **There is no silent
fallback to production.**

---

## 5. What Milestone 0 deliberately did not change

- The scheduler and its slot table.
- Any posting, content-generation or browser code path.
- Any production credential, spreadsheet or runtime state.
- The four legacy scripts in `tests/` (left in place, never executed).
- Any unused or legacy agent (none deleted, moved or quarantined).
