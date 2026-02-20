import os, hashlib, pathlib, asyncio
from google.cloud import storage
from supabase import create_client
import httpx

ALLOWED_EXTS = {".pdf"}  # keep demo clean

def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def upload_to_gcs(content: bytes, filename: str, doc_hash: str):
    bucket_name = os.environ["GCS_BUCKET"]
    client = storage.Client()
    bucket = client.bucket(bucket_name)

    safe_name = filename.replace("/", "_")
    path = f"invoices/{doc_hash}/{safe_name}"
    blob = bucket.blob(path)

    if not blob.exists(client=client):
        blob.upload_from_string(content)

    gs_url = f"gs://{bucket_name}/{path}"
    return bucket_name, path, gs_url

async def parse_doc(document_id: str):
    parser_base = os.environ["PARSER_BASE_URL"].rstrip("/")
    url = f"{parser_base}/jobs/parse_document"
    async with httpx.AsyncClient(timeout=300) as client:
        r = await client.post(url, params={"document_id": document_id})
        r.raise_for_status()
        return r.json()

async def main(folder: str):
    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    p = pathlib.Path(folder)
    files = [f for f in p.glob("**/*") if f.is_file() and f.suffix.lower() in ALLOWED_EXTS]

    print(f"Found {len(files)} files")

    for f in files:
        content = f.read_bytes()
        doc_hash = sha256_hex(content)
        bucket, path, gs_url = upload_to_gcs(content, f.name, doc_hash)

        row = {
            "source": "golden_demo",
            "mailbox": "golden_demo",
            "message_id": None,
            "internet_message_id": None,
            "received_datetime": None,
            "from_email": "golden_demo",
            "subject": f"Golden Demo: {f.name}",
            "attachment_id": None,
            "attachment_filename": f.name,
            "content_type": "application/pdf",
            "size_bytes": len(content),
            "document_hash": doc_hash,
            "status": "uploaded",
            "storage_provider": "gcs",
            "storage_bucket": bucket,
            "storage_path": path,
            "raw_file_url": gs_url,
        }

        # Insert document row (idempotent: document_hash is UNIQUE)
        try:
            ins = supa.table("documents").insert(row).execute()
            doc_id = ins.data[0]["id"]
            inserted = True
        except Exception:
            # Already exists — fetch its id
            got = supa.table("documents").select("id").eq("document_hash", doc_hash).limit(1).execute()
            doc_id = got.data[0]["id"]
            inserted = False

        print(f"{'Inserted' if inserted else 'Exists'}: {f.name} -> {doc_id}")

        # Parse
        try:
            out = await parse_doc(doc_id)
            supa.table("documents").update({"status": "parsed"}).eq("id", doc_id).execute()
            print(f"Parsed OK: {f.name}")
        except Exception as e:
            supa.table("documents").update({"status": "failed", "parse_error": str(e)}).eq("id", doc_id).execute()
            print(f"Parse FAIL: {f.name}: {e}")

if __name__ == "__main__":
    import sys
    folder = sys.argv[1] if len(sys.argv) > 1 else "golden_pdfs"
    asyncio.run(main(folder))
