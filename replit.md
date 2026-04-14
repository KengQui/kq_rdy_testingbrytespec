# Bryte AI — Before & After Demo

## Project Overview
A demo showcasing the impact of a "behavioral specification" on Bryte AI (the UKG Ready AI Assistant). It renders two side-by-side chat panels powered by the Google Gemini API — one without behavioral rules and one with — so users can compare responses to the same prompt. After both panels respond, a diff view analyzes routing decisions, spec rule impact, and conversation design principles.

Source repo: https://github.com/UKG-Sandbox/kq_rdy_bryte.git

## Tech Stack
- **Frontend:** Pure HTML5, CSS3, Vanilla JavaScript (no framework, no build step)
- **Backend:** Node.js + Express (API proxy server)
- **Database:** PostgreSQL (Replit built-in) — use cases and cache persist across deployments
- **AI:** Google Gemini 2.5 Flash via Google AI Studio endpoint (`generativelanguage.googleapis.com`)
- **Secrets:** API key can be entered via browser UI or stored as Replit Secret (server-side)

## Project Structure
```
index.html                              — Frontend application (styles, markup, system prompts, diff view, JS logic)
eval.html                               — Eval testing UI: sidebar with 38 use cases, per-case test page with chat + pass/fail verdicts
server.js                               — Express backend: serves static files + proxies Gemini API calls
agents-data.json                        — 15 mock agent objects (employee data for simulated agents)
config/orchestrator-raw-schema.txt      — Full raw agent schema from RdySupervisorUS2DEV v0.0.59 (924 lines)
package.json                            — Node.js dependencies (express)
bryte.config.js.example                 — Example config for local API key injection
use-cases.json                          — 38 eval use cases across 6 scorecards
config/agents/includes/AgentBehavior.md — Behavioral rules injected into agent prompts
config/agents/includes/OrchestratorRules.md — Behavioral rules injected into orchestrator prompt (prepended to After panel)
config/agents/includes/WriteActions.md  — Write action confirmation rules for write-capable agents
config/agents/includes/SecurityRules.md — Security rules (IP-restricted, not available)
config/orchestrator-backup-v6.1.63.js   — Backup of pre-sync orchestrator prompts (for rollback)
.revision-checklist.md                  — Revision tracking checklist
.session-notes-compound.md              — Session notes for compound intent feature
```

## Architecture
- The frontend can call Gemini API directly (client-side key via setup overlay) or via `/api/gemini` proxy
- The backend injects the `GEMINI_API_KEY` from environment and proxies the request to Google's AI Studio endpoint
- `/api/config` endpoint tells the frontend whether the server is properly configured
- Two-step orchestration: Step 1 routes via an orchestrator prompt, Step 2 delegates to a mock agent or handles directly
- After both panels respond, a diff view runs three parallel AI analyses: routing comparison, spec rule impact, and conversation design principles
- Behavioral spec includes are loaded from `config/agents/includes/` at startup

## Key Features
- Side-by-side chat panels (Without vs With behavioral spec)
- Real orchestrator routing with JSON contract
- 15 simulated agents with realistic HR/workforce data (loaded from agents-data.json)
- Full production agent list (~67 agents from RdySupervisorUS2DEV v0.0.59) — unsimulated agents show demo message
- Diff view with routing analysis, rule tags, and design principle evaluation
- Suggestion chips for high-impact demo scenarios
- A2UI form rendering for multi-step transactions
- Eval testing sidebar integrated into main page — left sidebar listing use cases grouped by scorecards, click any test to run it in the comparison panels
- Add/delete use cases from the sidebar — "+" button opens inline form with question, title, category selection (existing or new); server generates unique IDs; delete via X icon on each item; empty categories auto-removed; all changes persisted to PostgreSQL database via API (survives deployments)
- "Generate New Conversation" button creates additional run panels below the main ones, each with full conversation UI (input fields, multi-turn chat, independent history tracking)
- Standalone eval page (`/eval.html`) also available as backup at `/eval` route

## Environment Variables (Secrets)
- `GEMINI_API_KEY` — Google AI Studio API key (optional if using client-side key entry)
- `DATABASE_URL` — PostgreSQL connection string (auto-set by Replit)

## Database
- **Tables:** `scorecards`, `use_cases`, `use_case_cache`, `seed_exclusions`
- On every startup, the server runs seed sync from `use-cases.json` — inserts only new IDs, never overwrites existing data
- `seed_exclusions` table tracks IDs deleted on the live site so they aren't re-inserted by future seeds
- All use case CRUD and cache operations go through PostgreSQL, so data persists across deployments
- `POST /api/export-use-cases` exports the current DB state back to `use-cases.json` so the seed file stays up to date for new deployments

## Running
Express server on port 5000:
```
node server.js
```

## Deployment
Configured as **autoscale** deployment with `node server.js` as the run command.
