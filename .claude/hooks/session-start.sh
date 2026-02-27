#!/bin/bash
set -euo pipefail

# Only run in Claude Code remote (web) sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Point gcloud's config dir into the repo — the only storage that persists
# across container restarts.  Credentials stored here survive session restarts
# without any manual re-auth.
GCLOUD_CFG="$CLAUDE_PROJECT_DIR/.gcloud-config"
export CLOUDSDK_CONFIG="$GCLOUD_CFG"
echo "export CLOUDSDK_CONFIG=$GCLOUD_CFG" >> "$CLAUDE_ENV_FILE"

if gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>/dev/null | grep -q .; then
  echo "gcloud: credentials active ($(gcloud config get-value account 2>/dev/null))"
else
  echo "WARNING: no active gcloud credentials found in $GCLOUD_CFG"
  echo "One-time setup — run this in the Claude Code terminal:"
  echo "  CLOUDSDK_CONFIG=$GCLOUD_CFG gcloud auth login"
fi

# Ensure dashboard node_modules are up to date
cd "$CLAUDE_PROJECT_DIR/invoice-dashboard"
npm install --prefer-offline --silent
echo "npm: dashboard dependencies ready"
