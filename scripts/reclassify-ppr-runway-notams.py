#!/usr/bin/env python3
"""One-time fix: reclassify NOTAM_PPR alerts that are actually runway closures.

NOTAMs like "RWY 14/32 CLSD EXC TAX 30MIN PPR 617-561-1919" were classified as
NOTAM_PPR because the classifier checked PPR before RWY.  These should be
NOTAM_RUNWAY so the frontend runway-suppression filter works correctly.

Usage:
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python3 scripts/reclassify-ppr-runway-notams.py

Or fetch creds from GCP Secret Manager automatically:
  python3 scripts/reclassify-ppr-runway-notams.py
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

RWY_PATTERN = re.compile(r"\bRWY\b|RUNWAY", re.IGNORECASE)

# Fetch all NOTAM_PPR alerts
print("Fetching NOTAM_PPR alerts from ops_alerts...")
rows = (
    sb.table("ops_alerts")
    .select("id, alert_type, subject, body")
    .eq("alert_type", "NOTAM_PPR")
    .execute()
    .data
)
print(f"Found {len(rows)} NOTAM_PPR alerts")

# Find ones that mention RWY/RUNWAY — these should be NOTAM_RUNWAY
to_fix = []
for r in rows:
    text = f"{r.get('subject', '')} {r.get('body', '')}"
    if RWY_PATTERN.search(text):
        to_fix.append(r)

print(f"Found {len(to_fix)} misclassified as PPR (should be NOTAM_RUNWAY):")
for r in to_fix:
    body = (r.get("body") or "")[:100]
    print(f"  [{r['id'][:8]}] {body}")

if not to_fix:
    print("Nothing to fix.")
    sys.exit(0)

confirm = input(f"\nReclassify {len(to_fix)} rows to NOTAM_RUNWAY? (y/N): ").strip().lower()
if confirm != "y":
    print("Aborted.")
    sys.exit(0)

for r in to_fix:
    sb.table("ops_alerts").update({"alert_type": "NOTAM_RUNWAY"}).eq("id", r["id"]).execute()
    print(f"  Updated {r['id'][:8]}")

print("Done!")
