# Ken Research — RSS-Based Content Detection & Distribution
## Product Requirements Document (Updated)

**Status:** Finalized (pending Tech Team feed spec + newsletter subscriber list)
**Date:** 2026-09-13
**Supersedes:** `Ken_Research_PRD_RSS_AI_Content_Distribution.pdf` (v1.0) — this version reflects decisions made against the actual current `x-posting-agent` implementation.

---

## 1. Primary Objective

Detect newly published Ken Research content (Reports, Articles, Surveys, POVs/Insights, Case Studies) via a Tech-Team-provided RSS/API endpoint, and route it into the existing distribution pipeline — fully automatically, with no manual review step — across social, blog, and newsletter channels.

---

## 2. What Changed From the Original PRD

| Area | Original PRD (v1.0) | Finalized Decision |
|---|---|---|
| Detection source | Assumed an RSS feed, unspecified who builds it | **Real Tech Team API/RSS endpoint** — confirmed. It reports which reports/articles/surveys/POVs are newly live. |
| Approval gate | Human review/approval before publishing (§13.1) | **No approval gate.** Detect → generate → publish, fully automatic — matches how the rest of this pipeline already runs. |
| AI output | Structured intermediate breakdown (Title, 3 Key Findings, Stat, Trend, CTA) before final posts (§11.3) | **Skipped.** No one reviews the intermediate output since there's no approval step, so the final-post-direct flow (current behavior) stays as-is. |
| Data sourcing | AI content generation only | Unchanged — AI (OpenRouter) generates post content directly; **Tavily API** used as a fallback if additional data is needed, same as today. |
| Channels | LinkedIn + X only (initial), others deferred | **X, Medium, LinkedIn, Facebook, Blogger, HackMD** at launch — list is extensible; more platforms added as required. |
| Newsletter | Not covered | **New channel added: email newsletter**, sent via the **Outlook / Microsoft 365 API (OAuth)** — changed from the original Gmail plan (2026-09-15). Subscriber list to be provided by the team (source TBD). |

---

## 3. Detection Layer (RSS / Tech Team API)

- **Source of truth:** An API/RSS endpoint owned and provided by the Tech Team, reporting newly published/live content across Reports, Articles, Surveys, POVs/Insights, Case Studies.
- **Fields required from the endpoint** (per original PRD §8.2 — to be confirmed with Tech Team):
  - Title (required)
  - Canonical URL (required)
  - Publication date (required)
  - Content type (required)
  - Description/summary (required)
  - Unique ID/GUID (required)
  - Updated date, category/industry, image URL (preferred)
  - Author (optional)
- **Open item:** Exact schema/endpoint structure still to be confirmed with the Tech Team.
- **Relationship to existing code:** This repo already has an equivalent *sitemap-based* detector (`src/reportDiscovery/watcher.ts`) with dedup (seen-store keyed by URL) and `.md`-twin enrichment (`src/reportDiscovery/mdEnrichment.ts`), plus a mismatch guard that caught a real slug/`.md` title mismatch on 2026-09-09. Once the Tech Team endpoint exists, the detection source swaps from sitemap-polling to endpoint-polling; the dedup/enrichment/downstream logic is reused as-is.
- **Not yet wired to cron:** the sitemap-based detector exists as a manual CLI tool (`src/tools/runReportWatcher.ts`) today — it is not in `scheduler-new.ts`'s cron table. Whichever detection source is used (sitemap or the future RSS endpoint), it needs a cron slot added for genuinely automatic detection.

---

## 4. Content Retrieval

- For reports, retrieve the `.md` twin (already implemented and working — `mdEnrichment.ts`), including the existing mismatch guard.
- Fall back to Tavily API for any additional data the AI needs beyond what's in the `.md`/report page.

---

## 5. AI Content Generation

- No change from current behavior: AI generates platform-ready post content directly (no intermediate structured breakdown).
- Model/routing: existing OpenRouter 15-key rotation, NVIDIA NIM fallback.
- Grounding: content should stay based on retrieved source material — same standard the pipeline already applies via `sanityAgent.ts`'s validation checks.

---

## 6. Distribution Channels

| Channel | Mechanism | Status |
|---|---|---|
| X | Existing agent (`xAgentNew.ts`) | Reuse as-is |
| Medium | Existing agent | Reuse as-is |
| LinkedIn | Existing agent (`liBatchAgentNew.ts`) | Reuse as-is |
| Facebook | Existing agent (`fbBatchAgentNew.ts`) | Reuse as-is |
| Blogger | Existing agent | Reuse as-is |
| HackMD | Existing agent (`hackmdBatchAgentNew.ts`) | Reuse as-is |
| **Newsletter (new)** | **Outlook / Microsoft 365 API (OAuth)** | **To be built** |
| Additional platforms | TBD | Added as required, list is not fixed |

### 6.1 Newsletter Channel — New Requirements
- **Sending mechanism:** Outlook / Microsoft 365 API with OAuth (not browser automation) — changed from the original Gmail plan (2026-09-15).
- **Subscriber list:** Source to be provided by the team — not yet available. Pipeline should be built so the list source can be swapped in once confirmed (e.g., a Sheet tab, a synced list, etc.).
- **Content:** Reuses the same AI-generated summary/finding content as other channels, adapted to newsletter/email format.

---

## 7. Approval / Control

- **No human-in-the-loop step.** New content detected via the endpoint flows straight through content generation into the existing autonomous posting pipeline (cron-driven, same batch/ledger/error-recovery infrastructure already in place).

---

## 8. Open Items (Not Yet Resolved)

1. Tech Team's RSS/API endpoint — exact schema and availability date.
2. Newsletter subscriber list — source and format, pending from the team.
3. Final list of "additional platforms" beyond the six named above, if any.
4. Cron wiring for the detection layer, once the source (Tech Team endpoint vs. sitemap) is confirmed.

---

## 9. Out of Scope (For Now)

- Human review/approval workflow (explicitly decided against).
- Structured intermediate AI output as a distinct reviewable artifact (no consumer for it without an approval step).
