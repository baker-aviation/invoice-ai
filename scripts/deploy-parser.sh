#!/usr/bin/env bash
set -euo pipefail

# ---- Config ----
PROJECT_ID="${PROJECT_ID:-invoice-ai-487621}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-invoice-parser}"
SOURCE_DIR="${SOURCE_DIR:-./invoice-parser}"

echo "Deploying ${SERVICE_NAME} from ${SOURCE_DIR} to ${REGION} (project: ${PROJECT_ID})..."

# ---- Deploy ----
gcloud run deploy "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --source "${SOURCE_DIR}" \
  --platform managed \
  --no-allow-unauthenticated \
  --cpu 1 \
  --memory 512Mi \
  --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest,SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest"

echo "✅ Deployment complete."