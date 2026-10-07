# AI Guardian - Level 1 End-to-End Roadmap

## Document Status

| Field | Value |
|---|---|
| Status | Local control center implemented; posting-laptop deployment pending |
| Version | Level 1 / v1.0 |
| Date | 2026-10-07 |
| Project | Ken Research content distribution system |
| Primary owner | Project owner |
| Runtime timezone | Asia/Kolkata |
| Scope | This repository and its posting runtime only |

This document records the agreed design and the current Level 1 implementation. The owner authorized local setup on 2026-10-07. It does not authorize autonomous remediation, production posting changes, or credential access.

## Executive Conclusion

Level 1 will be a local-first **AI Project Guardian**. Its purpose is to continuously understand this repository, observe the separate posting laptop, detect existing failures and developing risks, investigate root causes, explain workflow impact, and recommend ranked solutions.

The Guardian is not one trained model. It is a system composed of:

- A replaceable local reasoning model.
- A current project knowledge index.
- Private long-term conversation memory.
- Live evidence from the posting laptop.
- Read-only diagnostic tools.
- A strict permission layer.
- Optional Claude, Codex, or GPT consultation after owner approval.
- A dedicated Google Sheet tab for incident reporting.

Level 1 has **zero authority to change the posting system without explicit owner approval**. It may observe and diagnose automatically. Diagnostic reporting to the dedicated Guardian tab is the only planned automatic write and must not modify normal workflow rows.

## 1. Vision

The long-term vision is a project companion that combines the general knowledge of a capable LLM with the owner's project knowledge, decisions, reasoning patterns, and operational history.

The companion should behave as the persistent guardian of this project:

```text
Watch -> Detect -> Investigate -> Explain -> Recommend
                                              |
                                      Wait for approval
                                              |
                                Future level: Act -> Verify
```

Level 1 stops at recommendation and reporting. Execution remains with the owner, Codex, Claude, another approved agent, or a human operator.

## 2. Level 1 Scope

Level 1 includes:

- Continuous read-only monitoring of the posting workflow.
- Proactive risk detection and reactive incident detection.
- Repository-wide code and documentation understanding.
- Git-aware indexing so diagnoses match the production commit.
- Private capture of project-related AI conversations.
- Retrieval of relevant past decisions, rejected ideas, and fixes.
- Deep root-cause investigation using live and historical evidence.
- A structured incident report in a new Google Sheet tab.
- Recommended solutions with risk, effort, verification, and rollback.
- Optional external-model consultation after explicit approval.
- Local event queuing when the AI laptop is asleep or offline.

Level 1 is advisory. It does not remediate production automatically.

## 3. Agreed Decisions

| Decision | Agreed outcome |
|---|---|
| Project scope | Only this repository and its posting runtime |
| AI location | The current laptop is the AI control center |
| Posting location | The other laptop continues running the posting system |
| Posting laptop access | A lightweight read-only observer is allowed |
| Code synchronization | GitHub is the source for committed code and history |
| Runtime synchronization | Runtime evidence comes from the posting laptop, not GitHub |
| Conversation memory | All project-related conversations are archived automatically |
| Memory location | Private local files/database on the AI laptop; never pushed to GitHub |
| Memory authority | No extracted conclusion becomes active policy without owner approval |
| Automatic authority | Observe, investigate, diagnose, predict impact, and recommend |
| Change authority | No operational or code change without explicit owner approval |
| External consultation | Allowed only after explicit owner approval |
| Incident destination | A new dedicated tab in Google Sheets |
| Major start rule | Failure of the posting flow to begin at 10:20 IST |
| Major output rule | Fewer than 500 successful posts across all platforms at 18:30 IST |
| Platform quotas | No fixed per-platform target in Level 1 |
| Local hardware | Intel i7-1360P, 16 GB RAM, 4 GB GPU memory, about 52 GB free storage |
| Training | No model training or fine-tuning in Level 1 |

### Implementation status on 2026-10-07

- Node.js control-center API and dashboard implemented.
- Authenticated read-only observer intake implemented.
- Durable control and Sheet outboxes implemented.
- Deterministic 10:20 heartbeat and 18:30 total checks implemented and tested.
- Incident lifecycle, local diagnosis queue, audit journal, and memory approval states implemented.
- Ollama 0.40.0, `nomic-embed-text`, `qwen3:8b`, and `qwen3:4b` installed. The 8B model exceeded the operational latency budget; the focused `qwen3:4b` configuration passed all four Level 1 evaluation cases in 106-146 seconds per diagnosis.
- Private configuration and generated memory are excluded from Git.
- Control-center Windows startup task registered.
- Tailscale installation remains blocked until the owner runs its MSI with a true Administrator token.
- Posting-laptop observer, existing service account, and runtime state are not present on this laptop, so remote deployment and creation of the live `AI Guardian` tab remain pending.

## 4. Non-Goals

Level 1 will not:

- Train a foundation model from scratch.
- Fine-tune a model on raw conversations.
- Automatically edit code.
- Automatically pull, merge, deploy, or roll back Git changes.
- Retry failed posts.
- Restart the posting daemon.
- Change cron schedules.
- Clear browser sessions or account profiles.
- Modify normal workflow data in Google Sheets.
- Submit posts, emails, appeals, or account forms.
- Expose an unrestricted remote terminal.
- Copy credentials or raw session contents to the AI laptop.
- Assume every remembered statement is true or currently active.
- Promise diagnosis of every unknown failure with certainty.

## 5. Operating Principles

### 5.1 Evidence before conclusion

Every diagnosis must link to code, logs, runtime state, screenshots, Git history, or approved memory. The Guardian must separate confirmed facts, strong inferences, hypotheses, and missing evidence.

### 5.2 Current code outranks old memory

When information conflicts, use this priority:

1. Current production evidence.
2. Code at the exact production Git commit.
3. Explicitly approved owner decisions.
4. Current repository documentation.
5. Historical incidents and fixes.
6. Raw conversations and brainstorming.
7. Model inference.

### 5.3 Safe uncertainty

The Guardian must be allowed to say it does not know. It should propose additional read-only checks instead of inventing a cause.

### 5.4 Minimum access

The AI receives only the evidence needed for diagnosis. Credentials, authentication cookies, session contents, API keys, OAuth tokens, and service-account files remain inaccessible.

### 5.5 Owner control

The owner approves active memories, external consultation, and every state-changing action.

## 6. Two-Laptop Architecture

```text
                         GITHUB
             committed code, history, branches
                          /   \
                         /     \
                        v       v
+-----------------------------+       +-----------------------------+
| AI CONTROL CENTER           |       | POSTING WORKER              |
| Current laptop              |       | Other laptop                |
|                             |       |                             |
| Ollama local model          |<----->| Read-only observer          |
| Node Guardian service       |private| Existing Node/TS project    |
| Project knowledge index     | link  | Chrome profiles/sessions    |
| Private conversation memory |       | Credentials stay local      |
| Diagnosis and reports       |       | Durable event queue         |
| Approval interface          |       | Evidence collection         |
+-----------------------------+       +-----------------------------+
               |
               v
       GOOGLE SHEETS
       AI Guardian tab
```

### AI control center responsibilities

- Maintain project and memory indexes.
- Receive and deduplicate operational events.
- Run deterministic detection rules.
- Retrieve relevant context.
- Run local-model diagnosis.
- Prepare incident reports.
- Request approval for external consultation.
- Track incident lifecycle and owner decisions.

### Posting worker responsibilities

- Continue normal posting independently of the AI laptop.
- Observe process, scheduler, logs, counts, and platform results.
- Produce sanitized evidence bundles.
- Queue events while disconnected.
- Answer allow-listed read-only diagnostic requests.
- Write approved Guardian reports through existing Sheets credentials.
- Never expose arbitrary command execution.

## 7. Component Design

| Component | Location | Responsibility |
|---|---|---|
| Guardian API | AI laptop | Receives events, serves local UI, coordinates diagnosis |
| Knowledge indexer | AI laptop | Indexes code, docs, Git history, and approved logs |
| Memory ingestor | AI laptop | Archives project conversations and extracts candidate memories |
| Structured memory | AI laptop | Stores incidents, decisions, approvals, and outcomes |
| Vector memory | AI laptop | Semantic retrieval across code, docs, and conversations |
| Exact search | AI laptop | Finds symbols, selectors, error codes, and literal strings |
| Reasoning engine | AI laptop | Produces evidence-backed diagnoses and recommendations |
| Policy engine | AI laptop | Enforces read-only Level 1 permissions |
| Production observer | Posting laptop | Watches runtime and collects evidence |
| Event spool | Posting laptop | Retains events during disconnection |
| Sheet reporter | Posting laptop | Appends reports to the dedicated Guardian tab |
| Local dashboard | AI laptop | Shows health, incidents, memory approvals, and connection state |

The local dashboard is an administration interface. The Google Sheet remains the owner's daily incident inbox.

## 8. End-to-End Data Flows

### 8.1 Startup flow

```text
Posting worker starts
-> observer records machine and project identity
-> observer reads current Git commit
-> observer confirms daemon/heartbeat availability
-> observer opens or resumes local event queue
-> AI control center connects when available
-> queued events are transmitted with stable event IDs
```

### 8.2 Normal monitoring flow

```text
Observer collects safe signals
-> deterministic checks detect normal/abnormal state
-> abnormal state becomes a structured event
-> event is queued locally
-> event is sent to AI control center
-> duplicate event IDs are ignored
-> Guardian correlates repeated symptoms
```

### 8.3 Incident diagnosis flow

```text
Event received
-> establish expected behavior
-> identify production commit
-> retrieve relevant code and history
-> gather logs, counts, screenshots, and prior incidents
-> generate multiple hypotheses
-> run allow-listed read-only checks
-> rank hypotheses by evidence
-> calculate current and future impact
-> generate solution options
-> create Guardian Sheet report
```

### 8.4 External consultation flow

```text
Guardian determines local confidence is insufficient
-> prepares a sanitized context package
-> asks owner for consultation approval
-> owner chooses Claude, Codex, or GPT
-> approved package is shared
-> external recommendation returns
-> Guardian validates it against current evidence
-> report is updated with agreement/disagreement and confidence
```

### 8.5 Offline flow

```text
AI laptop asleep/offline
-> posting worker continues posting
-> observer continues monitoring
-> events remain in durable local queue
-> basic 10:20 and 18:30 rules still run
-> when AI laptop reconnects, backlog is transmitted
-> Guardian diagnoses events in chronological order
```

Continuous AI reasoning cannot run while the AI laptop is in true sleep. The posting observer and event queue provide continuity.

## 9. Knowledge and Memory Design

### 9.1 Knowledge categories

| Category | Examples |
|---|---|
| Code | TypeScript modules, functions, imports, platform posters |
| Architecture | Scheduler, coordinator, Sheets, agents, browser sessions |
| Runtime | Heartbeat, ledger, process state, batch results |
| Operations | Logs, screenshots, account-health summaries |
| History | Git commits, previous fixes, past incidents |
| Conversations | GPT, Claude, Codex, and owner discussions |
| Decisions | Approved rules and rejected alternatives |
| Procedures | Confirmed diagnostic and recovery processes |

### 9.2 Memory layers

```text
Raw archive
  Complete conversation, unchanged except secret redaction

Candidate memory
  Automatically extracted fact, idea, preference, or decision
  Status: pending approval

Approved memory
  Owner-confirmed decision or policy

Historical memory
  Superseded or rejected memory retained for reasoning history
```

### 9.3 Memory record

Each structured memory should include:

| Field | Purpose |
|---|---|
| Memory ID | Stable identifier |
| Content | The fact, idea, rule, or decision |
| Type | Fact, idea, preference, decision, procedure, warning |
| Status | Pending, approved, rejected, superseded |
| Source | Conversation/file/incident reference |
| Created at | Original timestamp |
| Approved by | Owner identity when applicable |
| Approved at | Approval timestamp |
| Valid from/to | Optional time validity |
| Supersedes | Older memory replaced by this one |
| Confidence | Extraction confidence, not truth authority |

### 9.4 Retrieval strategy

Use hybrid retrieval:

- Semantic vector search for related concepts.
- Exact text search for code symbols and error strings.
- Structural code graph for imports and dependencies.
- Metadata filters for platform, date, incident, and Git commit.
- Approved-memory priority over unapproved brainstorming.

The entire repository should not be inserted into each model prompt. The system retrieves the smallest complete evidence package for the current problem.

## 10. Diagnostic Reasoning Design

The universal investigation loop is:

```text
Detect abnormal behavior
-> establish expected behavior
-> collect current evidence
-> compare with code and historical behavior
-> create multiple possible causes
-> test safest read-only hypotheses first
-> narrow root cause
-> calculate workflow and codebase impact
-> recommend ranked solutions
-> report uncertainty and missing evidence
```

### Diagnostic categories

- Scheduler did not trigger.
- Batch triggered but crashed.
- Batch triggered but hung.
- Browser session expired.
- Platform UI or selector changed.
- Account publishing restriction.
- Content rejected by platform policy.
- API authentication failure.
- API quota or rate limit.
- External service unavailable.
- Google Sheets schema or quota failure.
- Local model logged out, degraded, or unavailable.
- Network or DNS failure.
- Resource exhaustion on posting laptop.
- Incorrect code or configuration.
- Unknown failure requiring more evidence.

The categories guide investigation but do not limit it. Novel failures must still be investigated through evidence.

## 11. Incident Reporting

Every incident report must answer:

1. What happened?
2. When did it begin?
3. Why did it happen?
4. What evidence supports the diagnosis?
5. How confident is the diagnosis?
6. What is already affected?
7. What will happen if no action is taken?
8. Where is the failure located in the workflow?
9. Does it expose a broader codebase or architecture weakness?
10. What solutions are possible?
11. What are the risks, effort, verification, and rollback for each solution?
12. Which solution is recommended and why?
13. Who should execute it: owner, local model, Codex, Claude, or manual operator?
14. What exact approval is required?

### Solution ranking

The report should distinguish:

- Immediate containment.
- Lowest-risk repair.
- Permanent repair.
- Architectural improvement, when justified.

Recommendations must not overwhelm the owner with unranked possibilities.

## 12. Tools and Applications

### 12.1 Recommended Level 1 stack

| Tool | Location | Purpose | Cost |
|---|---|---|---|
| Ollama | AI laptop | Local model and embedding runtime | Free/local |
| Node.js 24 | AI laptop | Guardian API, dashboard, memory, and observer runtime | Already installed |
| Node HTTP API | AI laptop | Dependency-free local control-center service | Built in |
| Local JSON/JSONL stores | AI laptop | Incidents, memory, audit, and durable queues | Built in |
| Ollama embeddings | AI laptop | Semantic vector retrieval without a separate vector database | Free/local |
| ripgrep | AI laptop | Exact source and error search | Free/open source |
| Node.js | Posting laptop | Read-only observer integrated with the existing stack | Existing runtime |
| Playwright | Posting laptop | Existing diagnostic screenshots and browser evidence | Existing dependency |
| Tailscale | Both | Recommended private connection | Free tier subject to plan limits |
| WireGuard | Both | Fully self-managed connection alternative | Free/open source |
| Git/GitHub | Both | Code version and production commit identity | Existing setup |
| Google Sheets API | Posting laptop | Dedicated Guardian incident tab | Existing setup |

Official references: [Ollama chat API](https://docs.ollama.com/api/chat), [Ollama embeddings](https://docs.ollama.com/api/embed), [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling), and [Google Sheets API](https://developers.google.com/sheets/api).

### 12.2 Deliberately excluded from Level 1

- Kubernetes.
- Cloud vector databases.
- Paid observability platforms.
- A public internet API.
- Unrestricted SSH controlled by the model.
- LangChain or LangGraph unless the plain state machine becomes unmanageable.
- Fine-tuning frameworks.

Keeping the first version small reduces failure modes and makes its decisions auditable.

## 13. Local Model Strategy

### 13.1 Hardware constraint

The AI laptop has 16 GB RAM and 4 GB GPU memory. It should begin with quantized 7B/8B-class models. Larger models may be too slow or may cause memory pressure.

### 13.2 Selection process

Do not declare a model best from public benchmarks. Test several models on the project's own evaluation set:

- Trace a complete platform workflow.
- Diagnose a cron miss.
- Diagnose an expired session.
- Diagnose an API rate limit.
- Analyze a browser selector failure.
- Use an approved historical decision correctly.
- Refuse an unauthorized change.
- Admit when evidence is insufficient.
- Prepare a valid external-consultation package.

Measure accuracy, evidence quality, latency, memory use, and policy compliance.

### 13.3 Model roles

| Role | Model size expectation |
|---|---|
| Classification and memory extraction | Small local model may be sufficient |
| Primary diagnosis | Best-performing usable 7B/8B local model |
| Difficult cross-module reasoning | Claude, Codex, or GPT after approval |

### 13.4 Why no training in Level 1

Raw conversations contain contradictions, rejected ideas, and changing facts. Fine-tuning them would make errors difficult to remove. Level 1 uses retrieval and structured memory.

Later fine-tuning may teach stable communication style and decision patterns using owner-approved examples. It should never replace external memory for current code and runtime facts.

## 14. Production Observer Design

### 14.1 Signals to collect

- Posting daemon process state.
- Heartbeat freshness.
- Slot-ledger state.
- Current Git commit and dirty/clean status.
- Batch start, finish, duration, and result.
- Successful, failed, skipped, and pending counts.
- Platform error summaries.
- API status and rate-limit classifications.
- Browser timeouts and existing diagnostic screenshots.
- Session-health classification without session contents.
- Resource health: CPU, memory, disk, and process count.
- Google Sheets availability and schema warnings.

### 14.2 Event requirements

Every event must include:

- Stable event ID.
- Machine ID.
- Production Git commit.
- IST and UTC timestamps.
- Component/platform.
- Severity.
- Detection rule.
- Sanitized evidence references.
- Repeat count.
- Correlation ID for related events.

### 14.3 Queue behavior

- Append events durably before transmission.
- Retry delivery with bounded backoff.
- Mark acknowledged events without deleting the audit history.
- Deduplicate on the control center using event ID.
- Cap storage and rotate old diagnostic media.

### 14.4 Read-only probe allow-list

The AI control center may request only defined probes such as:

- Process and heartbeat status.
- Current ledger summary.
- Recent sanitized log lines.
- Posting-count summary.
- Existing screenshot metadata.
- Git commit and diff summary.
- Non-sensitive disk/resource status.

Level 1 exposes no mutation endpoint.

## 15. Private Connection Design

No connection currently exists. The recommended sequence is:

1. Establish a private Tailscale network between the two laptops.
2. Bind both services only to their private addresses or localhost.
3. Add application-level authentication in addition to the private network.
4. Use HTTPS where practical.
5. Allow only the exact observer and report endpoints.
6. Reject replayed or expired requests.
7. Include machine identity and request IDs.
8. Log every request and response safely.

Proposed endpoint shape:

```text
GET  /v1/health
GET  /v1/runtime/summary
GET  /v1/incidents
GET  /v1/incidents/{id}/evidence
POST /v1/events/acknowledge
POST /v1/guardian-report
```

There is intentionally no general command-execution endpoint.

## 16. Permission and Security Model

### 16.1 Standing permission

The Guardian may continuously read and analyze approved project code, logs, runtime health, and sanitized evidence.

### 16.2 Explicit approval required

- External-model consultation.
- Code or configuration changes.
- Git branch, commit, merge, pull, or deployment actions.
- Process restart or termination.
- Manual batch or retry.
- Schedule changes.
- Session clearing or account operations.
- Workflow Sheet changes.
- Publishing, messaging, emailing, or form submission.
- New tool installation or permission expansion.

### 16.3 Always inaccessible to model tools

- `.env` files.
- `.accounts` contents.
- Browser cookies and profiles.
- Passwords, API keys, and OAuth tokens.
- Google service-account private keys.
- Raw session storage.
- Unrestricted shell or PowerShell execution.

### 16.4 Guardian Sheet exception

Appending a diagnostic report to the dedicated `AI Guardian` tab is a specifically approved reporting operation. It must use a narrow function that cannot edit normal workflow tabs.

## 17. External Model Consultation

The local Guardian prepares a context package before requesting approval.

The package contains:

- Project architecture summary.
- Production Git commit.
- Relevant current files and line references.
- Expected and actual behavior.
- Incident timeline.
- Sanitized logs and screenshots.
- Affected platforms/accounts represented by anonymous identifiers where possible.
- Previous related incidents.
- Approved owner decisions.
- Attempts already made.
- Local hypotheses and confidence.
- The exact expert question.

After approval, the chosen external model receives only this package plus repository access when explicitly available. The Guardian validates the returned recommendation instead of accepting it blindly.

## 18. Google Sheet Design

Create one dedicated tab named `AI Guardian` during implementation after approval.

Recommended columns:

| Column | Meaning |
|---|---|
| Incident ID | Stable unique identifier |
| First Detected IST | Initial detection time |
| Last Seen IST | Most recent occurrence |
| Status | Open, investigating, waiting approval, resolved, dismissed |
| Severity | Critical, major, warning, information |
| Component | Scheduler, platform, API, browser, Sheets, model, system |
| Platforms | Affected platforms |
| Summary | Short human-readable problem |
| Root Cause | Best current diagnosis |
| Confidence | High, medium, low |
| Evidence | Safe references to logs, code, screenshots, commits |
| Current Impact | What is already affected |
| Future Impact | What happens if ignored |
| Recommended Solution | Ranked primary recommendation |
| Alternatives | Other viable solutions |
| Recommended Executor | Owner, local model, Codex, Claude, manual |
| Approval Needed | Exact requested permission |
| Owner Decision | Approved, rejected, edited, pending |
| Resolution | What was eventually done |
| Verification | Evidence that the issue is resolved |

Repeated observations should update the same incident row where safe instead of creating daily duplicates.

## 19. Monitoring Rules

### 19.1 Fixed major rules

| Rule | Check time | Result |
|---|---|---|
| Posting flow has not begun | Shortly after 10:20 IST with a defined grace window | Major incident |
| Successful all-platform total is below 500 | 18:30 IST | Major incident |
| Shared failure stops workflow progression | Continuous | Major or critical incident |

The 500 total counts verified successful posts across all platforms and must not double-count retries or duplicate result records.

### 19.2 Dynamic detection

- Consecutive failure growth.
- Sudden cross-platform failure correlation.
- Repeated API rate limits.
- Increasing browser timeouts.
- Session-health deterioration.
- Long-running or hung batches.
- Model refusal or login failures.
- Disk/memory pressure.
- Missing heartbeat.
- Unexpected scheduler gaps.
- Sheet schema drift.
- Success-rate changes from recent baseline.

Dynamic rules should use baselines and evidence, not undocumented platform quotas.

## 20. Delivery Roadmap

### Phase 0 - Specification freeze

Deliverables:

- Owner approval of this roadmap.
- Identification of changes from the earlier unapproved POC.
- Final list of approved data sources.
- Confirmation of reporting permission and Sheet ownership.

Exit gate: no unresolved disagreement about Level 1 authority or scope.

### Phase 1 - Observability readiness

Deliverables:

- Structured event schema.
- Runtime signal inventory.
- Secret-redaction rules.
- Posting-count definition.
- 10:20 and 18:30 deterministic checks.
- Durable local event spool design.

Exit gate: observer can describe production health without AI reasoning or sensitive access.

### Phase 2 - Private two-laptop connection

Deliverables:

- Private network setup.
- Machine identity and application authentication.
- Read-only endpoint allow-list.
- Offline queue and replay protection.
- Connectivity health check.

Exit gate: safe events travel between laptops, survive disconnects, and never duplicate.

### Phase 3 - Project knowledge system

Deliverables:

- Repository ingestion.
- Git-commit-aware indexing.
- Exact search.
- Semantic search.
- TypeScript structural/import graph if retrieval evaluation shows it is needed.
- Source citations with file and line references.
- Incremental reindexing.

Exit gate: retrieval consistently finds the correct modules for representative questions.

### Phase 4 - Private conversation memory

Deliverables:

- Raw local conversation archive.
- ChatGPT, Claude, and Codex import adapters.
- Secret redaction.
- Candidate-memory extraction.
- Pending/approved/rejected/superseded workflow.
- Local-only storage and Git exclusions.

Exit gate: the Guardian retrieves relevant history without treating brainstorming as policy.

### Phase 5 - Diagnostic engine

Deliverables:

- Local-model benchmark harness.
- Selected local reasoning model.
- Universal diagnostic state machine.
- Hypothesis tracking.
- Evidence/confidence classification.
- Impact analysis.
- Ranked solution generation.

Exit gate: historical incident replays meet the evaluation threshold.

### Phase 6 - Guardian Sheet reporting

Deliverables:

- Dedicated tab and protected schema.
- Append/update-only Guardian reporting function.
- Incident deduplication.
- Status and owner-decision fields.
- Daily 18:30 summary.

Exit gate: reports are readable, complete, and cannot modify workflow tabs.

### Phase 7 - Approved external consultation

Deliverables:

- Sanitized context-package generator.
- Owner approval checkpoint.
- Claude/Codex/GPT adapters selected separately.
- Response validation and comparison.
- Consultation audit trail.

Exit gate: no project data is sent externally without explicit approval.

### Phase 8 - Shadow operation

Run Level 1 without remediation authority for at least two representative weeks.

Deliverables:

- Daily incident review.
- False-positive and missed-incident log.
- Diagnosis-quality scoring.
- Model latency and resource measurements.
- Updated thresholds and runbooks.

Exit gate: owner accepts the Guardian as useful and trustworthy for continued advisory operation.

## 21. Testing and Evaluation

### 21.1 Test layers

| Layer | Examples |
|---|---|
| Unit | Redaction, schemas, counters, memory status, deduplication |
| Integration | Observer-to-control-center delivery, offline replay, Sheet reporting |
| Retrieval | Correct file, function, conversation, and decision returned |
| Diagnostic | Root-cause ranking on historical incidents |
| Security | Secret denial, path escape, replay, malformed event, unauthorized endpoint |
| Policy | Every requested mutation is refused or routed to approval |
| Reliability | Reconnect, restart, queue recovery, duplicate event handling |

### 21.2 Historical incident evaluation set

Build an owner-reviewed dataset from real cases such as:

- Missed cron executions.
- Catch-up causing duplicate-post risk.
- Platform account restrictions.
- Login/session expiration.
- API quota exhaustion.
- GPT/ChatGPT generation login or response failure.
- Browser selector/UI changes.
- Hung browser close or clipboard operation.
- Google Sheets quota/schema errors.
- Model endpoint degradation.

Each case should contain known evidence, accepted root cause, rejected hypotheses, chosen solution, and verification.

### 21.3 Initial quality targets

- 100% of reports cite evidence.
- 100% of state-changing requests require approval.
- 0 secrets included in model context, Sheet reports, or event transport.
- 0 duplicate incidents from repeated event delivery.
- Correct root cause appears in the top three hypotheses for at least 80% of historical cases before shadow launch.
- Major fixed rules are detected reliably in simulation.
- Observer overhead does not materially interfere with posting.

## 22. Level 1 Acceptance Criteria

Level 1 is accepted only when it can:

1. Detect that the posting flow did not begin at 10:20 IST.
2. Correctly calculate the all-platform successful-post total at 18:30 IST.
3. Raise a major incident when that total is below 500.
4. Receive production evidence after an offline period without duplication.
5. Identify the exact production Git commit.
6. Retrieve relevant current code with citations.
7. Retrieve relevant historical conversations and approved decisions.
8. Distinguish approved policy from rejected or pending ideas.
9. Diagnose representative cron, API, browser, session, model, and platform failures.
10. Explain current impact and likely downstream impact.
11. Rank solutions with risk, effort, verification, and rollback.
12. Write a complete report only to the Guardian Sheet tab.
13. Request approval before external consultation.
14. Expose no mutation tool or arbitrary remote command.
15. Preserve a complete local audit trail.

## 23. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Local model gives plausible but wrong diagnosis | Evidence citations, multiple hypotheses, confidence labels, external escalation |
| Old conversation conflicts with current code | Source priority and Git-aware retrieval |
| Rejected idea becomes active rule | Candidate-memory approval workflow |
| Secrets enter memory or model prompt | Source exclusions, redaction, tests, deny-list |
| AI laptop sleeps | Posting-laptop observer and durable event queue |
| Observer harms posting performance | Lightweight sampling, bounded I/O, resource budget |
| Same event creates many Sheet rows | Stable incident IDs and deduplication |
| Connection exposes production laptop | Private network, narrow endpoints, authentication, no shell |
| External model receives too much data | Owner approval and sanitized context package |
| Storage fills the AI laptop | Size limits, retention policy, image rotation, free-space monitoring |
| 7B/8B model is not capable enough | Repository-specific benchmark and approved expert escalation |
| Sheet report function edits workflow data | Separate credentials/scope where possible and strict tab allow-list |

## 24. Cost Model

Level 1 can be built primarily with free and open-source software.

Expected direct software cost:

- Ollama: free local runtime.
- Node.js control center and local JSON/JSONL stores: built from existing free runtime components.
- Existing Playwright, Git, GitHub, and Google Sheets setup: already present.
- Tailscale: may fit its current free plan; verify limits at implementation time.
- WireGuard: free alternative.

Non-zero practical costs:

- Electricity and device uptime.
- Disk usage for models, indexes, logs, and screenshots.
- Existing Claude, Codex, or GPT subscriptions when consulted.
- Optional future cloud GPU if fine-tuning is ever approved.

With about 52 GB currently free, Level 1 should reserve a storage budget and avoid downloading many large models simultaneously.

## 25. Operations and Maintenance

### Daily

- Review open incidents in the Guardian Sheet.
- Review the 18:30 total and major summary.
- Approve, reject, or edit candidate decisions when needed.

### Weekly

- Review recurring warnings and false positives.
- Confirm storage, queue, and index health.
- Review model performance and unresolved low-confidence incidents.

### Monthly

- Re-evaluate detection thresholds.
- Audit permissions and endpoint allow-lists.
- Test secret redaction.
- Replay a historical incident.
- Review memory supersession and stale policies.

### After code changes

- Reindex changed files.
- Record the new Git commit.
- Re-run affected retrieval and diagnostic tests.
- Confirm production observer compatibility.

## 26. Future Levels

### Level 2 - Approved execution assistant

- Prepare patches and commands.
- Execute only one explicitly approved action.
- Verify and report results.
- Maintain rollback instructions.

### Level 3 - Limited autonomous recovery

- Only owner-approved, allow-listed, reversible actions.
- Examples may include refreshing a read-only health probe or restarting a specifically approved non-posting helper.
- Publishing and credential actions remain protected.

### Level 4 - Personal behavior adaptation

- Train or fine-tune only on owner-approved examples.
- Focus on stable reasoning style and preferences.
- Keep current facts in external memory.

No future level is automatically authorized by successful completion of Level 1.

## 27. Open Decisions

The following remain implementation choices, not unresolved product requirements:

1. Conversation-capture method for each external AI product.
2. Retention period for logs and screenshots.
3. Exact incident-severity scoring formula beyond the two deterministic major rules.
4. Whether the AI laptop should remain awake while plugged in.
5. Exact transport for approved Claude/Codex/GPT consultation after context-package review.

## 28. Final Deliverables

At the end of Level 1, the project should contain:

- Approved architecture and security specification.
- AI control-center service.
- Posting-laptop read-only observer.
- Private two-laptop connection.
- Project knowledge and code-retrieval system.
- Private conversation-memory system.
- Owner approval workflow for active memories.
- Local model benchmark and selection report.
- Diagnostic reasoning engine.
- Dedicated Google Sheet Guardian tab.
- Incident deduplication and lifecycle tracking.
- External-consultation approval package.
- Test suite and historical-incident evaluation set.
- Operations runbook.
- Shadow-operation results and owner acceptance report.

## 29. Final Recommendation

Build Level 1 as an advisory Guardian, not as an autonomous fixer and not as a newly trained LLM.

The highest-value sequence is:

```text
Reliable production evidence
-> current project knowledge
-> private personal memory
-> deterministic incident rules
-> local-model diagnosis
-> owner-facing Sheet reports
-> approved expert consultation
-> shadow evaluation
```

This sequence directly aligns with the desired outcome: a companion that knows the project, remembers how the owner reasons, detects both failures and risks, deeply explains causes and consequences, and recommends appropriate action while preserving complete owner control.
