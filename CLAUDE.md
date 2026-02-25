# Invoice AI — Project Context

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

## Invoice pipeline (automated via Cloud Scheduler, every 15 min)
1. `invoice-ingest POST /jobs/pull_mailbox` — Outlook → GCS + Supabase (status=uploaded)
2. `invoice-ingest POST /jobs/parse_next` — uploaded → parsed
3. `invoice-alerts POST /jobs/run_alerts_next` — parsed → alert rows
4. `invoice-alerts POST /jobs/flush_alerts` — alerts → Slack (**currently PAUSED** — repeat alert bug TBD)

## Job applications pipeline (hourly)
1. `job-ingest POST /jobs/pull_applicants` — Outlook → GCS + Supabase
2. `job-parse POST /jobs/parse_next` — resumes → OpenAI extraction

## Key commands

### View dashboard locally
```bash
cd ~/src/invoice-ai && git pull --rebase origin claude/check-gcs-github-push-gqC1E && cd invoice-dashboard && npm run dev
```

### Deploy alerts service (after backend changes)
```bash
cd ~/src/invoice-ai && bash scripts/deploy-alerts.sh
```

### Deploy other services
```bash
bash scripts/deploy-ingest.sh
bash scripts/deploy-parser.sh
```

### Manage Cloud Scheduler
```bash
gcloud scheduler jobs list --project invoice-ai-487621 --location us-central1
gcloud scheduler jobs run invoice-pull-mailbox --project invoice-ai-487621 --location us-central1
```

## Frontend routes
- `/` — Home dashboard (card links to each section)
- `/invoices` — Invoice list
- `/invoices/[document_id]` — Invoice detail + PDF link
- `/alerts` — Fee alerts table (pagination, Send to Slack button)
- `/jobs` — Job applications list
- `/jobs/[id]` — Job application detail + resume files

## Environment variables
Frontend (`.env.local`):
- `INVOICE_API_BASE_URL` — invoice-alerts Cloud Run URL
- `JOB_API_BASE_URL` — job-parse Cloud Run URL

Backend secrets in GCP Secret Manager: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SLACK_WEBHOOK_URL`, `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`,
`OUTLOOK_SHARED_MAILBOX`, `GCS_BUCKET`, `OPENAI_API_KEY`

## Active branch
`claude/check-gcs-github-push-gqC1E`

## Known issues / TODO
- `invoice-alerts-flush` Cloud Scheduler job is **paused** — alerts were sending duplicates to Slack. Needs dedup investigation in `invoice-alerts/main.py` `flush_alerts()` before re-enabling.
