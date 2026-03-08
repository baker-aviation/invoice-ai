#!/usr/bin/env bash
#
# Migration guard — wraps `supabase db push` (or any migration command)
# and prompts for confirmation if the target is the production database.
#
# Usage:
#   bash scripts/migrate-guard.sh            # runs supabase db push
#   bash scripts/migrate-guard.sh diff       # runs supabase db diff
#   bash scripts/migrate-guard.sh <any args> # passes args to supabase

set -euo pipefail

# Load .env.local if it exists (for local dev)
ENV_FILE="$(dirname "$0")/../invoice-dashboard/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ENV_FILE" | grep 'SUPABASE' | xargs)
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"

if [[ -z "$SUPABASE_URL" ]]; then
  echo "ERROR: NEXT_PUBLIC_SUPABASE_URL is not set."
  exit 1
fi

# Check if this is the production Supabase instance
PROD_HOST="vpgtwlbrfkvxszdpeswh.supabase.co"
if echo "$SUPABASE_URL" | grep -q "$PROD_HOST"; then
  echo ""
  echo "  =============================================="
  echo "  WARNING: You are about to run a migration"
  echo "  against the PRODUCTION database!"
  echo ""
  echo "  URL: $SUPABASE_URL"
  echo "  =============================================="
  echo ""
  read -rp "  Type 'production' to confirm: " CONFIRM
  if [[ "$CONFIRM" != "production" ]]; then
    echo "  Aborted."
    exit 1
  fi
  echo ""
fi

# Default to `db push` if no args given
CMD="${*:-db push}"
echo "Running: supabase $CMD"
exec supabase $CMD
