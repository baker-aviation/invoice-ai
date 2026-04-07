#!/usr/bin/env bash
# Audit all API routes for missing authentication.
# Exits non-zero if any route lacks auth and isn't in the allowlist.

set -euo pipefail

API_DIR="src/app/api"
FAIL=0

# Intentionally public routes (no auth required).
# Add new public routes here with a comment explaining why.
ALLOWLIST=(
  "api/public/"                        # Public forms, interest checks, info sessions
  "api/vans/health"                    # Uptime health check
  "api/invite/route.ts"                # Token-based invite acceptance
  "api/aircraft/webhook/route.ts"      # External FlightAware webhook
  "api/fuel-planning/shared-plan/"     # Token-based shared plan viewer
  "api/fuel-planning/price-history/"   # Used by shareable plan pages (read-only)
  "api/fbo-fees/lookup/route.ts"       # FBO fee lookup for tankering calc (read-only)
  "api/fbo-fees/route.ts"              # FBO fee data from invoices (read-only)
  "api/van/flights/route.ts"           # Van driver page flight refresh (read-only)
  "api/ops/faa-delays/route.ts"        # Proxies public FAA NAS Status XML feed
  "api/ops/flow-controls/route.ts"     # Proxies public FAA flow control data
)

is_allowed() {
  local route="$1"
  for pattern in "${ALLOWLIST[@]}"; do
    if [[ "$route" == *"$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

# Auth patterns that count as "protected"
AUTH_PATTERN="requireAdmin|requireAuth|requireSuperAdmin|requireChiefPilotOrAdmin|verifyCronSecret|CRON_SECRET|x-service-key"

ROUTES=$(find "$API_DIR" -name "route.ts" -type f | sort)
UNPROTECTED=()

for route in $ROUTES; do
  if is_allowed "$route"; then
    continue
  fi

  if ! grep -qE "$AUTH_PATTERN" "$route"; then
    UNPROTECTED+=("$route")
  fi
done

if [ ${#UNPROTECTED[@]} -gt 0 ]; then
  echo "❌ Found ${#UNPROTECTED[@]} API route(s) with no authentication:"
  echo ""
  for r in "${UNPROTECTED[@]}"; do
    echo "  $r"
  done
  echo ""
  echo "Fix: add requireAdmin/requireAuth/verifyCronSecret to each route,"
  echo "or add to the allowlist in scripts/audit-auth.sh if intentionally public."
  FAIL=1
else
  echo "✅ All API routes have authentication (${#ALLOWLIST[@]} allowlisted public routes)."
fi

exit $FAIL
