#!/usr/bin/env bash
set -e

PROJECT_ID="invoice-ai-487621"
REGION="us-central1"
SERVICE_NAME="invoice-parser"

echo "Deploying $SERVICE_NAME to $REGION in project $PROJECT_ID..."

gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source ./invoice-parser \
  --platform managed \
  --allow-unauthenticated

echo "Deployment complete."
