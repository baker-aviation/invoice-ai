# invoice-ingest/main.py
import os
import json
import hashlib
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, HTTPException, Query
from google.cloud import storage

from supa import sb

app = FastAPI()

# -------------------------
# Env / Config
# -------------------------

# Supabase
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# Storage
GCS_BUCKET = os.getenv("GCS_BUCKET")  # fallback bucket if doc row doesn't include one

# Tables
DOCS_TABLE = os.environ.get("DOCS_TABLE", "documents")
PARSED_TABLE = os.environ.get("PARSED_TABLE", "parsed_invoices")

# Microsoft Graph (mailbox pull)
MS_TENANT_ID = os.getenv("MS_TENANT_ID")
MS_CLIENT_ID = os.getenv("MS_CLIENT_ID")
MS_CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")

# Where attachments are stored under bucket
DEFAULT_PREFIX = os.environ.get("DEFAULT_PREFIX", "invoices")


# -------------------------
# Helpers
# -------------------------

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def _get_graph_token() -> str:
    """
    App-only token for Microsoft Graph.
    Requires MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET.
    """
    tenant = _require_env("MS_TENANT_ID")
    client_id = _require_env("MS_CLIENT_ID")
    client_secret = _require_env("MS_CLIENT_SECRET")

    url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }
    r = requests.post(url, data=data, timeout=20)
    r.raise_for_status()
    return r.json()["access_token"]


def _graph_get(url: str, token: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    r = requests.get(
        url,
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _graph_get_bytes(url: str, token: str) -> bytes:
    r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.content


def _upload_to_gcs(bucket_name: str, object_name: str, data: bytes, content_type: str = "application/pdf") -> None:
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(object_name)
    blob.upload_from_string(data, content_type=content_type)


def _doc_bucket_path(doc: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    """
    Supports either gcs_bucket/gcs_path or storage_bucket/storage_path.
    """
    bucket = doc.get("gcs_bucket") or doc.get("storage_bucket") or GCS_BUCKET
    path = doc.get("gcs_path") or doc.get("storage_path")
    return bucket, path


def _claim_documents_for_parse(limit: int, status: str) -> List[Dict[str, Any]]:
    """
    Atomically claim documents by transitioning status -> processing.
    Selects candidate IDs first, then claims each with a conditional update
    (only updates if status is still the expected value). This prevents two
    concurrent workers from double-processing the same document.
    """
    supa = sb()

    # Select candidate IDs (may overlap with concurrent workers — that's fine,
    # the per-row claim below is the atomic gate).
    res = (
        supa.table(DOCS_TABLE)
        .select("id")
        .eq("status", status)
        .order("created_at", desc=False)
        .limit(limit)
        .execute()
    )
    candidate_ids = [r["id"] for r in (res.data or []) if r.get("id")]
    if not candidate_ids:
        return []

    # Atomically claim each: only succeeds if status is still the expected value.
    claimed_ids = []
    for did in candidate_ids:
        try:
            updated = (
                supa.table(DOCS_TABLE)
                .update({"status": "processing"})
                .eq("id", did)
                .eq("status", status)
                .execute()
            )
            if updated.data:
                claimed_ids.append(did)
        except Exception:
            pass

    if not claimed_ids:
        return []

    # Fetch the full rows we successfully claimed.
    res2 = supa.table(DOCS_TABLE).select("*").in_("id", claimed_ids).execute()
    return res2.data or []


# -------------------------
# Health
# -------------------------

@app.get("/healthz")
def healthz():
    gcs_bucket = os.getenv("GCS_BUCKET")
    try:
        supa = sb()
        test_doc = {
            "status": "uploaded", "gcs_bucket": "dbg", "gcs_path": "dbg/probe.pdf",
            "storage_bucket": "dbg", "storage_path": "dbg/probe.pdf",
            "attachment_filename": "probe.pdf", "created_at": _utc_now(),
            "source": "debug", "source_mailbox": "dbg@test.com", "source_message_id": "dbg",
        }
        r = supa.table(DOCS_TABLE).upsert(test_doc, on_conflict="gcs_bucket,gcs_path", ignore_duplicates=True).execute()
        supa.table(DOCS_TABLE).delete().eq("gcs_path", "dbg/probe.pdf").execute()
        supa_ok = True
        supa_err = None
    except Exception as e:
        supa_ok = False
        supa_err = repr(e)
    return {
        "ok": True, "service": "invoice-ingest", "ts": _utc_now(),
        "GCS_BUCKET": gcs_bucket or "(not set)",
        "supabase_upsert_ok": supa_ok,
        "supabase_error": supa_err,
    }


@app.get("/debug/env")
def debug_env():
    """Return key env var presence and a test Supabase upsert to diagnose schema issues."""
    gcs_bucket = os.getenv("GCS_BUCKET")
    result = {"GCS_BUCKET_set": bool(gcs_bucket), "GCS_BUCKET_value": gcs_bucket}
    try:
        supa = sb()
        test_doc = {
            "status": "uploaded",
            "gcs_bucket": "test-bucket",
            "gcs_path": "test/debug/probe.pdf",
            "storage_bucket": "test-bucket",
            "storage_path": "test/debug/probe.pdf",
            "attachment_filename": "probe.pdf",
            "created_at": _utc_now(),
            "source": "debug",
            "source_mailbox": "debug@test.com",
            "source_message_id": "debug-probe",
        }
        r = supa.table(DOCS_TABLE).upsert(test_doc, on_conflict="gcs_bucket,gcs_path", ignore_duplicates=True).execute()
        result["supabase_upsert"] = "ok"
        result["supabase_data"] = r.data
        # clean up test row
        supa.table(DOCS_TABLE).delete().eq("gcs_path", "test/debug/probe.pdf").execute()
    except Exception as e:
        result["supabase_error"] = repr(e)
        result["supabase_detail"] = getattr(e, "message", None) or str(e)
    return result


# -------------------------
# Mailbox Pull
# -------------------------

@app.post("/jobs/pull_mailbox")
def pull_mailbox(
    mailbox: str = Query(..., description="Mailbox email, e.g. invoices@baker-aviation.com"),
    lookback_minutes: int = Query(10, ge=1, le=1440),
    max_messages: int = Query(25, ge=1, le=100),
):
    """
    Pull recent emails + attachments from a mailbox and store PDFs to GCS.
    Also inserts/updates a documents row per attachment.

    This is intentionally conservative: only PDF attachments.
    """
    token = _get_graph_token()
    supa = sb()

    since = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
    # Graph wants UTC ISO. We’ll use createdDateTime filter on receivedDateTime.
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")

    # List messages
    # NOTE: This is a simplified approach. If you already have a "delta" flow,
    # you can swap this out and keep the rest.
    url = f"https://graph.microsoft.com/v1.0/users/{mailbox}/mailFolders/Inbox/messages"
    payload = _graph_get(
        url,
        token,
        params={
            "$top": str(max_messages),
            "$orderby": "receivedDateTime desc",
            "$filter": f"receivedDateTime ge {since_iso}",
            "$select": "id,subject,receivedDateTime,from",
        },
    )

    messages = payload.get("value", [])
    ingested = 0
    skipped = 0
    errors = 0
    error_samples: list = []

    for msg in messages:
        msg_id = msg["id"]

        # List attachments
        att_url = f"https://graph.microsoft.com/v1.0/users/{mailbox}/messages/{msg_id}/attachments"
        atts = _graph_get(att_url, token, params={"$top": "50"}).get("value", [])

        for att in atts:
            name = att.get("name") or "attachment"
            content_type = (att.get("contentType") or "").lower()

            # only pdf
            if not name.lower().endswith(".pdf") and "pdf" not in content_type:
                skipped += 1
                continue

            # Download attachment bytes
            att_id = att["id"]
            # This endpoint returns raw bytes:
            bytes_url = f"https://graph.microsoft.com/v1.0/users/{mailbox}/messages/{msg_id}/attachments/{att_id}/$value"

            try:
                data = _graph_get_bytes(bytes_url, token)
                if not data:
                    skipped += 1
                    continue

                digest = _sha256_hex(data)
                object_name = f"{DEFAULT_PREFIX}/{digest}/{name}"

                bucket = GCS_BUCKET
                if not bucket:
                    raise RuntimeError("Missing GCS_BUCKET env var")

                _upload_to_gcs(bucket, object_name, data, content_type="application/pdf")

                # Upsert into documents
                # If you already have unique keys (e.g., by digest), align on that.
                doc = {
                    "status": "uploaded",
                    "gcs_bucket": bucket,
                    "gcs_path": object_name,
                    "storage_bucket": bucket,
                    "storage_path": object_name,
                    "attachment_filename": name,
                    "created_at": _utc_now(),
                    "source": "mailbox",
                    "source_mailbox": mailbox,
                    "source_message_id": msg_id,
                }

                # Upsert on (gcs_bucket, gcs_path) unique constraint so
                # re-ingesting the same PDF is a no-op.
                result = (
                    supa.table(DOCS_TABLE)
                    .upsert(doc, on_conflict="gcs_bucket,gcs_path", ignore_duplicates=True)
                    .execute()
                )
                if result.data:
                    ingested += 1
                else:
                    skipped += 1  # already existed

            except Exception as e:
                errors += 1
                err_detail = getattr(e, "message", None) or getattr(e, "details", None) or str(e)
                error_samples.append({"att": name, "error": repr(e), "detail": err_detail})
                print(f"pull_mailbox error msg_id={msg_id} att={name}: {repr(e)} | detail={err_detail}", flush=True)

    return {
        "ok": True,
        "mailbox": mailbox,
        "since": since_iso,
        "messages": len(messages),
        "ingested": ingested,
        "skipped": skipped,
        "errors": errors,
        "error_samples": error_samples[:3],
    }


# -------------------------
# Parse Document
# -------------------------

def _parse_pdf_to_invoice_json(pdf_bytes: bytes) -> Dict[str, Any]:
    """
    Placeholder for your parser.
    If you already have a real parser function/module, call it here.

    Must return a dict matching your parsed_invoices columns expectations.
    """
    # ---- IMPORTANT ----
    # Replace this with your real parsing logic.
    # For now we store a minimal shape.
    return {
        "vendor_name": None,
        "invoice_number": None,
        "invoice_date": None,
        "currency": "USD",
        "subtotal": None,
        "tax": None,
        "total": None,
        "line_items": [],
        "review_required": True,
        "validation_pass": False,
        "parser_version": os.getenv("PARSER_VERSION", "0.1.0"),
    }


@app.post("/jobs/parse_document")
def parse_document(document_id: str):
    """
    Fetch document PDF from GCS, run parser, insert parsed_invoices row,
    and mark document status as parsed (or needs_review).
    """
    supa = sb()

    # fetch doc row
    doc_rows = (
        supa.table(DOCS_TABLE)
        .select("*")
        .eq("id", document_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    doc = doc_rows[0] if doc_rows else None
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    bucket, path = _doc_bucket_path(doc)
    if not bucket or not path:
        raise HTTPException(status_code=400, detail="Document missing storage path/bucket")

    # download from GCS
    client = storage.Client()
    blob = client.bucket(bucket).blob(path)
    pdf_bytes = blob.download_as_bytes()

    # parse
    inv = _parse_pdf_to_invoice_json(pdf_bytes)
    inv_row = {
        "document_id": document_id,
        **inv,
        "created_at": _utc_now(),
    }

    # store parsed invoice
    supa.table(PARSED_TABLE).insert(inv_row).execute()

    # mark document status
    new_status = "parsed"
    try:
        supa.table(DOCS_TABLE).update({"status": new_status, "parsed_at": _utc_now()}).eq("id", document_id).execute()
    except Exception:
        # ok if columns don't exist
        pass

    return {"ok": True, "document_id": document_id, "status": new_status}


# -------------------------
# Parse Next (batch)
# -------------------------

@app.post("/jobs/parse_next")
def parse_next(limit: int = 5, status: str = "uploaded"):
    """
    Claims up to N documents by status and parses them.
    Returns per-document results.

    This is what your Cloud Scheduler 'invoice-parse-next' job calls.
    """
    supa = sb()

    candidates = _claim_documents_for_parse(limit=limit, status=status)
    results = []
    claimed = 0
    parsed = 0
    failed = 0
    skipped_missing_storage = 0

    for doc in candidates:
        did = doc.get("id")
        if not did:
            continue

        bucket, path = _doc_bucket_path(doc)
        if not bucket or not path:
            skipped_missing_storage += 1
            continue

        claimed += 1

        try:
            r = parse_document(document_id=did)
            results.append({"document_id": did, "ok": True, "result": r})
            parsed += 1
        except Exception as e:
            results.append({"document_id": did, "ok": False, "error": str(e)[:500]})
            failed += 1
            try:
                supa.table(DOCS_TABLE).update({"status": "failed", "error": str(e)[:500]}).eq("id", did).execute()
            except Exception:
                pass

    return {
        "requested": limit,
        "status_filter": status,
        "candidates": len(candidates),
        "skipped_missing_storage": skipped_missing_storage,
        "claimed": claimed,
        "parsed": parsed,
        "failed": failed,
        "results": results,
    }