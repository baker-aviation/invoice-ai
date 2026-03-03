#!/usr/bin/env python3
import os
import subprocess
import traceback
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

import google.auth
import requests as _requests
from google.auth.transport.requests import Request as AuthRequest
from google.auth.iam import Signer
from google.cloud import storage
from google.oauth2 import service_account

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


SIGNED_URL_EXP_MINUTES = int(os.environ.get("SIGNED_URL_EXP_MINUTES", "2880"))  # 2 days


def _get_runtime_service_account_email() -> Optional[str]:
    """Get the Cloud Run service account email from metadata server."""
    env_email = os.environ.get("SIGNING_SERVICE_ACCOUNT_EMAIL")
    if env_email:
        return env_email
    try:
        url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"
        r = _requests.get(url, headers={"Metadata-Flavor": "Google"}, timeout=2)
        if r.status_code == 200:
            return (r.text or "").strip() or None
    except Exception:
        pass
    return None


def _get_gcs_signed_url(gcs_bucket: str, gcs_path: str) -> Optional[str]:
    """Generate a V4 signed URL for a GCS object using IAM SignBlob."""
    if not gcs_bucket or not gcs_path:
        return None
    sa_email = _get_runtime_service_account_email()
    if not sa_email:
        print("[pdf-url] Could not determine service account email", flush=True)
        return None
    try:
        source_creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        auth_req = AuthRequest()
        signer = Signer(auth_req, source_creds, sa_email)
        signing_creds = service_account.Credentials(
            signer=signer,
            service_account_email=sa_email,
            token_uri="https://oauth2.googleapis.com/token",
        )
        client = storage.Client(credentials=source_creds)
        bucket_obj = client.bucket(gcs_bucket)
        blob = bucket_obj.blob(gcs_path)
        url = blob.generate_signed_url(
            version="v4",
            expiration=SIGNED_URL_EXP_MINUTES * 60,
            method="GET",
            credentials=signing_creds,
            response_type="application/pdf",
            response_disposition='inline; filename="invoice.pdf"',
        )
        return url
    except Exception as e:
        print(f"[pdf-url] Signed URL generation failed: {e}", flush=True)
        return None


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/invoices/{document_id}/pdf-url")
def api_invoice_pdf_url(document_id: str) -> Dict[str, Any]:
    """Returns a signed PDF URL for a document."""
    doc_res = (
        supa.table(DOCUMENTS_TABLE)
        .select("id,gcs_bucket,gcs_path")
        .eq("id", document_id)
        .limit(1)
        .execute()
    )
    if not doc_res.data:
        raise HTTPException(status_code=404, detail="Document not found")
    doc = doc_res.data[0]
    signed_pdf_url = _get_gcs_signed_url(
        doc.get("gcs_bucket") or "", doc.get("gcs_path") or ""
    )
    return {"ok": True, "signed_pdf_url": signed_pdf_url}


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


@app.post("/jobs/reparse")
def reparse_document(document_id: str):
    """
    Re-parse a specific document: clears old parsed data and runs extraction again.
    Used to fix categorization, airport codes, or other extraction issues.
    """
    # Verify document exists
    doc_res = (
        supa.table(DOCUMENTS_TABLE)
        .select("id,gcs_bucket,gcs_path,status")
        .eq("id", document_id)
        .limit(1)
        .execute()
    )
    if not doc_res.data:
        raise HTTPException(status_code=404, detail=f"Document not found: {document_id}")

    # Delete existing parsed data for this document
    try:
        # Get parsed_invoice IDs to clean up line items
        pi_res = (
            supa.table("parsed_invoices")
            .select("id")
            .eq("document_id", document_id)
            .execute()
        )
        pi_ids = [r["id"] for r in (pi_res.data or []) if r.get("id")]

        # Delete line items
        if pi_ids:
            for pi_id in pi_ids:
                supa.table("parsed_line_items").delete().eq(
                    "parsed_invoice_id", pi_id
                ).execute()

        # Delete parsed invoices
        supa.table("parsed_invoices").delete().eq(
            "document_id", document_id
        ).execute()

        # Delete old alerts for this document
        supa.table("invoice_alerts").delete().eq(
            "document_id", document_id
        ).execute()
    except Exception as e:
        print(f"reparse cleanup warning: {e}", flush=True)

    # Reset document status to uploaded so parse_document picks it up
    supa.table(DOCUMENTS_TABLE).update(
        {"status": "uploaded", "parse_error": None}
    ).eq("id", document_id).execute()

    # Run parse
    result = parse_document(document_id=document_id)
    return {"ok": True, "document_id": document_id, "reparse": True}


@app.post("/jobs/reparse_empty")
def reparse_empty(limit: int = Query(50, ge=1, le=200)):
    """
    Find parsed invoices with null vendor_name AND null total (empty extraction),
    then reparse them in batch.  Used for backfilling after parser fixes.
    """
    # Find documents that have parsed_invoices rows but with empty fields
    pi_res = (
        supa.table("parsed_invoices")
        .select("document_id")
        .is_("vendor_name", "null")
        .is_("total", "null")
        .limit(limit)
        .execute()
    )
    doc_ids = list({r["document_id"] for r in (pi_res.data or []) if r.get("document_id")})

    if not doc_ids:
        return {"ok": True, "message": "No empty parsed invoices found", "reparsed": 0, "failed": 0}

    reparsed = 0
    failed = 0
    results = []
    for did in doc_ids:
        try:
            reparse_document(document_id=did)
            reparsed += 1
            results.append({"document_id": did, "status": "reparsed"})
        except Exception as e:
            failed += 1
            results.append({"document_id": did, "status": "failed", "error": str(e)})
            print(f"reparse_empty failed for {did}: {e}", flush=True)

    return {
        "ok": True,
        "candidates": len(doc_ids),
        "reparsed": reparsed,
        "failed": failed,
        "results": results,
    }


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