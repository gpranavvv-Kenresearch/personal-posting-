# Handover — Distribution Intelligence Layer

Branch: `abhinav/distribution-intelligence` · PR: #1 on this repo (`personal-posting-`)

## What this is, in one line

A new, optional layer that watches what happens *after* a post goes live —
indexed or not, traffic or not, leads or not — and uses that to recommend
(never auto-execute) which platform a report should go to and which internal
links are worth adding. It does not touch posting, scheduling, or content
generation.

## The two repos, confirmed

- **`personal-posting-`** (this repo) — schedules and posts content across
  12 platforms / 45+ accounts, and now also measures the outcome. This PR
  lives entirely here.
- **`hermes-content-engine`** — writes the FB/LI text itself: evidence
  checking, claim traceability, banned-phrase and em-dash linting, a content
  "readiness" score. It does not post. Per its own README: *"It does not
  contain social posting code."*

These were never meant to merge into one system, and this PR keeps that
split. Nothing here asks Hermes to change what or how it writes.

---

## What's new on this branch (14 commits)

1. **Safety harness** — everything below is off unless a specific
   `FEATURE_*` flag is set in `.env`. A master switch (`FEATURE_INTELLIGENCE`)
   gates all of them. `FEATURE_SHADOW_MODE` is **on by default**: every
   number is computed and recorded, nothing is ever acted on until that's
   turned off deliberately.
2. **Tab lock** — a sandboxed test run can only read/write tabs it created
   itself (`Test_*`); it is physically refused from touching any live tab,
   not just warned.
3. **Measurement collectors** — Search Console, GA4, Pipedrive, and
   SERP-based indexation checking. Each is independent; any subset can be on.
4. **A no-credentials path for GA4/GSC** — GA4 and Search Console access
   stays with Abhinav only, by his explicit decision; it is not granted to
   the service account or to anyone else. So there's now a second way in:
   `npm run intel import-performance` reads a CSV he exports himself from the
   GA4/GSC website and writes it to the same table the API collectors would
   use. Nothing downstream can tell the difference. (We also specifically
   checked whether a browser bot could get around the GSC quota instead —
   it can't; Google enforces the same limit on the website as on the API,
   so that path would add risk for zero benefit. Manual export is simply
   the correct answer here, not a workaround.)
5. **Opportunity scoring** — ranks reports by real outcomes, always states
   what % of the score is backed by real data ("coverage"), and excludes
   (never zeroes) any signal with no data.
6. **Platform intelligence, two layers:**
   - *Aggregate:* "which platforms actually work" — indexation rate,
     sessions/post, leads, across all platforms.
   - *Per-report (new, just finished):* "which platform should THIS report
     go to" — uses that report's own direct results first if it has any,
     falls back to a platform's general track record only once it has
     enough history to trust, and otherwise honestly says "insufficient
     data" rather than guessing.
7. **Content correlation analysis** — which content traits (length,
   structure, etc.) correlate with results. Labelled as observational, not
   causal, everywhere it's surfaced.
8. **Interlinking proposals** — suggests internal links between reports.
   A suggestion can never auto-apply: a human must approve it, `apply` is a
   dry run unless `--apply` is explicitly added, and it only touches the two
   platforms we've actually verified are safely editable (HackMD, Mataroa).
   Every applied link is tagged with its own UTM and re-checked afterwards.
9. **Fixes found along the way, independent of any new feature** — a 21x
   under-count in how much of the sheet got read in, a platform-name
   matching bug, and a sheet-export convenience command.
10. **Docs** — an operator runbook (`docs/INTELLIGENCE-RUNBOOK.md`), an
    access-required doc listing exactly what each credential unlocks and who
    to ask (`docs/ACCESS-REQUIRED.md`), and this handover.

---

## What touches your side, specifically

**UTM conventions — already consistent, no action needed.** This branch
tags every link `utm_source=<platform>&utm_medium=referral&utm_campaign=automation`.
Checked your `src/config/utm.config.ts` against this repo's platform list —
every source matches already (`hackmd`, `linkedin-pulse`, `googlesites`,
etc. all line up). Nothing to change.

**Content quality system — already the right shape, no action needed.**
Your `styles/KenResearch/BannedPhrases.yml`, `EmDash.yml`, and the
readiness-score system in `docs/metrics.md` are exactly the "humanizing /
editorial tone" layer that's out of scope here. That work is yours and it's
already built; this branch doesn't duplicate or touch it.

**One thing worth fixing on your side, low priority, not blocking:**
`browser-generation/src/sheets/sheets.ts` defines seven separate constants
(`SOCIAL_SHEET_ID`, `BLOG_SHEET_ID`, `ALGO_SHEET_ID`, `CONTENT_POOL_SHEET_ID`,
`NEW_LOGIC_SHEET_ID`, `RSS_EXTRACTION_SHEET_ID`,
`NEWSLETTER_CAMPAIGN_SHEET_ID`) that are all hardcoded to the *same* literal
spreadsheet ID string. Harmless today since everything is one sheet, but if
that sheet ever splits, each one needs updating by hand and it's easy to
miss one. Worth collapsing to a single constant or env var when convenient —
not urgent, not related to this PR.

**One thing worth checking in the posting-agent repo itself (this repo, not
Hermes):** the "Blogs" sheet tab was renamed to "New Logic" during this
work, and `src/sheets/sheets.ts` plus a few `src/tools/*` files here still
reference the old tab/pool names. This branch deliberately didn't touch
them (they're live posting code, outside this PR's scope) but they should
be checked before anyone relies on those tabs matching by name.

**Two older bugs, already fixed in this branch, worth knowing about:**
1. `ai-employee/observer.config.example.json` used to ship the *live*
   spreadsheet ID as its example — anyone following the setup docs would
   point the observer at production. Fixed to a placeholder, and the code
   now refuses to run with one.
2. `.gitignore` had `scripts/` without a leading slash, which also matched
   `src/scripts/` — any file added there would silently never get committed.
   Fixed.

---

## Action items for you

1. **Review and merge PR #1.** Nothing in it changes live behaviour by
   itself — every feature is off by default — so merging is low-risk.
2. **Tell Abhinav which machine actually runs the live posting daemon**, and
   whether it's a git checkout that pulls updates or a manually copied
   folder. This is still unknown and blocks deploying any of this for real.
3. **Nothing needed from you on GA4/GSC/Pipedrive access** — that's
   Abhinav's own decision to make per-credential (see
   `docs/ACCESS-REQUIRED.md` for exactly who administers each one and what
   it unlocks, if you want the full picture).
4. Optional, whenever convenient: collapse the duplicate sheet-ID constants
   mentioned above.

## Try it safely before merging

```bash
npm run dev:sandbox -- src/intelligence/cli.ts status
```

Forces a separate database and confines every read/write to `Test_*` tabs —
the live sheet cannot be touched by this command even by accident.

## Further reading

- `docs/INTELLIGENCE-RUNBOOK.md` — full operator guide, commands, rollback
- `docs/ACCESS-REQUIRED.md` — credentials, who to ask, what each unlocks
