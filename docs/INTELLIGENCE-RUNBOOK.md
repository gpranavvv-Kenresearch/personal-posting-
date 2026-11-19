# Distribution Intelligence — Operator Runbook

Written for whoever operates this day to day. No TypeScript knowledge needed.

---

## What this adds

The existing automation posts content to 30+ platforms on a fixed schedule. It
has never been able to answer *"is any of this working?"*

This layer collects evidence and answers that. It does **not** change what gets
posted unless you explicitly tell it to.

---

## The one thing to understand first

**Everything is off by default.**

With no settings changed, the intelligence layer does nothing at all: no
database is created, no data is collected, no network call is made, and the
posting automation behaves exactly as it did before. The nightly job fires at
19:30 IST, sees the master switch is off, and returns immediately.

Turning it on is one line. Turning it off again is deleting that line.

---

## Quick start

```bash
npm run intel status
```

Run that first, always. It tells you what is on, what data exists, and — most
usefully — **which credentials are missing and what each one would unlock.**

---

## Switching it on

Add to `.env`:

```
FEATURE_INTELLIGENCE=1
```

That alone still collects nothing: each capability has its own switch. Add the
ones you have credentials for:

```
FEATURE_GA4_COLLECTION=1          # needs GA4_PROPERTY_ID
FEATURE_GSC_COLLECTION=1          # needs GSC_SITE_URL
FEATURE_PIPEDRIVE_COLLECTION=1    # needs PIPEDRIVE_API_TOKEN
FEATURE_INDEXATION_CHECKS=1       # works now — SERP keys already present
FEATURE_PLATFORM_INTELLIGENCE=1   # needs GA4 data to be meaningful
FEATURE_CONTENT_INTELLIGENCE=1
FEATURE_OPPORTUNITY_SCORING=1
FEATURE_INTERLINKING_PROPOSALS=1
```

`FEATURE_SHADOW_MODE` is **on by default** and should stay on until you have
watched the output for a while. In shadow mode everything is computed and
recorded, and nothing is ever acted on.

See `docs/ACCESS-REQUIRED.md` for exactly who to ask for each credential.

---

## Getting GA4/GSC numbers in without handing out your login

Your GA4 and Search Console access stays with you — it is not given to the
service account, to Pranav, or to anyone else. `npm run intel collect` (the
row above) is the automated path and needs that access; if you're not
granting it, use this path instead.

**Why not automate the export with a browser bot (Playwright)?** It wouldn't
actually help. Google enforces the same daily quota on its website that it
enforces on the API — a bot clicking through the GA4/GSC UI runs into the
exact same ceiling, just slower, and it would need your Google login saved
on whichever machine runs it, which is the thing we're avoiding in the first
place. Exporting the CSV yourself, in your own browser, under your own
login, has none of that risk. That's the path below.

### Step 1 — export from GA4

1. Open your GA4 property → **Reports → Engagement → Pages and screens**
   (or **Landing page**, if you want sessions attributed to the first page a
   visitor landed on rather than every page they viewed).
2. Set the date range you want (e.g. "last 7 days").
3. Click the **export icon** (top right of the report) → **Download CSV**.

### Step 2 — export from Search Console

1. Open **Search Console → Performance → Pages** tab (not the default
   Queries tab).
2. Set the date range.
3. Click **Export → CSV**.

### Step 3 — load it into this project

```bash
npm run intel import-performance --file "C:\path\to\export.csv" --source ga4 --date 2026-11-17
npm run intel import-performance --file "C:\path\to\export.csv" --source gsc --date 2026-11-17
```

- `--source` is `ga4` or `gsc` — whichever export this file is.
- `--date` is the date the export represents (today, or the last day of the
  range you picked). GA4/GSC exports give one number per URL for the whole
  range, not one row per day, so this date is a label for the whole file.
  Re-running the same file with the same date updates those rows instead of
  creating duplicates — safe to re-run.
- The file is read once, locally. Nothing is uploaded anywhere, no network
  call is made, no credential is read.

The command tells you which columns it recognised and how many rows it
wrote, e.g.:

```
Matched columns: {"url":"Page path and screen class","sessions":"Sessions"}
Parsed 86 row(s), skipped 2, wrote 84.
```

If it says `No recognisable URL/page column`, you likely exported the wrong
tab (e.g. a Queries report instead of a Pages report) — the file needs one
row per URL.

### What this plugs into

This writes to the exact same table the automated GA4/GSC collectors would
write to. `npm run intel platforms`, `npm run intel score`, and the
interlink proposals all read it identically either way — they cannot tell a
manual export from a live API pull. Repeat the export/import weekly (or
whatever cadence suits you) to keep the numbers current; there's no
automatic refresh on this path since it depends on you running the export.

---

## Sizing the indexation check budget

**The problem:** distribution covers roughly 43,000 URLs in total, with
~13,000–17,000 new posts going out per month. Checking "is this live on
Google" for every one of those costs one SERP provider call per URL. Free-tier
SERP keys do not stretch that far — asking "is everything indexed, always" is
not a software problem, it is a budget problem, and `index-check` is built to
be honest about that rather than pretend otherwise.

**The fix:** `index-check` never tries to check everything in one pass. Each
run spends a fixed daily budget (`--limit`, or env `INDEX_CHECK_DAILY_BUDGET`,
default 100) split two ways:
- **70%** goes to the most recently published posts — so this month's work
  gets checked first.
- **30%** goes to whichever known URLs have gone longest without a check
  (never-checked URLs first) — so the 43k backlog keeps rotating through
  instead of the same unlucky tail never being reached.

Set `INDEX_CHECK_DAILY_BUDGET` to roughly your total free-tier monthly
SERP+Zenserp+Serpstack quota, divided by 30. If that number is small, the
backlog simply rotates more slowly — a URL not checked this week will be
checked a few weeks later, not silently dropped. Nothing here ever guesses a
result to make the numbers look better: a URL outside this run's budget just
doesn't get a fresh answer yet, same as any URL the providers themselves
refuse to answer (reported "unknown", not a fabricated verdict).

---

## Commands

| Command | What it does |
|---|---|
| `npm run intel status` | What is on, what data exists, what is missing |
| `npm run intel migrate` | Create or update the database |
| `npm run intel ingest` | Read the sheet into the local database |
| `npm run intel collect` | Pull GSC / GA4 / Pipedrive data (needs service-account access) |
| `npm run intel import-performance` | Load a GA4/GSC CSV you exported yourself — no credentials needed |
| `npm run intel index-check` | Check whether published posts are in Google |
| `npm run intel platforms` | **Which platforms actually work** |
| `npm run intel content` | Which content characteristics correlate with results |
| `npm run intel score` | Rank reports by opportunity |
| `npm run intel propose` | Suggest internal links |
| `npm run intel queue` | Link suggestions awaiting your approval |
| `npm run intel approve <id>` | Approve one suggestion |
| `npm run intel reject <id>` | Reject one |
| `npm run intel apply` | Apply approved links — **dry run unless you add `--apply`** |
| `npm run intel calibrate` | Check whether the scoring weights are any good |
| `npm run intel report` | Everything in one summary |

Reading commands are safe to run at any time.

---

## The report that matters most

```bash
npm run intel platforms
```

```
PLATFORM       POSTS  INDEX  SESS/POST  LEADS  RECOMMENDATION
-------------  -----  -----  ---------  -----  -----------------
HackMD           240    82%       3.10     12  keep
Medium           198    91%       1.40      3  keep
Telegraph        160     8%       0.02      0  consider-dropping
```

Read it like this:

- **INDEX** — share of posts Google appears to have indexed. A dash means not
  measured. Posts that are not indexed are invisible to search.
- **SESS/POST** — visits per post. The bluntest measure of whether a platform
  sends anyone.
- **LEADS** — attributed leads. The only column that connects to revenue.
- **RECOMMENDATION** — advisory only. **The schedule is never changed
  automatically.** Removing a platform is your decision.

`insufficient-data` means exactly that — not that the platform failed.

---

## Approving internal links

This is the only part that can change something already published, so it is
deliberately slow.

```bash
npm run intel propose     # generate suggestions
npm run intel queue       # read them
npm run intel approve 7   # approve one, by id
npm run intel apply       # DRY RUN — shows what would happen
npm run intel apply --apply   # actually does it
```

Protections, all enforced in code:

1. A suggestion can **never** go straight to applied. Approval is a required
   step in the state machine, not a convention.
2. `apply` is a dry run unless you add `--apply`.
3. Shadow mode blocks all external changes regardless of other settings.
4. Only platforms proven editable are touched — currently **HackMD and
   Mataroa only**. Everything else is refused, including platforms that might
   well be editable but have not been verified.
5. If the page changed since the suggestion was made, the edit is refused and
   the suggestion is regenerated instead.
6. Every applied link is re-checked afterwards, and can be reverted.

---

## Reading a score

Scores are explained, never bare numbers:

```
score 0.412 (coverage 45%, recency x0.80) — driven by historicalLeads=0.70,
searchDemand=0.55; missing: geographic, platformSuitability
```

- **coverage** is how much of the scoring weight was backed by real data.
  A high score at 20% coverage means very little. Treat coverage below ~50%
  as "we are mostly guessing".
- **missing** signals are excluded and the rest re-weighted — a report is never
  punished for data we failed to collect.

**The weights are uncalibrated.** They are reasonable starting guesses, not
findings. Until `npm run intel calibrate` reports a real improvement on a
decent sample, treat every score as a hypothesis.

---

## If something goes wrong

The intelligence layer cannot break posting. It runs after the day's posting
has finished, it never throws into the scheduler, and a failure in one stage is
recorded while the rest continue.

Three independent ways to roll back, in increasing severity:

**1. Configuration** (seconds, no deploy)
```
FEATURE_INTELLIGENCE=0
```
Everything stops. The posting automation is untouched.

**2. Code**
```bash
git revert <commit>
```

**3. Data**
```bash
npm run intel migrate            # schema is versioned and reversible
node --import=tsx src/tools/restoreState.ts --from backups/<timestamp> --apply
```

These are **not** interchangeable. Reverting code does not undo bad data;
restoring data does not undo bad configuration.

---

## Testing safely

Never test against the live tabs. Use the sandbox:

```bash
npm run dev:sandbox -- src/intelligence/cli.ts status
```

This forces development mode, uses a separate database and session folder, and
confines every spreadsheet read and write to `Test_*` tabs. The existing tabs
cannot be written, renamed or deleted — attempts are refused, not warned about.

---

## Honest limitations

- **Indexation is evidence, not proof.** We check via search queries on
  third-party domains we do not own. A "not indexed" result can be wrong, and a
  provider failure is recorded as `unknown`, never as a failure to index.
- **Content correlations are not causes.** They are observational. A strong
  correlation is a reason to run an experiment, not a reason to act.
- **The scoring weights are guesses** until calibrated.
- **Only two platforms can be auto-edited.** Others may be editable; they have
  not been verified, and unverified is treated as unavailable.
- **Lead attribution is only as good as the CRM data.** If the landing URL is
  not captured in Pipedrive, no amount of code recovers it.
