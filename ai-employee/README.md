# Ken Research AI Employee POC

A free, local-first project companion for this repository. Version 1 runs in **Observe mode**: it can retrieve project knowledge, inspect approved files and logs, explain behavior, diagnose errors, and propose fixes. It cannot post content, send messages, modify operational Sheets, edit files, restart services, or access credentials. Its deterministic observer may append reports only to the dedicated `AI Guardian` tab.

## How it works

1. `ingest.mjs` reads approved project files plus exports placed in `imports/`.
2. Secrets are redacted before content enters the index.
3. Files are split into line-addressable chunks and indexed for exact/keyword retrieval.
4. If Ollama and the embedding model are available, semantic embeddings are added locally.
5. The chat server retrieves likely evidence before every question.
6. The local model can call five narrowly scoped, read-only tools for follow-up inspection.
7. Every conversation and tool invocation is written to a local audit journal.

```text
Repository + conversation exports + approved logs
                    |
              local ingestion
                    |
        lexical index + optional embeddings
                    |
         Ollama local reasoning model
                    |
          read-only evidence tools
                    |
       answer + citations + audit record
```

## Free software required

- **Node.js 20+**: already installed on this machine.
- **Ollama for Windows**: free local model runtime. Download from <https://ollama.com/download/windows>.
- **A browser**: the dashboard is served locally; no cloud account is required.
- **Git**: already used by this repository.

No Docker, hosted vector database, paid API, browser extension, or cloud model is required for the POC.

## Setup

```powershell
npm run employee:setup
ollama pull qwen3:4b
ollama pull nomic-embed-text
npm run employee:index
npm run employee:start
```

Open <http://127.0.0.1:3210>.

The default `qwen3:4b` was selected for this 16 GB RAM / 4 GB GPU laptop after `qwen3:8b` exceeded the operational latency budget. The 8B model can still be selected for an owner-approved deep investigation:

```powershell
$env:AI_EMPLOYEE_MODEL = 'your-installed-model'
npm run employee:start
```

The right final reasoning model must be selected after checking RAM/GPU and running the repository-specific evaluation set.

## Importing ChatGPT and Claude history

Place exported `.json`, `.md`, or `.txt` files in `ai-employee/imports/`, then rebuild the index. The importer recognizes common ChatGPT `mapping`, Claude `chat_messages`, and generic `messages` JSON shapes. Original exports remain untouched.

```powershell
npm run employee:index
```

Imported conversations are treated as historical evidence. Current source code outranks old conversations and documents when they conflict.

Every conversation held in the local dashboard is appended automatically to the private `data/audit.jsonl` journal. Imported ChatGPT and Claude conversations still require an export or connector; the POC does not scrape personal web sessions.

For an owner-approved Claude or Codex consultation, prepare a redacted evidence package locally:

```powershell
npm run employee:context -- "describe the incident"
```

This writes an ignored file under `data/context-packs/`. It does not contact an external service.

## Available tools

| Tool | Purpose | Access |
|---|---|---|
| `search_knowledge` | Search code, docs, fixes, errors, and conversations | Read only |
| `read_project_file` | Read an approved project file with line numbers | Read only |
| `search_project` | Search exact text or regex across approved files | Read only |
| `inspect_runtime_status` | Check safe existence/timestamps for heartbeat and state files | Metadata only |
| `read_recent_errors` | Inspect approved runtime/error/fix logs | Read only |

The path policy blocks `.env`, `.accounts`, `.sessions`, keys, certificates, service-account files, `node_modules`, and paths outside the repository. Runtime inspection exposes only existence, timestamps, and sizes for selected files.

## Stored local data

Generated files are ignored by Git:

- `data/knowledge-index.json`: chunks, search terms, and optional embeddings
- `data/audit.jsonl`: questions, answers, citations, and tool events
- `imports/`: conversation exports supplied by the owner

Nothing is uploaded by this POC. Ollama receives prompts through `127.0.0.1` only.

## POC boundaries

This version deliberately excludes write tools. The next stage should add a proposal/approval queue before any mutation tool exists. A future action must be assigned one of these policies:

- `observe`: run automatically because it cannot change state
- `approve`: prepare the exact action and wait for owner approval
- `prohibited`: never expose it to the model

Posting, emailing, deleting, credential changes, schedule changes, bulk retries, and account/session operations remain prohibited until they have explicit policy, verification, rollback, and evaluation coverage.

## Two-laptop observer

The posting laptop runs `observer.mjs`. It reads only the production heartbeat, daily counters, slot ledger, and approved error logs. Findings are queued locally, reported to the dedicated `AI Guardian` Sheet tab, and sent over the private connection to this control center.

1. Copy `observer.config.example.json` to the ignored `observer.config.json` on the posting laptop.
2. Put the control laptop's Tailscale URL and the private `observerSecret` from `config.json` in that file.
3. Run `npm run employee:observe` for a one-shot check.
4. Register `ai-employee/windows/install-observer-task.ps1` to run continuously at sign-in.

The observer never opens a browser, reads login profiles, posts content, restarts the daemon, or changes code. If the control laptop sleeps, its durable outbox holds events until the connection returns.

On the control laptop, `ai-employee/windows/install-control-task.ps1` registers the dashboard to start at sign-in. Windows sleep suspends local inference; keeping this laptop awake during monitoring hours is required for immediate diagnosis.

After Tailscale is installed with Administrator privileges and both laptops are signed into the same tailnet, run `ai-employee/windows/configure-tailscale-control.ps1`. It binds the control center to this laptop's private Tailscale address and prints the URL to place in `observer.config.json`.

## Verification

```powershell
npm run employee:test
node --check ai-employee/server.mjs
node --check ai-employee/ingest.mjs
```

Official Ollama references used by this POC: [Windows installation](https://ollama.com/download/windows), [chat API](https://docs.ollama.com/api/chat), [embedding API](https://docs.ollama.com/api/embed), and [tool calling](https://docs.ollama.com/capabilities/tool-calling).
