#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-invoice-ai-487621}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-ops-monitor}"
SOURCE_DIR="${SOURCE_DIR:-./ops-monitor}"

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
  --cpu-boost \
  --startup-probe=initialDelaySeconds=30,timeoutSeconds=10,failureThreshold=5 \
  --set-env-vars "FOREFLIGHT_MAILBOX=ForeFlight@baker-aviation.com" \
  --set-secrets "SUPABASE_URL=SUPABASE_URL:latest,SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest,MS_TENANT_ID=MS_TENANT_ID:latest,MS_CLIENT_ID=MS_CLIENT_ID:latest,MS_CLIENT_SECRET=MS_CLIENT_SECRET:latest,JETINSIGHT_ICS_URLS=JETINSIGHT_ICS_URLS:latest,FAA_CLIENT_ID=FAA_CLIENT_ID:latest,FAA_CLIENT_SECRET=FAA_CLIENT_SECRET:latest,SAMSARA_API_KEY=SAMSARA_API_KEY:latest"

echo "✅ Deployment complete."
echo ""
echo "Next steps:"
echo "  1. Add OPS_API_BASE_URL to invoice-dashboard/.env.local"
echo "  2. Set up Cloud Scheduler jobs (see CLAUDE.md)"
