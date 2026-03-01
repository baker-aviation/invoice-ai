#!/usr/bin/env python3
import os
import subprocess
import traceback
import tempfile
from pathlib import Path
from google.cloud import storage

from fastapi import FastAPI, HTTPException, Query
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
DOCUMENTS_TABLE = os.environ.get("DOCUMENTS_TABLE", "documents")

# Optional controls passed through to process_pdf.py
SCHEMA_PATH = os.environ.get("INVOICE_SCHEMA", "schemas/invoice.schema.json")
MODEL_NAME = os.environ.get("EXTRACTION_MODEL", "gpt-4o-mini")
NO_RESCUE = os.environ.get("NO_RESCUE", "0") in {"1", "true", "True", "yes", "YES"}

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

supa = create_client(SUPABASE_URL, SUPABASE_KEY)

from auth_middleware import add_auth_middleware

app = FastAPI(title="invoice-parser", version=os.environ.get("APP_VERSION", "0.2.0"))
add_auth_middleware(app)
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


def run_cmd(cmd):
    r = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(
            "COMMAND FAILED\n"
            f"cmd={' '.join(cmd)}\n"
            f"exit_code={r.returncode}\n"
            f"stdout:\n{r.stdout}\n"
            f"stderr:\n{r.stderr}\n"
        )
    return r.stdout


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/jobs/parse_document")
def parse_document(document_id: str):
    """
    Cloud Run entrypoint:
    - Lookup document in Supabase (documents table)
    - Download PDF from GCS
    - Run process_pdf.py (extract + validate + persist)
    """
    try:
        # mark processing
        supa.table(DOCUMENTS_TABLE).update(
            {"status": "processing"}
        ).eq("id", document_id).execute()

        # fetch document record (need gcs_bucket + gcs_path)
        doc_res = (
            supa.table(DOCUMENTS_TABLE)
            .select("id,gcs_bucket,gcs_path")
            .eq("id", document_id)
            .limit(1)
            .execute()
        )
        if not doc_res.data:
            raise RuntimeError(f"Document not found: {document_id}")

        doc = doc_res.data[0]
        gcs_bucket = doc.get("gcs_bucket")
        gcs_path = doc.get("gcs_path")

        if not gcs_bucket or not gcs_path:
            raise RuntimeError(
                f"Missing gcs_bucket/gcs_path on documents row for {document_id} "
                f"(gcs_bucket={gcs_bucket}, gcs_path={gcs_path})"
            )

        # create temp work dir
        workdir = Path(tempfile.mkdtemp(prefix=f"parse_{document_id}_"))
        local_pdf = workdir / Path(gcs_path).name
        out_dir = workdir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)

        # download from GCS using official client (no gsutil needed)
        storage_client = storage.Client()
        bucket = storage_client.bucket(gcs_bucket)
        blob = bucket.blob(gcs_path)
        
        if not blob.exists(storage_client):
            raise RuntimeError(f"GCS object not found: gs://{gcs_bucket}/{gcs_path}")
        
        blob.download_to_filename(str(local_pdf))

        # run the end-to-end processor (extract + validate + persist)
        cmd = [
            "python3",
            "process_pdf.py",
            "--pdf", str(local_pdf),
            "--out_dir", str(out_dir),
            "--schema", SCHEMA_PATH,
            "--model", MODEL_NAME,
            "--gcs_bucket", str(gcs_bucket),
            "--gcs_path", str(gcs_path),
            "--source_system", "gcs",
        ]
        if NO_RESCUE:
            cmd.append("--no_rescue")

        run_cmd(cmd)

        # mark complete
        supa.table(DOCUMENTS_TABLE).update(
            {"status": "parsed"}
        ).eq("id", document_id).execute()

        return {"ok": True, "document_id": document_id}

    except Exception as e:
        err = f"{str(e)}\n\nTRACEBACK:\n{traceback.format_exc()}"
        # mark failed
        try:
            supa.table(DOCUMENTS_TABLE).update(
                {
                    "status": "failed",
                    "parse_error": err
                }
            ).eq("id", document_id).execute()
        except Exception:
            # if Supabase update fails, still raise the original error
            pass

        print(f"parse_document error: {err}", flush=True)
        raise HTTPException(status_code=500, detail="parse_document failed")


@app.post("/jobs/parse_next")
def parse_next(
    limit: int = Query(10, ge=1, le=50),
    status: str = Query("uploaded"),
):
    """
    Batch endpoint: claims up to `limit` documents with the given status,
    parses each via parse_document, and returns a summary.
    This is what the Cloud Scheduler 'invoice-parse-next' job calls.
    """
    # Select candidates
    res = (
        supa.table(DOCUMENTS_TABLE)
        .select("id")
        .eq("status", status)
        .order("created_at", desc=False)
        .limit(limit)
        .execute()
    )
    candidate_ids = [r["id"] for r in (res.data or []) if r.get("id")]
    if not candidate_ids:
        return {"claimed": 0, "parsed": 0, "failed": 0, "results": []}

    # Atomically claim each: only succeeds if status hasn't changed
    claimed_ids = []
    for did in candidate_ids:
        try:
            updated = (
                supa.table(DOCUMENTS_TABLE)
                .update({"status": "processing"})
                .eq("id", did)
                .eq("status", status)
                .execute()
            )
            if updated.data:
                claimed_ids.append(did)
        except Exception:
            pass

    parsed = 0
    failed = 0
    results = []
    for did in claimed_ids:
        try:
            parse_document(document_id=did)
            results.append({"document_id": did, "ok": True})
            parsed += 1
        except Exception as e:
            results.append({"document_id": did, "ok": False, "error": str(e)[:300]})
            failed += 1

    return {
        "claimed": len(claimed_ids),
        "parsed": parsed,
        "failed": failed,
        "results": results,
    }