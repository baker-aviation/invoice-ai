#!/usr/bin/env bash
# Prints a handoff summary to paste into a new Claude Code chat.
set -euo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
LAST_COMMITS=$(git log --oneline -5 2>/dev/null || echo "unavailable")
NOTAM_RESULT=$(curl -s --max-time 10 https://ops-monitor-hrzd5jf3da-uc.a.run.app/debug/notam_token 2>/dev/null || echo "timeout/error")
SYNC_RESULT=$(curl -s --max-time 10 https://ops-monitor-hrzd5jf3da-uc.a.run.app/jobs/sync_schedule 2>/dev/null || echo "timeout/error (sync takes ~60s, run manually)")

cat <<EOF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BAKER AVIATION / invoice-ai  —  new chat handoff
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REPO & BRANCH
  Path:    /home/user/invoice-ai   (Claude Code edits here)
  User's deploy path: ~/src/invoice-ai  (MUST git pull before deploying)
  Branch:  ${BRANCH}

RECENT COMMITS
${LAST_COMMITS}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ISSUE 1 — NOTAM endpoint calls FAA staging URL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Problem:
  ops-monitor /jobs/check_notams calls https://api-sit.cgifederal-aim.com
  instead of the production FAA NMS API https://api-nms.aim.faa.gov

Root cause identified:
  • Cloud Run service config had NMS_AUTH_URL=https://api-sit.cgifederal-aim.com/...
    baked in from original setup.
  • --remove-env-vars in gcloud run deploy does NOT clear it (wrong command).
  • All our fixes were committed to /home/user/invoice-ai but the user deploys
    from ~/src/invoice-ai — a separate checkout that was never pulled.
    So every deploy used old code that still read the env var.

Fix committed (needs user to pull + redeploy):
  ops-monitor/main.py line 28-30 now has:
    NMS_AUTH_URL = "https://api-nms.aim.faa.gov/v1/auth/token"   ← literal, no os.getenv
    NMS_API_BASE = "https://api-nms.aim.faa.gov/nmsapi"          ← literal, no os.getenv
  No env var can override it.

Current live status:
  ${NOTAM_RESULT}

Next step:
  cd ~/src/invoice-ai && git pull origin ${BRANCH} && bash scripts/deploy-ops.sh
  Then: curl -s https://ops-monitor-hrzd5jf3da-uc.a.run.app/debug/notam_token
  Expected: either {"ok":true,...} or 401 from api-nms.aim.faa.gov (not api-sit)
  If still 401 from api-nms: FAA_CLIENT_ID/FAA_CLIENT_SECRET in Secret Manager
  may be staging-only credentials — check with FAA NMS API registration.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ISSUE 2 — Flights disappearing after every deploy
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Problem:
  After each deploy the ops dashboard shows 0 flights.

Root cause:
  deploy-ops.sh had --max-time 90 on the post-deploy sync_schedule call.
  New container cold-start takes >90s so the curl timed out silently.
  sync_schedule itself works fine — manually triggered returns
  {"ok":true,"upserted":1707,"skipped":8307}.

Fix committed (needs user to pull + redeploy):
  scripts/deploy-ops.sh now:
    • Uses stable URL https://ops-monitor-hrzd5jf3da-uc.a.run.app
    • Waits 10s after deploy before calling sync_schedule
    • --max-time 180  (was 90)

Current live sync test:
  ${SYNC_RESULT}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KEY FACTS FOR NEW CHAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• GCP project:   invoice-ai-487621 / project number 116257952438
• Region:        us-central1
• ops-monitor stable URL: https://ops-monitor-hrzd5jf3da-uc.a.run.app
• ops-monitor gcloud URL: https://ops-monitor-116257952438.us-central1.run.app
  (both resolve to same service)
• Claude Code Bash tool runs as root ($HOME=/root), NOT as the 'user' account
• User's shell home is /home/user  →  ~/src/invoice-ai = /home/user/src/invoice-ai
• Claude Code working dir is /home/user/invoice-ai  (DIFFERENT checkout)
• ALWAYS remind user: git pull before deploying, or changes won't take effect
• Secrets in GCP Secret Manager (NOT in code):
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MS_TENANT_ID, MS_CLIENT_ID,
    MS_CLIENT_SECRET, JETINSIGHT_ICS_URLS, FAA_CLIENT_ID, FAA_CLIENT_SECRET,
    SAMSARA_API_KEY
• Cloud Scheduler for ops-monitor: sync_schedule every 30min, pull_edct every
  5min, check_notams every 30min
• invoice-alerts flush job is PAUSED (duplicate Slack alerts bug, do not re-enable)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
