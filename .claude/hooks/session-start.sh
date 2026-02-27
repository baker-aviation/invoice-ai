#!/bin/bash
set -euo pipefail

# Only run in Claude Code remote (web) sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

SA_KEY="/home/user/gcloud-sa-key.json"

# Activate gcloud service account credentials from the persistent volume.
# The key file is stored outside the ephemeral container filesystem so it
# survives session restarts.
if [ -f "$SA_KEY" ]; then
  gcloud auth activate-service-account --key-file="$SA_KEY" --quiet
  # Also set ADC so Python SDKs (google-cloud-storage, etc.) pick it up
  echo "export GOOGLE_APPLICATION_CREDENTIALS=$SA_KEY" >> "$CLAUDE_ENV_FILE"
  echo "gcloud: credentials activated from $SA_KEY"
else
  echo "WARNING: $SA_KEY not found — gcloud will not be authenticated this session."
  echo "One-time setup (after gcloud auth login):"
  echo "  gcloud iam service-accounts list --project=invoice-ai-487621"
  echo "  gcloud iam service-accounts keys create $SA_KEY --iam-account=<SA_EMAIL>"
fi

# Ensure dashboard node_modules are up to date
cd "$CLAUDE_PROJECT_DIR/invoice-dashboard"
npm install --prefer-offline --silent
echo "npm: dashboard dependencies ready"
