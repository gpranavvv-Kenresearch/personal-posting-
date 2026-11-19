# Architecture — Posting (existing) + Distribution Intelligence (new)

Renders automatically on GitHub. Top box is what already existed; the
bottom box is everything added on `abhinav/distribution-intelligence`
(PR #1) — **off by default**, and it can never change what the top box does.

```mermaid
flowchart TD
    Sheet["Google Sheet — list of reports to post"]
    Scheduler["Cron Scheduler (IST, node-cron)"]
    Coordinator["Master Coordinator"]
    ContentGen["Content Agent — generates platform-specific text"]
    Poster["Browser Poster — Playwright, 12 platforms"]
    Live["Live posts — 45+ accounts, ~674/day"]
    UTM["Every posted link tagged: utm_source=platform"]

    Sheet --> Scheduler --> Coordinator --> ContentGen --> Poster --> Live --> UTM

    subgraph Intel["DISTRIBUTION INTELLIGENCE — every box here is OFF unless its FEATURE flag is set"]
        direction TB
        GA4API["GA4 API collector\n(needs service-account access)"]
        GSCAPI["Search Console API collector\n(needs service-account access)"]
        ManualCSV["You export a CSV from GA4/GSC yourself\n(no credentials shared)"]
        ImportCmd["intel import-performance"]
        SERP["SERP indexation check\n(is the post actually in Google?)"]
        Pipedrive["Pipedrive leads"]
        Perf[("url_performance table\n— one shared store, same shape\nregardless of source")]
        Scoring["Opportunity Scoring\n— ranks reports, always says\nhow much is real data vs. guesswork"]
        PlatformAgg["Platform Intelligence (aggregate)\n— which platforms work overall"]
        PlatformMatch["Platform Match (per report)\n— which platform THIS report\nshould go to next"]
        ContentIntel["Content Correlation\n— which traits associate with results\n(observational, not causal)"]
        Interlink["Interlink Proposals\n— suggest links between reports"]
        Approval{{"Human approval\nrequired, always"}}
        Apply["Apply — dry run unless --apply,\nonly on HackMD + Mataroa"]

        GA4API --> Perf
        GSCAPI --> Perf
        ManualCSV --> ImportCmd --> Perf
        SERP --> Perf
        Pipedrive --> Perf
        Perf --> Scoring
        Perf --> PlatformAgg
        Perf --> PlatformMatch
        Perf --> ContentIntel
        PlatformAgg --> Interlink
        Interlink --> Approval
        Approval -->|approved| Apply
        Approval -->|rejected| Discard["Discarded"]
    end

    UTM --> GA4API
    UTM --> GSCAPI
    UTM --> SERP
    Apply -.->|edits an existing post, tagged + re-checked| Live
    Scoring --> You[["You — read the report,\ndecide, nothing changes itself"]]
    PlatformMatch --> You
```

## How to read it

- **Top row** — unchanged. Sheet → scheduler → content → posting. This PR
  never touches any of these boxes.
- **Bottom box** — everything new. It only *reads* what the top row already
  produced (the posted links and their UTM tags); the only way anything in
  this box ever touches a live post is the single dotted arrow at the
  bottom — a human-approved interlink edit, and only on the two platforms
  verified safe to edit.
- **GA4/GSC has two doors in**, both feeding the exact same table: the
  automated API door (needs access granted) and the manual CSV door (needs
  nothing, since that access isn't being shared with anyone).
- **Shadow mode** (on by default, not drawn above) sits in front of the
  `Apply` box specifically: even an approved suggestion is not applied while
  shadow mode is on.
