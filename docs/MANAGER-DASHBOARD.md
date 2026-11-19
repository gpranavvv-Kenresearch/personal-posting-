# Your own tracking system — set up on this machine

This is the "runs natively on my system" tracker: a page that shows what's
actually working across platforms, separate from wherever the posting
daemon itself runs, and separate from Pranav's machine. Nothing described
here can post, edit, or apply anything live — it only reads.

## What was set up

1. **A dashboard** — `dashboard/latest.html`. Open it in any browser. Shows:
   platform-by-platform verdicts, top reports by opportunity score, content
   patterns, pending interlink approvals, and which data sources are
   connected or not.
2. **A drop folder** — `data/manual-imports/inbox/`. Export a CSV from GA4
   or Search Console yourself (steps in `docs/INTELLIGENCE-RUNBOOK.md`,
   section "Getting GA4/GSC numbers in without handing out your login") and
   drop it in there. Name it with the source and a date, e.g.
   `ga4-2026-11-17.csv` or `gsc-2026-11-17.csv`. It's picked up automatically
   on the next refresh and moved to `data/manual-imports/imported/` once
   done — nothing is ever re-processed twice.
3. **A daily refresh** — Windows Scheduled Task `KenResearch-DistributionTracker`,
   runs `scripts/run-dashboard.ps1` every morning at 8:00 AM. It:
   - reads the real Google Sheet (read-only — this is a special connection
     that is physically unable to write, Google rejects any write attempt
     with it, regardless of any bug on our side)
   - imports anything waiting in the inbox folder
   - checks whether recent posts are visible in Google
   - rebuilds the dashboard
   - logs what happened to `dashboard/logs/` (keeps the last 30 runs, older
     ones are deleted automatically)

You can also run it yourself any time instead of waiting for 8 AM:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-dashboard.ps1
```

## What's connected right now, and what isn't

Verified live on this machine today:
- Local database and dashboard rendering — working.
- The scheduled task — registered and tested (ran it manually, it
  completed and updated the dashboard).

**Not yet connected: the Google Sheet.** `ingest` needs a Google
service-account key on this machine to read the real sheet, and this is a
fresh checkout with no key on it. Until that's placed, the dashboard will
correctly say "Google Sheets (ingest): NOT CONNECTED" instead of guessing —
this is expected, not a bug. Two ways to fix it, either works:
- Save the key file at `.accounts/google-service-account.json`, or
- Paste its contents as one line into `.env` as `GOOGLE_SERVICE_ACCOUNT_JSON=...`

See `docs/ACCESS-REQUIRED.md` for exactly which service account and what to
check. Once that key is in place, the very next 8 AM run (or a manual run)
starts showing real reports.

**Deliberately not connected: GA4 and Search Console APIs.** That access
stays with you personally, by your own decision — nothing here asks for it.
The CSV inbox folder above is how that data gets in instead.

**Also optional, not required for the dashboard to work:** `SERPAPI_KEY_1`,
`ZENSERP_API_KEY_1`, `SERPSTACK_API_KEY_1`, `TAVILY_API_KEY_1` for the
"is this post actually in Google" check. Already provisioned per
`docs/ACCESS-REQUIRED.md`; just not copied onto this specific machine yet.

## Managing the schedule

```powershell
# See it
Get-ScheduledTask -TaskName "KenResearch-DistributionTracker"

# Run it right now, instead of waiting
Start-ScheduledTask -TaskName "KenResearch-DistributionTracker"

# Change the time (example: 7:30 AM)
Set-ScheduledTask -TaskName "KenResearch-DistributionTracker" `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 7:30AM)

# Turn it off without deleting it
Disable-ScheduledTask -TaskName "KenResearch-DistributionTracker"

# Remove it entirely
Unregister-ScheduledTask -TaskName "KenResearch-DistributionTracker" -Confirm:$false
```

## Why this stays separate from Pranav's side

This whole setup — the `.env` flags, the scheduled task, the local
database at `data/intelligence.db`, the dashboard — lives only on this
machine and is not part of the git history (`.env`, `data/`, `dashboard/`,
and `/scripts/` are all gitignored on purpose). It reads the same shared
Sheet and the same shared code everyone else uses, but nothing about your
personal tracking setup needs to go to Pranav, and nothing here can affect
his machine or the live posting daemon.
