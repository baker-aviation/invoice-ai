#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-invoice-ai-487621}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-invoice-ingest}"
SOURCE_DIR="${SOURCE_DIR:-./invoice-ingest}"

echo "Deploying ${SERVICE_NAME} from ${SOURCE_DIR} to ${REGION} (project: ${PROJECT_ID})..."

gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --source "${SOURCE_DIR}" \
  --platform managed \
  --allow-unauthenticated \
  --cpu 1 \
  --memory 512Mi \
  --timeout 300 \
  --max-instances 3 \
  --set-env-vars "PARSER_BASE_URL=https://invoice-parser-116257952438.us-central1.run.app" \
  --set-secrets "SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,MS_TENANT_ID=MS_TENANT_ID:latest,MS_CLIENT_ID=MS_CLIENT_ID:latest,MS_CLIENT_SECRET=MS_CLIENT_SECRET:latest,OUTLOOK_SHARED_MAILBOX=OUTLOOK_SHARED_MAILBOX:latest,GCS_BUCKET=GCS_BUCKET:latest" \
  --update-annotations "run.googleapis.com/startup-cpu-boost=true"

echo "✅ Deployment complete."