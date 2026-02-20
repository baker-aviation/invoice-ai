import os, subprocess
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BUCKET = os.environ["GCS_BUCKET"]

supa = create_client(SUPABASE_URL, SUPABASE_KEY)

def find_matches(fname: str):
    pat = f"gs://{BUCKET}/invoices/**/{fname}"
    p = subprocess.run(["gsutil", "ls", "-r", pat], capture_output=True, text=True)
    if p.returncode != 0:
        return []
    return [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]

def to_path(gs_uri: str):
    prefix = f"gs://{BUCKET}/"
    return gs_uri[len(prefix):] if gs_uri.startswith(prefix) else None

res = supa.table("documents") \
    .select("id,attachment_filename,storage_bucket,storage_path,status") \
    .eq("status","uploaded") \
    .execute()

docs = res.data or []
candidates = [
    d for d in docs
    if d.get("attachment_filename") and
       (not d.get("storage_bucket") or not d.get("storage_path"))
]

print(f"candidates={len(candidates)}")

updated = missing = ambiguous = 0

for d in candidates:
    doc_id = d["id"]
    fname = d["attachment_filename"]
    matches = find_matches(fname)

    if len(matches) == 1:
        path = to_path(matches[0])
        supa.table("documents").update({
            "storage_bucket": BUCKET,
            "storage_path": path
        }).eq("id", doc_id).execute()
        updated += 1
        print(f"[ok] {doc_id} -> {path}")
    elif len(matches) == 0:
        missing += 1
        print(f"[miss] {doc_id} fname={fname}")
    else:
        ambiguous += 1
        print(f"[ambig] {doc_id} fname={fname} matches={len(matches)}")

print(f"updated={updated} missing={missing} ambiguous={ambiguous}")
