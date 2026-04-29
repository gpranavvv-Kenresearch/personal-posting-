# Keka CV Automation — Product Requirements Document (PRD)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully autonomous, AI-powered pipeline that reads candidate CVs from Google Drive, parses them with GPT, maps skills against Ken Research's role-specific competency matrix, fills the Keka job application form for every candidate, solves CAPTCHA programmatically, and tags each profile as **Relevant** or **Not Relevant** directly within Keka — eliminating all manual screening effort for the HR team.

**Architecture:** Event-driven Python pipeline with three phases — (1) Ingestion from Google Drive, (2) AI-powered CV parsing + skill-gap scoring, (3) Browser automation on Keka via Playwright with agentic self-repair loops. Each phase exposes a clean interface so agents can retry, self-diagnose, and rotate credentials on failure.

**Tech Stack:** Python 3.11, Playwright (async), Google Drive API v3, OpenAI GPT-4o / Codex, 2Captcha / CapSolver, Pydantic v2, asyncio, Pandas, Google Sheets API (audit log), python-dotenv, structlog.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Objectives & Success Metrics](#3-objectives--success-metrics)
4. [Stakeholders](#4-stakeholders)
5. [Scope](#5-scope)
6. [Skill-Role Competency Matrix](#6-skill-role-competency-matrix)
7. [System Architecture](#7-system-architecture)
8. [Data Flow Diagram](#8-data-flow-diagram)
9. [Component Specifications](#9-component-specifications)
10. [AI Agent Design](#10-ai-agent-design)
11. [Keka Form Specification](#11-keka-form-specification)
12. [CAPTCHA Strategy](#12-captcha-strategy)
13. [Relevance Tagging Logic](#13-relevance-tagging-logic)
14. [Error Handling & Self-Healing](#14-error-handling--self-healing)
15. [Security & Compliance](#15-security--compliance)
16. [Implementation Plan (Phased)](#16-implementation-plan-phased)
17. [File Structure](#17-file-structure)
18. [Testing Strategy](#18-testing-strategy)
19. [Risk Register](#19-risk-register)
20. [Glossary](#20-glossary)

---

## 1. Executive Summary

Ken Research's HR team receives hundreds of CVs for open positions (Research Analyst through Principal level). Today, every CV is manually reviewed — a slow, error-prone process that delays hiring. This automation eliminates that bottleneck.

The system will:
- Pull CVs automatically from a designated Google Drive folder
- Use GPT-4o to extract structured candidate data (name, contact, location, education, experience, skills)
- Score each candidate against the **Keka Keyword Competency Matrix** defined by HR
- Submit the application to Keka on the candidate's behalf (browser automation)
- Solve CAPTCHA without human intervention
- Stamp the Keka profile with a **Relevant** or **Not Relevant** tag based on role-fit score

HR reviewers log in to Keka, filter by tag, and review only the candidates that matter.

---

## 2. Problem Statement

| Pain Point | Current State | Impact |
|---|---|---|
| Manual CV screening | HR reads every CV individually | ~3–5 min/CV × hundreds of CVs = days of lost time |
| No structured skill mapping | Judgment-based, inconsistent | Good candidates missed; poor fits advance |
| Keka form entry | Manual copy-paste from CV | Human error, fatigue, data inconsistency |
| No audit trail | No record of why a CV was accepted/rejected | Compliance gaps, repeated work |
| Scalability | Process breaks at volume | Hiring speed bottleneck |

---

## 3. Objectives & Success Metrics

### Primary Objectives
1. **Zero-touch CV intake** — no human fills a Keka form
2. **Consistent skill mapping** — rule-based + AI, repeatable results
3. **Accurate relevance tagging** — HR only reviews "Relevant" profiles
4. **Full audit trail** — every decision logged with reasoning

### Key Performance Indicators

| Metric | Target |
|---|---|
| CV processing throughput | ≥ 50 CVs/hour |
| Form fill accuracy | ≥ 95% field-match vs. source CV |
| Skill mapping accuracy | ≥ 90% agreement with human reviewer (spot-check) |
| CAPTCHA solve rate | ≥ 97% |
| System uptime (during batch) | ≥ 99% with auto-recovery |
| False Relevant rate | ≤ 5% (profiles tagged Relevant that are not) |
| False Not-Relevant rate | ≤ 3% (good profiles incorrectly rejected) |

---

## 4. Stakeholders

| Role | Name / Team | Responsibility |
|---|---|---|
| Product Owner | HR Team (Avdhesh, Atoshi, Laksh) | Define competency matrix, validate tagging |
| Tech Lead | Automation Team (Pranav) | Architecture, deployment, maintenance |
| Primary Users | Abhinav Kumar, Vansh Meena | Review Relevant candidates in Keka |
| AI Integration | Automation Team | GPT prompts, scoring logic |
| Security Review | IT / Compliance | Credential management, data privacy |

---

## 5. Scope

### In Scope
- Google Drive CV ingestion (PDF, DOCX, DOC formats)
- AI-powered CV parsing (all standard sections)
- Skill mapping for **all 7 job roles** listed in the competency matrix
- Keka online application form automation
- CAPTCHA solving (image CAPTCHA + reCAPTCHA v2)
- Relevant / Not Relevant tagging in Keka
- Google Sheets audit log per run
- Slack/email alert on batch completion or critical failure
- Self-healing agent (retry, rotate keys, restart browser on error)

### Out of Scope (Phase 1)
- Interview scheduling automation
- Offer letter generation
- LinkedIn / Naukri sourcing (CV pull from job boards)
- ATS integrations beyond Keka
- Video interview scoring

---

## 6. Skill-Role Competency Matrix

This matrix is the **single source of truth** for relevance scoring. It is maintained by HR and loaded at runtime from a Google Sheet (or JSON config file). The system checks each skill column per role — a "Must to have" entry means the candidate's CV must contain evidence of that skill.

```
╔══════════════════════════╦═══════════════════════╦══════════════════╦═════════╦═══════════════╦════════════════════════╦═══════════╦════════════════╦═════════════════════════╗
║ Position                 ║ Market Assessment/    ║ Go To Market     ║ Primary ║ Presentations ║ Client Facing/         ║ Sales     ║ Team Handling  ║ Competitive             ║
║                          ║ Market Sizing         ║ (GTM)            ║         ║               ║ Client Handling        ║           ║                ║ Benchmarking            ║
╠══════════════════════════╬═══════════════════════╬══════════════════╬═════════╬═══════════════╬════════════════════════╬═══════════╬════════════════╬═════════════════════════╣
║ Research Analyst         ║ Must to have          ║ Must to have     ║ Must    ║ Must to have  ║                        ║           ║                ║ Must to have            ║
║ Research Analyst-2       ║ Must to have          ║ Must to have     ║ Must    ║ Must to have  ║                        ║           ║                ║ Must to have            ║
║ Senior Research Analyst  ║ Must to have          ║ Must to have     ║ Must    ║ Must to have  ║                        ║           ║                ║ Must to have            ║
║ Consultant               ║ Must to have          ║ Must to have     ║ Must    ║ Must to have  ║                        ║           ║ Must to have   ║ Must to have            ║
║ Project Lead             ║ Must to have          ║ Must to have     ║ Must    ║ Must to have  ║                        ║           ║ Must to have   ║ Must to have            ║
║ Engagement Manager       ║ Must to have          ║ Must to have     ║ Must    ║ Must to have  ║ Must to have           ║ Must      ║ Must to have   ║ Must to have            ║
║ Principal                ║ Must to have          ║ Must to have     ║ Must    ║ Must to have  ║ Must to have           ║ Must      ║ Must to have   ║ Must to have            ║
╚══════════════════════════╩═══════════════════════╩══════════════════╩═════════╩═══════════════╩════════════════════════╩═══════════╩════════════════╩═════════════════════════╝
```

### Skill Keyword Taxonomy

Each competency is matched using a keyword list maintained in `config/skill_keywords.json`. Example:

```json
{
  "market_assessment_market_sizing": [
    "market sizing", "TAM", "SAM", "SOM", "addressable market",
    "market assessment", "market research", "demand estimation",
    "supply analysis", "market landscape", "industry sizing"
  ],
  "go_to_market": [
    "GTM", "go to market", "go-to-market", "market entry",
    "product launch", "commercialization", "distribution strategy",
    "channel strategy", "market penetration"
  ],
  "primary_research": [
    "primary research", "field research", "interviews", "KOL",
    "expert calls", "surveys", "focus groups", "ethnographic",
    "qualitative research", "quantitative research", "data collection"
  ],
  "presentations": [
    "presentations", "PowerPoint", "slide deck", "client presentation",
    "storytelling", "executive presentation", "pitch deck", "PPT"
  ],
  "client_facing": [
    "client management", "client handling", "stakeholder management",
    "client communication", "account management", "client relations",
    "customer success", "client facing"
  ],
  "sales": [
    "sales", "revenue generation", "business development", "BD",
    "deal closure", "pipeline", "upselling", "cross-selling",
    "proposal writing", "RFP", "bid management"
  ],
  "team_handling": [
    "team management", "team lead", "mentoring", "people management",
    "leadership", "managed a team", "supervised", "coached",
    "line management", "team of"
  ],
  "competitive_benchmarking": [
    "competitive benchmarking", "competitive analysis", "competitor analysis",
    "competitive intelligence", "benchmarking", "market comparison",
    "landscape analysis", "SWOT", "competitive landscape"
  ]
}
```

### Relevance Decision Rule

```
For a given (candidate, role) pair:

required_skills = [skills where matrix[role][skill] == "Must to have"]
matched_skills  = [skills where candidate CV contains ≥1 keyword from taxonomy[skill]]

match_rate = len(matched_skills) / len(required_skills)

if match_rate >= 0.75:
    tag = "Relevant"
    confidence = "High"   if match_rate == 1.0
               = "Medium" if match_rate >= 0.75
else:
    tag = "Not Relevant"
    confidence = "Low"

NOTE: GPT confirmation pass runs on borderline cases (0.60 ≤ match_rate < 0.75)
to reduce false negatives on paraphrased skill descriptions.
```

---

## 7. System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         KEKA CV AUTOMATION SYSTEM                           │
│                                                                             │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────────────────────┐ │
│  │  INGESTION  │───▶│  AI PROCESSING   │───▶│   KEKA FORM AUTOMATION     │ │
│  │   LAYER     │    │     LAYER        │    │        LAYER               │ │
│  └─────────────┘    └──────────────────┘    └────────────────────────────┘ │
│         │                   │                           │                   │
│         ▼                   ▼                           ▼                   │
│  ┌─────────────┐    ┌──────────────────┐    ┌────────────────────────────┐ │
│  │Google Drive │    │  Candidate DB    │    │   CAPTCHA Solver           │ │
│  │  Watcher   │    │  (Pydantic)      │    │   (2Captcha / CapSolver)   │ │
│  └─────────────┘    └──────────────────┘    └────────────────────────────┘ │
│                                                          │                  │
│                              ┌───────────────────────────┘                 │
│                              ▼                                              │
│                    ┌──────────────────────────┐                            │
│                    │  TAGGING & AUDIT LAYER   │                            │
│                    │  (Keka tags + GSheets)   │                            │
│                    └──────────────────────────┘                            │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  ORCHESTRATOR AGENT (Self-healing, retry, credential rotation)     │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Responsibility | Key Technology |
|---|---|---|
| Ingestion | Scan Google Drive folder, download new CVs, deduplicate | Google Drive API v3 |
| AI Processing | Parse CV → structured JSON, extract skills, score vs matrix | GPT-4o, regex fallback |
| Form Automation | Navigate Keka, fill every field, submit | Playwright (async) |
| CAPTCHA Solver | Detect captcha type, call solver API, inject solution | 2Captcha / CapSolver |
| Tagging | Set tag in Keka profile, write audit log | Playwright + Sheets API |
| Orchestrator | Queue management, error recovery, retries, alerts | asyncio, structlog |

---

## 8. Data Flow Diagram

```
[Google Drive Folder]
      │
      │  1. Poll every N minutes
      │  2. Download unprocessed CVs
      ▼
[CV Downloader]
      │
      │  PDF/DOCX → raw text (pdfminer / python-docx)
      ▼
[Text Extractor]
      │
      │  Raw text → GPT-4o prompt
      ▼
[GPT CV Parser]
      │  Returns: CandidateProfile (Pydantic model)
      │  {name, email, phone, location, education[],
      │   experience[], skills_raw[], years_exp}
      ▼
[Skill Mapper]
      │  CandidateProfile + CompetencyMatrix → SkillScoreResult
      │  {role: "Consultant", matched: [...], missing: [...],
      │   match_rate: 0.85, tag: "Relevant"}
      ▼
[Keka Form Filler]  ←───── [CAPTCHA Solver] (on-demand)
      │
      │  Navigates to Keka job role page
      │  Fills: name, email, phone, location, resume upload,
      │          skills, experience, cover note
      │  Solves CAPTCHA
      │  Submits form
      ▼
[Keka Profile Tagger]
      │  Locates submitted profile in Keka ATS
      │  Applies tag: "Relevant" | "Not Relevant"
      │  Adds internal note with match_rate + matched skills
      ▼
[Audit Logger]
      │  Writes row to Google Sheet:
      │  [timestamp, cv_filename, candidate_name, role,
      │   match_rate, tag, keka_profile_url, status]
      ▼
[Orchestrator]
      │  Marks CV as processed in local state file
      │  Sends summary alert (Slack/email) on batch complete
      │  On error: retry up to 3× → escalate to human alert
```

---

## 9. Component Specifications

### 9.1 CV Ingestion Module (`src/ingestion/`)

**`drive_watcher.py`**
- Authenticate with Google Drive API using service account JSON
- List files in target folder by MIME type (PDF, DOCX)
- Compare against `state/processed_cvs.json` to skip already-processed files
- Download new files to `tmp/cvs/`
- Return: `List[CVFile]` — filename, drive_id, downloaded_path, job_role (derived from subfolder name)

**`text_extractor.py`**
- Accept: file path
- PDF: use `pdfminer.six` (primary) → `PyMuPDF` (fallback)
- DOCX: use `python-docx`
- Output: clean UTF-8 string (strip headers/footers, normalize whitespace)
- Max text length: 8000 tokens (truncate gracefully with note)

### 9.2 AI Processing Module (`src/ai/`)

**`cv_parser.py`** — GPT-4o CV Parsing Agent

Prompt template:
```
You are a professional HR data extractor. Extract ALL of the following fields from the resume text below.
Return ONLY valid JSON matching this schema. If a field is not found, use null.

Schema:
{
  "first_name": string,
  "last_name": string,
  "email": string,
  "phone": string,
  "city": string,
  "country": string,
  "linkedin_url": string | null,
  "total_years_experience": number | null,
  "highest_education": string,
  "current_employer": string | null,
  "current_title": string | null,
  "skills_mentioned": [string],   // raw skill phrases found in CV
  "experience_summary": string    // 2-sentence summary of career
}

Resume text:
{cv_text}
```

- Model: `gpt-4o`
- Temperature: 0 (deterministic extraction)
- Retry: 3× with exponential backoff on rate limit
- Validation: Pydantic `CandidateProfile` model — invalid JSON triggers retry with correction prompt

**`skill_mapper.py`** — Skill Scoring Engine

```python
class SkillScoreResult(BaseModel):
    role: str
    required_skills: List[str]
    matched_skills: List[str]
    missing_skills: List[str]
    match_rate: float          # 0.0 – 1.0
    tag: Literal["Relevant", "Not Relevant"]
    confidence: Literal["High", "Medium", "Low", "GPT-Confirmed"]
    reasoning: str             # human-readable explanation
```

Logic:
1. Keyword scan: check `skills_mentioned` + full CV text for each skill's keyword list (case-insensitive, partial match allowed)
2. If `match_rate >= 0.75` → **Relevant**
3. If `0.60 <= match_rate < 0.75` → **GPT Confirmation Pass** (ask GPT: "Does this CV demonstrate [skill]? Yes/No/Partial")
4. GPT confirmation overrides keyword result
5. If `match_rate < 0.60` → **Not Relevant** (no GPT pass, save tokens)

### 9.3 Browser Automation Module (`src/browser/`)

**`keka_login.py`**
- Launch Playwright Chromium with persistent profile (`.sessions/keka/`)
- Navigate to Keka login URL
- Fill email + password fields
- Handle 2FA if present (human alert + pause)
- Verify successful login by checking dashboard element
- Save session cookies to persistent profile

**`keka_form_filler.py`**
- Accept: `CandidateProfile` + target job role URL
- Navigate to Keka job role application page
- Map CandidateProfile fields to Keka form fields (see §11)
- Upload CV file (original PDF/DOCX)
- Call CAPTCHA solver if CAPTCHA detected
- Click Submit
- Capture submitted profile URL from success page
- Return: `FormSubmissionResult` — success bool, profile_url, error_message

**`keka_tagger.py`**
- Accept: profile_url, tag string, match_reasoning
- Navigate to profile URL in Keka ATS
- Locate tag/label field in candidate profile
- Apply tag: "Relevant" or "Not Relevant"
- Add internal note: `"Auto-tagged by CV Bot | Match: {match_rate:.0%} | Skills: {matched_skills}"`
- Screenshot the final state for audit

### 9.4 CAPTCHA Solver (`src/captcha/`)

**`captcha_solver.py`**

Supported CAPTCHA types:
| Type | Detection Method | Solver |
|---|---|---|
| reCAPTCHA v2 | `iframe[src*="recaptcha"]` | 2Captcha `userrecaptcha` endpoint |
| Image CAPTCHA | `img[alt*="captcha"]` | 2Captcha `base64` endpoint |
| hCaptcha | `iframe[src*="hcaptcha"]` | 2Captcha `hcaptcha` endpoint |

Flow:
1. Detect CAPTCHA type by DOM inspection
2. Extract site key or capture image bytes
3. Submit to 2Captcha API (primary) → CapSolver (fallback)
4. Poll for solution (max 120 seconds, 5-second intervals)
5. Inject solution token via `page.evaluate()` or fill image input
6. Click verify/submit

**`captcha_bypass_fallback.py`** — if automated solving fails after 2 attempts:
- Screenshot CAPTCHA
- Send to Slack with inline image
- Pause automation for that CV (move to `pending_human/` queue)
- Continue with next CV

### 9.5 Orchestrator (`src/orchestrator.py`)

```
Main event loop:
  while True:
    1. Call drive_watcher.get_new_cvs()
    2. For each cv (async batch, configurable concurrency):
       a. text_extractor.extract(cv)
       b. cv_parser.parse(text)          # GPT call
       c. skill_mapper.score(profile, role)
       d. keka_form_filler.fill(profile, role_url)
       e. keka_tagger.tag(profile_url, tag)
       f. audit_logger.log(result)
       g. state_manager.mark_processed(cv.drive_id)
    3. On batch complete → send_summary_alert()
    4. Sleep N minutes → repeat
```

**Self-healing rules:**
- `BrowserCrashError` → kill browser, relaunch, retry same CV
- `FormFieldNotFoundError` → log selector, try alternate selector, alert if fails twice
- `GPTRateLimitError` → wait 60s, retry with exponential backoff
- `CAPTCHATimeoutError` → move to human queue, continue
- `DriveAuthError` → refresh token, retry once, alert human
- Any error on same CV 3× → mark as `FAILED`, log, skip to next

---

## 10. AI Agent Design

### Agent Architecture: Codex Agentic Loop

The system uses a **supervisor-worker** agentic pattern:

```
┌────────────────────────────────────┐
│        SUPERVISOR AGENT            │
│  (GPT-4o, orchestration role)      │
│  - Decides next action             │
│  - Evaluates worker output         │
│  - Triggers retries / escalation   │
└────────────┬───────────────────────┘
             │
      ┌──────┼──────┐
      ▼      ▼      ▼
┌─────────┐ ┌─────────┐ ┌──────────────┐
│ PARSER  │ │ MAPPER  │ │ FORM FILLER  │
│ WORKER  │ │ WORKER  │ │   WORKER     │
│ (GPT-4o)│ │(rule +  │ │ (Playwright  │
│         │ │ GPT-4o) │ │  + GPT-4o)   │
└─────────┘ └─────────┘ └──────────────┘
```

### Codex Integration Points

| Step | Codex/GPT Role |
|---|---|
| CV Parsing | GPT-4o extracts structured JSON from raw CV text |
| Skill Mapping (borderline) | GPT-4o confirms if paraphrased skills qualify |
| Form Filling Errors | GPT-4o reads error screenshot, proposes selector fix |
| Self-healing | GPT-4o reads error log, generates Python patch, applies it |
| Audit Summary | GPT-4o writes batch summary in plain English for HR |

### Prompt Engineering Standards

- **System prompts:** Role-defined, concise, no ambiguity
- **Output format:** Always JSON with Pydantic schema enforcement
- **Temperature:** 0 for extraction tasks, 0.3 for reasoning tasks
- **Token budget:** Max 2000 tokens/response to control cost
- **Retry prompt:** Include original response + validation error in retry

---

## 11. Keka Form Specification

The following fields will be auto-filled from `CandidateProfile`:

| Keka Form Field | Source Field | Notes |
|---|---|---|
| First Name | `first_name` | GPT-extracted |
| Last Name | `last_name` | GPT-extracted |
| Email | `email` | GPT-extracted |
| Phone Number | `phone` | Normalize to E.164 format |
| Current Location | `city` + `country` | Concatenated |
| Current Employer | `current_employer` | null → leave blank |
| Current Designation | `current_title` | null → leave blank |
| Total Experience | `total_years_experience` | Round to nearest 0.5 |
| Highest Qualification | `highest_education` | GPT-extracted |
| Skills | `skills_mentioned` | Comma-separated, first 10 |
| Resume Upload | original CV file | PDF preferred, DOCX fallback |
| Cover Note | Auto-generated | "Submitted via Ken Research CV Bot on {date}" |
| LinkedIn URL | `linkedin_url` | If present |

**Selector Strategy:**
```python
# Always waitForSelector before interact
SELECTORS = {
    "first_name":    'input[name="firstName"], input[placeholder*="First"]',
    "last_name":     'input[name="lastName"],  input[placeholder*="Last"]',
    "email":         'input[type="email"]',
    "phone":         'input[type="tel"], input[name="phone"]',
    "location":      'input[name="location"], input[placeholder*="Location"]',
    "resume_upload": 'input[type="file"]',
    "submit_btn":    'button[type="submit"], button:has-text("Apply"), button:has-text("Submit")',
}
```

---

## 12. CAPTCHA Strategy

### Primary: 2Captcha (Paid API)
- Cost: ~$1 per 1000 solves
- Solve time: 15–45 seconds (human workers)
- Reliability: 97–99%
- Supported: reCAPTCHA v2, v3, hCaptcha, image

### Fallback: CapSolver
- Activate if 2Captcha returns error or times out
- Same API interface (drop-in replacement)

### Last Resort: Human Queue
- CAPTCHA screenshot → Slack DM to automation team
- CV moved to `pending_human/` folder
- Human solves → marks in `state/human_resolved.json`
- Bot picks up and continues

### Implementation:

```python
async def solve_captcha(page: Page) -> bool:
    captcha_type = await detect_captcha_type(page)
    if not captcha_type:
        return True  # no CAPTCHA, proceed

    for solver in [TwoCaptchaSolver(), CapSolverSolver()]:
        try:
            token = await solver.solve(page, captcha_type)
            await inject_solution(page, captcha_type, token)
            return True
        except (SolverTimeout, SolverError):
            continue

    await escalate_to_human(page)
    return False
```

---

## 13. Relevance Tagging Logic

### Tag Values
- `Relevant` — candidate meets ≥75% of required skills for the applied role
- `Not Relevant` — candidate meets <75% of required skills

### Keka Tagging Method
Keka supports candidate labels/tags in the ATS view. The bot will:
1. Navigate to the submitted candidate's profile in the Keka recruiter dashboard
2. Click "Add Tag" or "Add Label"
3. Type or select "Relevant" / "Not Relevant"
4. Save

If Keka doesn't expose tags via UI, fallback: add a **Comment/Note** with the tag prominently marked.

### Internal Note Format (added to every profile)
```
🤖 AUTO-TAGGED by Ken Research CV Bot
Date: 2026-04-23
Role Applied: Consultant
Match Rate: 85%

✅ Matched Skills:
  - Market Assessment / Market Sizing
  - Go To Market (GTM)
  - Primary Research
  - Presentations
  - Competitive Benchmarking
  - Team Handling

❌ Missing Skills:
  - Client Facing / Client Handling
  - Sales

Decision: RELEVANT (meets 75% threshold)
Confidence: Medium

To override: update tag manually in Keka.
```

---

## 14. Error Handling & Self-Healing

### Error Classification

| Error Class | Examples | Auto-Recovery |
|---|---|---|
| `TransientError` | Network timeout, rate limit | Retry with backoff (3×) |
| `BrowserError` | Page crash, element not found | Kill + relaunch browser, retry |
| `AuthError` | Session expired, login failed | Re-login, retry |
| `AIError` | GPT bad JSON, token limit | Retry with corrected prompt |
| `CAPTCHAError` | Solve timeout, unknown type | Human escalation queue |
| `DataError` | Corrupt PDF, empty CV | Log + skip, mark FAILED |
| `FatalError` | Drive API down, Keka down | Alert + pause entire batch |

### Self-Healing Agent

On `BrowserError` after 2 retries:
1. Screenshot the current page state
2. Send screenshot + error traceback to GPT-4o
3. Prompt: *"You are a Playwright automation debugger. The element selector failed. Analyze this screenshot and suggest the correct Playwright selector."*
4. Apply the suggested selector
5. If that also fails → escalate to human

### State Management

```
state/
  processed_cvs.json     # {"drive_id": {"status": "done", "keka_url": "..."}}
  pending_human.json     # CVs waiting for human CAPTCHA solve
  failed_cvs.json        # CVs that failed after 3 retries
  batch_counters.json    # Today's run stats
```

---

## 15. Security & Compliance

### Credential Management
- All credentials in `.env` file (gitignored)
- Keka credentials: `KEKA_EMAIL`, `KEKA_PASSWORD`
- Google Drive: service account JSON path in `GOOGLE_SERVICE_ACCOUNT_PATH`
- 2Captcha: `TWOCAPTCHA_API_KEY`
- OpenAI: `OPENAI_API_KEY`
- Never hardcode any credential in source code

### Data Privacy
- CV text is sent to OpenAI API — ensure OpenAI data processing agreement is in place
- Raw CV files stored locally in `tmp/cvs/` — delete after processing (configurable retention)
- No PII logged to external services (Slack alerts contain only candidate name + status, not full data)
- Audit log in Google Sheets contains name, email, tag — access restricted to HR team

### Session Security
- Playwright sessions stored in `.sessions/keka/` — excluded from git
- Sessions expire — bot handles re-login transparently

---

## 16. Implementation Plan (Phased)

---

## Chunk 1: Foundation & Ingestion

### Task 1: Project Scaffold

**Files:**
- Create: `keka-cv-bot/` (root project directory)
- Create: `keka-cv-bot/src/ingestion/__init__.py`
- Create: `keka-cv-bot/pyproject.toml`
- Create: `keka-cv-bot/.env.example`
- Create: `keka-cv-bot/config/skill_keywords.json`
- Create: `keka-cv-bot/config/competency_matrix.json`

- [ ] **Step 1.1: Initialize project**
```bash
mkdir keka-cv-bot && cd keka-cv-bot
python -m venv venv && source venv/bin/activate
pip install playwright pydantic openai google-api-python-client \
            google-auth pdfminer.six python-docx structlog \
            python-dotenv twocaptcha aiofiles asyncio aiohttp
playwright install chromium
pip freeze > requirements.txt
```

- [ ] **Step 1.2: Create pyproject.toml**
```toml
[project]
name = "keka-cv-bot"
version = "1.0.0"
requires-python = ">=3.11"

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

- [ ] **Step 1.3: Create .env.example**
```bash
KEKA_EMAIL=hr@kenresearch.com
KEKA_PASSWORD=
KEKA_BASE_URL=https://yourcompany.keka.com
GOOGLE_SERVICE_ACCOUNT_PATH=config/service-account.json
GOOGLE_DRIVE_FOLDER_ID=
OPENAI_API_KEY=
TWOCAPTCHA_API_KEY=
CAPSOLVER_API_KEY=
SLACK_WEBHOOK_URL=
TARGET_JOB_ROLE=Consultant
LOG_LEVEL=INFO
```

- [ ] **Step 1.4: Create skill_keywords.json**
  (full keyword taxonomy from §6)

- [ ] **Step 1.5: Create competency_matrix.json**
```json
{
  "Research Analyst": {
    "market_assessment_market_sizing": "must",
    "go_to_market": "must",
    "primary_research": "must",
    "presentations": "must",
    "client_facing": null,
    "sales": null,
    "team_handling": null,
    "competitive_benchmarking": "must"
  }
  // ... all 7 roles
}
```

- [ ] **Step 1.6: Commit**
```bash
git init && git add .
git commit -m "feat: project scaffold with config files"
```

---

### Task 2: Google Drive Ingestion

**Files:**
- Create: `src/ingestion/drive_watcher.py`
- Create: `src/ingestion/text_extractor.py`
- Create: `tests/test_ingestion.py`
- Create: `state/processed_cvs.json`

- [ ] **Step 2.1: Write failing test**
```python
# tests/test_ingestion.py
import pytest
from src.ingestion.drive_watcher import DriveWatcher

def test_drive_watcher_lists_pdfs():
    watcher = DriveWatcher(folder_id="test_folder")
    # Should return list of CVFile objects
    # Use mock for Drive API in unit test
    assert hasattr(watcher, 'get_new_cvs')
```

- [ ] **Step 2.2: Run test — expect FAIL**
```bash
pytest tests/test_ingestion.py -v
# Expected: ImportError or AttributeError
```

- [ ] **Step 2.3: Implement drive_watcher.py**
```python
from dataclasses import dataclass
from pathlib import Path
from googleapiclient.discovery import build
from google.oauth2 import service_account
import json, os

@dataclass
class CVFile:
    drive_id: str
    filename: str
    downloaded_path: Path
    job_role: str  # derived from subfolder name

class DriveWatcher:
    def __init__(self, folder_id: str):
        self.folder_id = folder_id
        self.state_path = Path("state/processed_cvs.json")
        self._service = self._build_service()
        self._processed = self._load_state()

    def _build_service(self):
        creds = service_account.Credentials.from_service_account_file(
            os.environ["GOOGLE_SERVICE_ACCOUNT_PATH"],
            scopes=["https://www.googleapis.com/auth/drive.readonly"]
        )
        return build("drive", "v3", credentials=creds)

    def _load_state(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text())
        return {}

    def get_new_cvs(self) -> list[CVFile]:
        query = f"'{self.folder_id}' in parents and trashed=false"
        results = self._service.files().list(
            q=query, fields="files(id, name, mimeType)"
        ).execute()
        files = results.get("files", [])
        new_files = [f for f in files if f["id"] not in self._processed]
        return [self._download(f) for f in new_files]

    def _download(self, f: dict) -> CVFile:
        # Download file to tmp/cvs/
        path = Path(f"tmp/cvs/{f['name']}")
        path.parent.mkdir(parents=True, exist_ok=True)
        request = self._service.files().get_media(fileId=f["id"])
        path.write_bytes(request.execute())
        return CVFile(
            drive_id=f["id"],
            filename=f["name"],
            downloaded_path=path,
            job_role=os.environ.get("TARGET_JOB_ROLE", "Consultant")
        )

    def mark_processed(self, drive_id: str, result: dict):
        self._processed[drive_id] = result
        self.state_path.write_text(json.dumps(self._processed, indent=2))
```

- [ ] **Step 2.4: Implement text_extractor.py**
```python
from pathlib import Path
from pdfminer.high_level import extract_text as pdf_extract
from docx import Document

def extract_text(file_path: Path) -> str:
    suffix = file_path.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(file_path)
    elif suffix in (".docx", ".doc"):
        return _extract_docx(file_path)
    raise ValueError(f"Unsupported file type: {suffix}")

def _extract_pdf(path: Path) -> str:
    try:
        text = pdf_extract(str(path))
        return _clean(text)
    except Exception:
        import fitz  # PyMuPDF fallback
        doc = fitz.open(str(path))
        return _clean(" ".join(page.get_text() for page in doc))

def _extract_docx(path: Path) -> str:
    doc = Document(str(path))
    return _clean("\n".join(p.text for p in doc.paragraphs))

def _clean(text: str) -> str:
    import re
    text = re.sub(r'\s+', ' ', text)
    return text.strip()[:20000]  # cap at ~5000 tokens
```

- [ ] **Step 2.5: Run tests — expect PASS**
```bash
pytest tests/test_ingestion.py -v
```

- [ ] **Step 2.6: Commit**
```bash
git add src/ingestion/ tests/test_ingestion.py state/
git commit -m "feat: Google Drive ingestion + text extraction"
```

---

## Chunk 2: AI Processing

### Task 3: CV Parser (GPT-4o)

**Files:**
- Create: `src/ai/cv_parser.py`
- Create: `src/models/candidate.py`
- Create: `tests/test_cv_parser.py`

- [ ] **Step 3.1: Define Pydantic model**
```python
# src/models/candidate.py
from pydantic import BaseModel
from typing import Optional

class CandidateProfile(BaseModel):
    first_name: str
    last_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    linkedin_url: Optional[str] = None
    total_years_experience: Optional[float] = None
    highest_education: Optional[str] = None
    current_employer: Optional[str] = None
    current_title: Optional[str] = None
    skills_mentioned: list[str] = []
    experience_summary: Optional[str] = None
    raw_cv_text: str = ""
```

- [ ] **Step 3.2: Write failing test**
```python
# tests/test_cv_parser.py
import pytest
from unittest.mock import AsyncMock, patch
from src.ai.cv_parser import parse_cv
from src.models.candidate import CandidateProfile

@pytest.mark.asyncio
async def test_parse_cv_returns_candidate_profile():
    sample_text = "John Doe | john@email.com | +91-9876543210 | Mumbai..."
    with patch("src.ai.cv_parser.openai_client") as mock:
        mock.chat.completions.create = AsyncMock(return_value=...)
        result = await parse_cv(sample_text)
    assert isinstance(result, CandidateProfile)
    assert result.first_name == "John"
```

- [ ] **Step 3.3: Implement cv_parser.py**
```python
import json, os
from openai import AsyncOpenAI
from src.models.candidate import CandidateProfile

openai_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

PARSE_PROMPT = """You are a professional HR data extractor.
Extract ALL fields from the resume below. Return ONLY valid JSON.
If a field is not found, use null.

Schema: {schema}

Resume:
{cv_text}"""

async def parse_cv(cv_text: str) -> CandidateProfile:
    schema = CandidateProfile.model_json_schema()
    for attempt in range(3):
        try:
            response = await openai_client.chat.completions.create(
                model="gpt-4o",
                temperature=0,
                messages=[{"role": "user", "content": PARSE_PROMPT.format(
                    schema=json.dumps(schema, indent=2),
                    cv_text=cv_text[:8000]
                )}],
                response_format={"type": "json_object"}
            )
            data = json.loads(response.choices[0].message.content)
            data["raw_cv_text"] = cv_text
            return CandidateProfile(**data)
        except Exception as e:
            if attempt == 2:
                raise
            await asyncio.sleep(2 ** attempt)
```

- [ ] **Step 3.4: Run tests — expect PASS**
- [ ] **Step 3.5: Commit**
```bash
git add src/ai/ src/models/ tests/test_cv_parser.py
git commit -m "feat: GPT-4o CV parser with Pydantic validation"
```

---

### Task 4: Skill Mapper

**Files:**
- Create: `src/ai/skill_mapper.py`
- Create: `src/models/skill_score.py`
- Create: `tests/test_skill_mapper.py`

- [ ] **Step 4.1: Write failing test**
```python
def test_relevant_candidate_scores_above_threshold():
    candidate = CandidateProfile(
        first_name="Jane", last_name="Doe",
        skills_mentioned=["market sizing", "GTM", "primary research",
                          "presentations", "competitive benchmarking"],
        raw_cv_text="...extensive market sizing and GTM experience..."
    )
    result = score_candidate(candidate, role="Research Analyst")
    assert result.tag == "Relevant"
    assert result.match_rate >= 0.75

def test_irrelevant_candidate_scores_below_threshold():
    candidate = CandidateProfile(
        first_name="Bob", last_name="Smith",
        skills_mentioned=["coding", "DevOps", "Kubernetes"],
        raw_cv_text="...software engineer background..."
    )
    result = score_candidate(candidate, role="Research Analyst")
    assert result.tag == "Not Relevant"
```

- [ ] **Step 4.2: Implement skill_mapper.py**
```python
import json, re
from pathlib import Path
from src.models.candidate import CandidateProfile
from src.models.skill_score import SkillScoreResult

KEYWORDS = json.loads(Path("config/skill_keywords.json").read_text())
MATRIX   = json.loads(Path("config/competency_matrix.json").read_text())

def score_candidate(candidate: CandidateProfile, role: str) -> SkillScoreResult:
    role_requirements = MATRIX.get(role, {})
    required = [skill for skill, level in role_requirements.items() if level == "must"]
    text = (candidate.raw_cv_text + " " + " ".join(candidate.skills_mentioned)).lower()

    matched = [skill for skill in required if _keyword_match(text, skill)]
    missing = [s for s in required if s not in matched]
    rate = len(matched) / len(required) if required else 0.0

    tag = "Relevant" if rate >= 0.75 else "Not Relevant"
    confidence = "High" if rate == 1.0 else "Medium" if rate >= 0.75 else "Low"

    return SkillScoreResult(
        role=role, required_skills=required, matched_skills=matched,
        missing_skills=missing, match_rate=rate, tag=tag,
        confidence=confidence,
        reasoning=f"Matched {len(matched)}/{len(required)} required skills."
    )

def _keyword_match(text: str, skill_key: str) -> bool:
    keywords = KEYWORDS.get(skill_key, [])
    return any(re.search(r'\b' + re.escape(kw.lower()) + r'\b', text) for kw in keywords)
```

- [ ] **Step 4.3: Run tests — expect PASS**
- [ ] **Step 4.4: Commit**
```bash
git add src/ai/skill_mapper.py src/models/skill_score.py tests/test_skill_mapper.py
git commit -m "feat: keyword-based skill mapper with GPT borderline confirmation"
```

---

## Chunk 3: Browser Automation

### Task 5: Keka Login

**Files:**
- Create: `src/browser/keka_login.py`
- Create: `tests/test_keka_login.py` (integration test, requires real credentials)

- [ ] **Step 5.1: Implement keka_login.py**
```python
import os
from pathlib import Path
from playwright.async_api import async_playwright, BrowserContext

SESSION_DIR = Path(".sessions/keka")

async def get_authenticated_context() -> BrowserContext:
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    p = await async_playwright().start()
    context = await p.chromium.launch_persistent_context(
        str(SESSION_DIR),
        channel="chrome",
        headless=False,
        viewport={"width": 1280, "height": 800}
    )
    page = context.pages[0] if context.pages else await context.new_page()

    # Check if already logged in
    await page.goto(os.environ["KEKA_BASE_URL"])
    if "login" not in page.url.lower():
        return context  # session valid

    # Perform login
    await page.wait_for_selector('input[type="email"]', timeout=10000)
    await page.fill('input[type="email"]', os.environ["KEKA_EMAIL"])
    await page.fill('input[type="password"]', os.environ["KEKA_PASSWORD"])
    await page.click('button[type="submit"]')
    await page.wait_for_url("**/dashboard**", timeout=15000)
    return context
```

- [ ] **Step 5.2: Commit**
```bash
git add src/browser/keka_login.py
git commit -m "feat: Keka Playwright login with persistent session"
```

---

### Task 6: Keka Form Filler + CAPTCHA + Tagger

**Files:**
- Create: `src/browser/keka_form_filler.py`
- Create: `src/captcha/captcha_solver.py`
- Create: `src/browser/keka_tagger.py`

- [ ] **Step 6.1: Implement captcha_solver.py**
```python
import os, asyncio, aiohttp
from playwright.async_api import Page

TWOCAPTCHA_KEY = os.environ.get("TWOCAPTCHA_API_KEY")

async def solve_captcha(page: Page) -> bool:
    captcha_type = await _detect(page)
    if not captcha_type:
        return True
    for solve_fn in [_solve_twocaptcha, _solve_capsolver]:
        try:
            token = await solve_fn(page, captcha_type)
            await _inject(page, captcha_type, token)
            return True
        except Exception:
            continue
    await _human_escalate(page)
    return False

async def _detect(page: Page) -> str | None:
    if await page.query_selector("iframe[src*='recaptcha']"):
        return "recaptcha_v2"
    if await page.query_selector("iframe[src*='hcaptcha']"):
        return "hcaptcha"
    if await page.query_selector("img[alt*='captcha' i]"):
        return "image"
    return None
```

- [ ] **Step 6.2: Implement keka_form_filler.py**
  (fill each field from CandidateProfile using SELECTORS dict from §11, upload file, call captcha_solver, submit)

- [ ] **Step 6.3: Implement keka_tagger.py**
  (navigate to profile URL, apply tag + internal note)

- [ ] **Step 6.4: Commit**
```bash
git add src/browser/ src/captcha/
git commit -m "feat: Keka form filler, CAPTCHA solver, profile tagger"
```

---

## Chunk 4: Orchestrator & Audit

### Task 7: Main Orchestrator

**Files:**
- Create: `src/orchestrator.py`
- Create: `src/audit_logger.py`
- Create: `main.py`

- [ ] **Step 7.1: Implement orchestrator.py** (async event loop wiring all components)
- [ ] **Step 7.2: Implement audit_logger.py** (Google Sheets append via Sheets API)
- [ ] **Step 7.3: Create main.py** (CLI entry point with argparse: `--once`, `--watch`, `--role`)
- [ ] **Step 7.4: End-to-end dry-run test** with one sample CV
- [ ] **Step 7.5: Commit**
```bash
git add src/orchestrator.py src/audit_logger.py main.py
git commit -m "feat: main orchestrator + audit logger — full pipeline wired"
```

---

## 17. File Structure

```
keka-cv-bot/
├── main.py                          # CLI entry: --once | --watch | --role
├── pyproject.toml
├── requirements.txt
├── .env.example
├── .gitignore                       # .env, .sessions/, tmp/, state/
│
├── config/
│   ├── skill_keywords.json          # Keyword taxonomy per competency
│   ├── competency_matrix.json       # Role → required skills mapping
│   └── service-account.json         # Google Drive credentials (gitignored)
│
├── src/
│   ├── orchestrator.py              # Main async event loop
│   ├── audit_logger.py              # Google Sheets audit trail
│   │
│   ├── ingestion/
│   │   ├── drive_watcher.py         # Google Drive polling + download
│   │   └── text_extractor.py        # PDF/DOCX → clean text
│   │
│   ├── ai/
│   │   ├── cv_parser.py             # GPT-4o structured extraction
│   │   └── skill_mapper.py          # Keyword match + GPT confirmation
│   │
│   ├── models/
│   │   ├── candidate.py             # CandidateProfile Pydantic model
│   │   └── skill_score.py           # SkillScoreResult Pydantic model
│   │
│   ├── browser/
│   │   ├── keka_login.py            # Playwright persistent session login
│   │   ├── keka_form_filler.py      # Form navigation + field filling
│   │   └── keka_tagger.py           # Apply Relevant/Not Relevant tag
│   │
│   └── captcha/
│       └── captcha_solver.py        # 2Captcha + CapSolver + human queue
│
├── tests/
│   ├── test_ingestion.py
│   ├── test_cv_parser.py
│   ├── test_skill_mapper.py
│   └── test_orchestrator.py
│
├── state/
│   ├── processed_cvs.json           # Deduplication state
│   ├── pending_human.json           # Human CAPTCHA queue
│   └── failed_cvs.json              # CVs that failed after 3 retries
│
└── tmp/
    └── cvs/                         # Downloaded CVs (auto-deleted post-process)
```

---

## 18. Testing Strategy

### Unit Tests (pytest + pytest-asyncio)
| Test File | Coverage |
|---|---|
| `test_ingestion.py` | Drive watcher (mocked Drive API), text extraction |
| `test_cv_parser.py` | GPT output parsing, Pydantic validation, retry logic |
| `test_skill_mapper.py` | Keyword matching, relevance decision, edge cases |
| `test_orchestrator.py` | Queue processing, error handling, state management |

### Integration Tests
- Real Drive API with test folder containing 3 sample CVs
- Real GPT-4o call with known CV → validate output fields
- Playwright against staging Keka URL (or headful run recording)

### Acceptance Tests (HR Sign-off)
- Batch of 20 CVs processed manually by HR → compare tags with bot output
- Target: ≥90% agreement rate
- HR signs off before production deployment

### Regression Tests
- Run monthly with new sample CVs from HR
- Alert if agreement rate drops below 85%

---

## 19. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Keka UI changes break selectors | Medium | High | Selector fallback list; GPT-4o screenshot repair; monthly selector audit |
| reCAPTCHA v3 (behavioral, no widget) | High | Medium | Playwright fingerprint humanization; slow typing delays; random mouse movement |
| GPT-4o hallucination on CV parsing | Low | Medium | Pydantic validation catches schema errors; retry with correction prompt |
| Google Drive API quota exceeded | Low | High | Exponential backoff; process in batches of 20/hour |
| Keka blocks automation (bot detection) | Medium | High | Randomized delays (1–3s between actions); persistent browser profile; real Chrome channel |
| CV in image-only PDF (scanned) | Medium | Medium | Add Tesseract OCR fallback for image PDFs |
| 2Captcha solve failure on novel CAPTCHA | Low | Low | Human escalation queue with Slack alert |
| Data privacy breach (CV data in logs) | Low | Critical | PII scrubbing in logs; secure .env; restrict Sheets access to HR only |

---

## 20. Glossary

| Term | Definition |
|---|---|
| ATS | Applicant Tracking System (Keka is the ATS used by Ken Research) |
| Competency Matrix | HR-defined table mapping job roles to required skills |
| Match Rate | Percentage of required skills found in a candidate's CV (0.0–1.0) |
| Relevant | Tag applied to candidates scoring ≥75% on match rate |
| Not Relevant | Tag applied to candidates scoring <75% on match rate |
| GPT Confirmation Pass | Secondary GPT-4o call for borderline candidates (60–75% match) |
| Persistent Context | Playwright browser profile that retains cookies/session across runs |
| CAPTCHA | Challenge-response test on Keka's application form |
| Service Account | Google Cloud credential that allows server-to-server Drive API access |
| Skill Taxonomy | Keyword lists that define what phrases count as evidence of each competency |

---

*PRD Version: 1.0 | Author: Automation Team | Date: 2026-04-23 | Status: Ready for Implementation*
