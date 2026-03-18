# Architecture — X Posting Agent

## Flow
```
Agent 1 (Login) → Agent 2 (Content) → Agent 3 (Post) → Return URL
```

## Diagram
```
ORCHESTRATOR (src/index.ts)
      │
      ▼
Agent 1 — login.ts
  → Launch stealth Chromium
  → Restore session OR login fresh
  → Return authenticated page
      │
      ▼
Agent 2 — contentGenerator.ts
  → Fetch kenresearch.com/blog
  → Claude extracts articles
  → Claude generates tweet
  → Return tweet text
      │
      ▼
Agent 3 — poster.ts
  → Use page from Agent 1
  → Compose and post tweet
  → Return tweet URL
```

## Why Stagehand?
X.com changes its UI constantly. Stagehand act() and extract() use
natural language so they work even after X.com updates its HTML.
CSS selectors break every few weeks.

## Why Session Persistence?
Logging in fresh every run looks like a bot. Restoring saved cookies
looks like a returning human user.