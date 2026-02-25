#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-invoice-ai-487621}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-invoice-alerts}"
SOURCE_DIR="${SOURCE_DIR:-./invoice-alerts}"

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
  --min-instances 1 \
  --max-instances 20 \
  --set-secrets "SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,SLACK_WEBHOOK_URL=SLACK_WEBHOOK_URL:latest" \
  --update-annotations "run.googleapis.com/startup-cpu-boost=true"

echo "✅ Deployment complete."
