#!/usr/bin/env bash
# setup-scheduler.sh — creates or updates all Cloud Scheduler jobs for the invoice-ai pipeline.
#
# Run once from your local machine (requires gcloud auth + billing-enabled project).
# Safe to re-run: uses --quiet to skip prompts; existing jobs are updated not recreated.
#
# Usage:
#   INVOICE_MAILBOX=invoices@your-domain.com \
#   JOB_MAILBOX=jobs@your-domain.com \
#   bash scripts/setup-scheduler.sh

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-invoice-ai-487621}"
REGION="${REGION:-us-central1}"
SCHEDULER_REGION="${SCHEDULER_REGION:-us-central1}"
TIME_ZONE="${TIME_ZONE:-America/Chicago}"

# Mailboxes — override via env or edit here
INVOICE_MAILBOX="${INVOICE_MAILBOX:-invoices@baker-aviation.com}"
JOB_MAILBOX="${JOB_MAILBOX:-jobs@baker-aviation.com}"
JOB_ROLE_BUCKET="${JOB_ROLE_BUCKET:-pilot}"

# Derive Cloud Run URLs from known project number / region
PROJECT_NUM="116257952438"
BASE="${REGION}.run.app"
INGEST_URL="https://invoice-ingest-${PROJECT_NUM}.${BASE}"
ALERTS_URL="https://invoice-alerts-${PROJECT_NUM}.${BASE}"
JOB_INGEST_URL="https://job-ingest-${PROJECT_NUM}.${BASE}"
JOB_PARSE_URL="https://job-parse-${PROJECT_NUM}.${BASE}"

# ── Helper ────────────────────────────────────────────────────────────────────
# Creates a scheduler job, or updates it if it already exists.
upsert_job() {
  local name="$1"; shift
  local schedule="$1"; shift
  local uri="$1"; shift

  if gcloud scheduler jobs describe "$name" \
       --project "$PROJECT_ID" --location "$SCHEDULER_REGION" &>/dev/null; then
    echo "  ↻ updating  $name"
    gcloud scheduler jobs update http "$name" \
      --project "$PROJECT_ID" \
      --location "$SCHEDULER_REGION" \
      --schedule "$schedule" \
      --uri "$uri" \
      --http-method POST \
      --time-zone "$TIME_ZONE" \
      --quiet \
      "$@"
  else
    echo "  + creating  $name"
    gcloud scheduler jobs create http "$name" \
      --project "$PROJECT_ID" \
      --location "$SCHEDULER_REGION" \
      --schedule "$schedule" \
      --uri "$uri" \
      --http-method POST \
      --time-zone "$TIME_ZONE" \
      --quiet \
      "$@"
  fi
}

echo ""
echo "=== Invoice AI — Cloud Scheduler Setup ==="
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Timezone: $TIME_ZONE"
echo ""

# ── Invoice pipeline ──────────────────────────────────────────────────────────
echo "── Invoice pipeline"

# Step 1: pull emails from Outlook → GCS + Supabase (status=uploaded)
upsert_job "invoice-pull-mailbox" "*/15 * * * *" \
  "${INGEST_URL}/jobs/pull_mailbox?mailbox=${INVOICE_MAILBOX}&lookback_minutes=20&max_messages=50" \
  --description "Pull invoice PDFs from Outlook mailbox into GCS"

# Step 2: parse uploaded docs via invoice-parser → Supabase (status=parsed)
upsert_job "invoice-parse-next" "*/15 * * * *" \
  "${INGEST_URL}/jobs/parse_next?limit=10&status=uploaded" \
  --description "Parse uploaded invoice documents"

# Step 3: create alert rows from parsed invoices
upsert_job "invoice-run-alerts-next" "*/15 * * * *" \
  "${ALERTS_URL}/jobs/run_alerts_next?limit=10&lookback_minutes=30" \
  --description "Generate alert rows from newly parsed invoices"

# Step 4: flush pending alerts to Slack — kept PAUSED by default to avoid repeat alerts.
# Resume manually once dedup is confirmed: gcloud scheduler jobs resume invoice-alerts-flush ...
upsert_job "invoice-alerts-flush" "*/15 * * * *" \
  "${ALERTS_URL}/jobs/flush_alerts?limit=25" \
  --description "Send actionable alerts to Slack"

echo ""
echo "── Job applications pipeline"

# Step 1: pull job application emails → GCS + Supabase (hourly is sufficient)
upsert_job "job-ingest-pull-applicants" "0 * * * *" \
  "${JOB_INGEST_URL}/jobs/pull_applicants?mailbox=${JOB_MAILBOX}&role_bucket=${JOB_ROLE_BUCKET}&max_messages=50" \
  --description "Pull job application emails from Outlook into GCS"

# Step 2: parse applications via OpenAI → Supabase
upsert_job "job-parse-hourly" "0 * * * *" \
  "${JOB_PARSE_URL}/jobs/parse_next?limit=10" \
  --description "Parse job applications with OpenAI extraction"

echo ""
echo "── Ops monitor pipeline"

# Dynamically fetch the real ops-monitor URL.
# The project-number URL (e.g. 116257952438.us-central1.run.app) returns GFE 404;
# the hashed URL from `services describe` is the only one that works.
OPS_URL=$(gcloud run services describe ops-monitor \
  --project "$PROJECT_ID" --region "$REGION" \
  --format "value(status.url)" 2>/dev/null || true)

if [ -z "$OPS_URL" ]; then
  echo "  WARN: could not determine ops-monitor URL — deploy it first, then re-run this script"
else
  echo "  ops-monitor URL: $OPS_URL"

  # Sync JetInsight ICS feed → flights table (every 30 min)
  upsert_job "ops-sync-schedule" "*/30 * * * *" \
    "${OPS_URL}/jobs/sync_schedule" \
    --description "Sync JetInsight ICS feed into flights table"

  # Pull ForeFlight EDCT / ground-delay emails (every 5 min)
  upsert_job "ops-pull-edct" "*/5 * * * *" \
    "${OPS_URL}/jobs/pull_edct" \
    --description "Pull EDCT and ground delay emails from ForeFlight mailbox"

  # Check FAA NOTAMs for upcoming flight airports (every 30 min)
  upsert_job "ops-check-notams" "*/30 * * * *" \
    "${OPS_URL}/jobs/check_notams" \
    --description "Check FAA NOTAM API for upcoming flight airports"
fi

echo ""
echo "✅ Done. Jobs created/updated in project: $PROJECT_ID"
echo ""
echo "View all jobs:"
echo "  gcloud scheduler jobs list --project $PROJECT_ID --location $SCHEDULER_REGION"
echo ""
echo "Trigger manually:"
echo "  gcloud scheduler jobs run invoice-pull-mailbox --project $PROJECT_ID --location $SCHEDULER_REGION"
