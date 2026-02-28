#!/usr/bin/env python3
"""One-time cleanup: delete NOTAM alerts containing noise terms
(ILS, PAPI, ALS, LGT, TWY, APRON, windcone) from ops_alerts table.

Usage:
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python3 scripts/cleanup-noise-notams.py

Or fetch creds from GCP Secret Manager automatically:
  python3 scripts/cleanup-noise-notams.py
"""

import os
import re
import sys

# Try to fetch Supabase creds from GCP Secret Manager if not in env
url = os.environ.get("SUPABASE_URL", "").strip()
key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

if not url or not key:
    try:
        from google.cloud import secretmanager
        client = secretmanager.SecretManagerServiceClient()
        project = "invoice-ai-487621"
        url = client.access_secret_version(
            name=f"projects/{project}/secrets/SUPABASE_URL/versions/latest"
        ).payload.data.decode()
        key = client.access_secret_version(
            name=f"projects/{project}/secrets/SUPABASE_SERVICE_ROLE_KEY/versions/latest"
        ).payload.data.decode()
        print("Loaded Supabase creds from GCP Secret Manager")
    except Exception as e:
        print(f"Could not load creds from GCP: {e}")
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars")
        sys.exit(1)

from supabase import create_client

sb = create_client(url, key)

NOISE = re.compile(
    r"\bILS\b|\bPAPI\b|\bALS\b|\bLGT\b|\bLIGHT\b|\bTWY\b|\bTAXIWAY\b"
    r"|\bAPRON\b|\bWINDCONE\b|\bWIND\s*CONE\b",
    re.IGNORECASE,
)

# Fetch all NOTAM alerts
print("Fetching NOTAM alerts from ops_alerts...")
rows = (
    sb.table("ops_alerts")
    .select("id, alert_type, subject, body")
    .like("alert_type", "NOTAM%")
    .execute()
    .data
)
print(f"Found {len(rows)} total NOTAM alerts")

# Find noise matches
to_delete = []
for r in rows:
    text = f"{r.get('subject', '')} {r.get('body', '')}"
    if NOISE.search(text):
        to_delete.append(r)

print(f"Found {len(to_delete)} noise NOTAMs to delete:")
for r in to_delete:
    subj = (r.get("subject") or "")[:80]
    body = (r.get("body") or "")[:80]
    print(f"  [{r['id'][:8]}] {subj} — {body}")

if not to_delete:
    print("Nothing to delete.")
    sys.exit(0)

confirm = input(f"\nDelete {len(to_delete)} rows? (y/N): ").strip().lower()
if confirm != "y":
    print("Aborted.")
    sys.exit(0)

ids = [r["id"] for r in to_delete]
# Delete in batches of 50
for i in range(0, len(ids), 50):
    batch = ids[i : i + 50]
    sb.table("ops_alerts").delete().in_("id", batch).execute()
    print(f"  Deleted batch {i // 50 + 1} ({len(batch)} rows)")

print("Done!")
