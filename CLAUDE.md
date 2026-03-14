# Invoice AI — Project Context

## CRITICAL: Git Workflow & Production Deploy Rules

### Branch strategy
- **`main`** = production. Pushing/merging to `main` triggers a Vercel deploy automatically.
- **`dev`** = integration branch. All completed work merges here first.
- **`claude/...`** = feature/fix branches. All development happens here.

### Workflow
1. Develop on a `claude/...` feature branch.
2. At end of session (with user approval), merge the feature branch into `dev`.
3. **NEVER** merge `dev` into `main` or push to `main` without explicit user permission.
4. **NEVER** run `bash scripts/deploy-*.sh` (Cloud Run production) without explicit user permission.
5. If the user asks "how do I deploy", explain the steps but **do not run them** — wait for the user to confirm.
6. When the user says to push to production, create a PR from `dev` → `main` and confirm before merging.

## What this is
Internal dashboard for Baker Aviation. Processes invoice PDFs from Outlook email,
parses them with AI, generates fee alerts, and displays everything in a Next.js dashboard.
A second pipeline handles job applications (resumes) from email.

## Stack
- **Frontend**: Next.js 16 on Vercel (`invoice-dashboard/`)
- **Backend**: Python FastAPI services on Google Cloud Run
- **Storage**: GCS bucket for PDFs
- **Database**: Supabase (Postgres)
- **Email**: Microsoft Graph API (Outlook)
- **GCP Project**: `invoice-ai-487621` / project number `116257952438`
- **Region**: `us-central1`

## Services

| Directory | Cloud Run name | Purpose |
|-----------|---------------|---------|
| `invoice-ingest/` | `invoice-ingest` | Pulls PDF invoices from Outlook → GCS + Supabase |
| `invoice-parser/` | `invoice-parser` | Parses PDFs via OpenAI, extracts invoice fields |
| `invoice-alerts/` | `invoice-alerts` | Creates alert rows, flushes to Slack |
| `job-ingest/` | `job-ingest` | Pulls job application emails → GCS + Supabase |
| `job-parse/` | `job-parse` | Parses resumes via OpenAI |
| `ops-monitor/` | `ops-monitor` | Flight schedule sync, EDCT email pull, NOTAM checks |

## Invoice pipeline (automated via Cloud Scheduler, every 15 min)
1. `invoice-ingest POST /jobs/pull_mailbox` — Outlook → GCS + Supabase (status=uploaded)
2. `invoice-ingest POST /jobs/parse_next` — uploaded → parsed
3. `invoice-alerts POST /jobs/run_alerts_next` — parsed → alert rows
4. `invoice-alerts POST /jobs/flush_alerts` — alerts → Slack (**currently PAUSED** — repeat alert bug TBD)

## Ops monitor pipeline (every 5–30 min)
1. `ops-monitor POST /jobs/sync_schedule` — JetInsight ICS → `flights` table (every 30 min)
2. `ops-monitor POST /jobs/pull_edct` — ForeFlight@baker-aviation.com → `ops_alerts` (every 5 min)
3. `ops-monitor POST /jobs/check_notams` — FAA NOTAM API → `ops_alerts` (every 30 min)

## Job applications pipeline (hourly)
1. `job-ingest POST /jobs/pull_applicants` — Outlook → GCS + Supabase
2. `job-parse POST /jobs/parse_next` — resumes → OpenAI extraction

## Multi-Agent System (`agents/`)

AI agent orchestration layer built with the [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk) (`@anthropic-ai/sdk`).
Exposed via `POST /api/agents` in the dashboard.

**Requires** `ANTHROPIC_API_KEY` env variable.

### Agent roles

| Role | Purpose |
|------|---------|
| `code-writer` | Full-stack engineer — Next.js, Supabase, GCP |
| `code-reviewer` | Code quality, patterns, TypeScript correctness |
| `security-auditor` | Vulnerability scanning — injection, auth, data exposure, RLS bypasses |
| `database-agent` | Supabase schema, RLS policies, migrations |
| `testing-agent` | Vitest, React Testing Library, Playwright tests |

### Execution modes

| Mode | Behavior |
|------|----------|
| `single` | Run one agent on the input |
| `parallel` | Run multiple agents concurrently on the same input |
| `pipeline` | Run agents sequentially — each step's output feeds the next |
| `auto` | Route to agent(s) or pipeline based on input keywords |

### Built-in pipelines

| Pipeline | Steps |
|----------|-------|
| `full-review` | code-writer → code-reviewer → security-auditor |
| `db-first` | database-agent → code-writer → testing-agent |
| `security-hardening` | security-auditor → code-writer → security-auditor |
| `write-and-test` | code-writer → testing-agent |

### Files

- `agents/types.ts` — Type definitions (AgentConfig, AgentResult, PipelineConfig, etc.)
- `agents/agents.ts` — Agent configs with specialized system prompts
- `agents/client.ts` — Anthropic SDK wrapper with parallel execution support
- `agents/orchestrator.ts` — Execution modes, pipeline runner, auto-router
- `agents/index.ts` — Barrel exports
- `invoice-dashboard/src/app/api/agents/route.ts` — Next.js API route (`GET` lists agents/pipelines, `POST` runs orchestrator)

## Key commands

### View dashboard locally
```bash
cd ~/src/invoice-ai && git stash && git pull --rebase origin claude/check-gcs-github-push-gqC1E && cd invoice-dashboard && npm run dev
```

### Deploy alerts service (after backend changes)
```bash
cd ~/src/invoice-ai && bash scripts/deploy-alerts.sh
```

### Deploy other services
```bash
bash scripts/deploy-ingest.sh
bash scripts/deploy-parser.sh
bash scripts/deploy-ops.sh
```

### Manage Cloud Scheduler
```bash
gcloud scheduler jobs list --project invoice-ai-487621 --location us-central1
gcloud scheduler jobs run invoice-pull-mailbox --project invoice-ai-487621 --location us-central1
```

## Frontend routes
- `/` — Home dashboard (card links to each section)
- `/ops` — Operations: flight schedule + EDCT/NOTAM alerts
- `/invoices` — Invoice list
- `/invoices/[document_id]` — Invoice detail + PDF link
- `/alerts` — Fee alerts table (pagination, Send to Slack button)
- `/jobs` — Job applications list
- `/jobs/[id]` — Job application detail + resume files
- `/api/agents` — Multi-agent orchestrator (`GET` = list agents/pipelines, `POST` = run)

## Environment variables
Frontend (`.env.local`):
- `INVOICE_API_BASE_URL` — invoice-alerts Cloud Run URL
- `JOB_API_BASE_URL` — job-parse Cloud Run URL
- `OPS_API_BASE_URL` — ops-monitor Cloud Run URL
- `ANTHROPIC_API_KEY` — required for the multi-agent system (`/api/agents`)

Backend secrets in GCP Secret Manager: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SLACK_WEBHOOK_URL`, `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
`OUTLOOK_SHARED_MAILBOX`, `GCS_BUCKET`, `OPENAI_API_KEY`,
`JETINSIGHT_ICS_URL`, `FAA_CLIENT_ID`, `FAA_CLIENT_SECRET`

## Deployment policy

- **Frontend (Vercel)**: Pushes to `dev` auto-deploy to `baker-ai-dev.vercel.app`. Pushes to `main` deploy to production (`baker-ai-gamma.vercel.app`). **Always push to `dev` first** — never push directly to `main` unless explicitly told to.
- **Backend (Cloud Run)**: **Do NOT deploy backend services unless explicitly asked.** Deploy scripts exist in `scripts/` but should only be run when the user says "deploy" or "ship it". Code changes to Python services are safe to commit and push — they don't auto-deploy.
- **Branch workflow**: Develop on feature branches → merge to `dev` → test on dev URL → merge to `main` only when approved.

## Active branch
`claude/check-gcs-github-push-gqC1E`

## Service URLs (real Cloud Run URLs from `gcloud run services describe`)
- `invoice-ingest`: `https://invoice-ingest-hrzd5jf3da-uc.a.run.app`
- Note: `gcloud run deploy` reports a `{project-number}.{region}.run.app` URL that returns GFE 404 — use the `hrzd5jf3da` URL instead.
- `/healthz` is intercepted by Cloud Run's GFE and returns 404; use `/debug/env` to verify env + Supabase connectivity.

## Security

- **Never commit API keys or secrets.** All secrets go in `.env.local` (frontend) or GCP Secret Manager (backend). The `.gitignore` covers `.env`, `.env.local`, and `.env*.local`.
- **Agent system prompts must stay in env vars.** The 5 agent prompts are loaded from `AGENT_PROMPT_CODE_WRITER`, `AGENT_PROMPT_CODE_REVIEWER`, `AGENT_PROMPT_SECURITY_AUDITOR`, `AGENT_PROMPT_DATABASE_AGENT`, and `AGENT_PROMPT_TESTING_AGENT`. Never hardcode prompts in source — this repo is public.
- **The `/api/agents` route requires admin auth.** Only authenticated Supabase users with `role: "admin"` in their `app_metadata` or `user_metadata` can invoke agents. The route also enforces a rate limit of 10 requests per minute per user.
- **Input validation.** All agent requests are validated with Zod — input is capped at 10,000 characters to limit prompt injection surface and cost.

## Communication style
- **Humor and sarcasm at 90%.** Be witty, roast bad code, crack jokes. Charlie can take it. Keep it fun.
- Still be precise and correct — just deliver it with personality.

## Known issues / TODO
- `invoice-alerts-flush` Cloud Scheduler job is **paused** — alerts were sending duplicates to Slack. Needs dedup investigation in `invoice-alerts/main.py` `flush_alerts()` before re-enabling.
