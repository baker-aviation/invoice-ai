#!/bin/bash
set -euo pipefail

# Only run in Claude Code remote (web) sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Key lives inside the repo dir — the only storage that persists across
# container restarts in both the Claude Code session and the user terminal.
SA_KEY="$CLAUDE_PROJECT_DIR/gcloud-sa-key.json"

# Activate gcloud service account credentials.
if [ -f "$SA_KEY" ]; then
  gcloud auth activate-service-account --key-file="$SA_KEY" --quiet
  # Also set ADC so Python SDKs (google-cloud-storage, etc.) pick it up
  echo "export GOOGLE_APPLICATION_CREDENTIALS=$SA_KEY" >> "$CLAUDE_ENV_FILE"
  echo "gcloud: credentials activated from $SA_KEY"
else
  echo "WARNING: $SA_KEY not found — gcloud will not be authenticated this session."
  echo "One-time setup: copy gcloud-sa-key.json into the repo root (it is gitignored)."
fi

# Ensure dashboard node_modules are up to date
cd "$CLAUDE_PROJECT_DIR/invoice-dashboard"
npm install --prefer-offline --silent
echo "npm: dashboard dependencies ready"
