gcloud run deploy invoice-alerts \
  --region us-central1 \
  --project invoice-ai-487621 \
  --source . \
  --allow-unauthenticated \
  --set-env-vars GCS_BUCKET=invoice-ai-487621-files \
  --set-env-vars SUPABASE_URL=https://vpgtwlbrfkvxszdpeswh.supabase.co \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=SUPABASE_SERVICE_ROLE_KEY:latest