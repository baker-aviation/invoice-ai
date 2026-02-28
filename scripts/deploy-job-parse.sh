#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-invoice-ai-487621}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-job-parse}"
SOURCE_DIR="${SOURCE_DIR:-./job-parse}"

echo "Deploying ${SERVICE_NAME} from ${SOURCE_DIR} to ${REGION} (project: ${PROJECT_ID})..."

# Clear GCS_BUCKET if it was previously set as a plain env var (can't mix types)
gcloud run services update "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --remove-env-vars GCS_BUCKET 2>/dev/null || true

gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --source "${SOURCE_DIR}" \
  --platform managed \
  --no-allow-unauthenticated \
  --cpu 1 \
  --memory 512Mi \
  --timeout 300 \
  --max-instances 3 \
  --set-secrets "SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,GCS_BUCKET=GCS_BUCKET:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest" \
  --update-annotations "run.googleapis.com/startup-cpu-boost=true"

echo "✅ Deployment complete."
