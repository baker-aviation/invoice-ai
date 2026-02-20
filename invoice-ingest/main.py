import os
import hashlib
from google.cloud import storage

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, List

import httpx
from fastapi import FastAPI, HTTPException
from supabase import create_client

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
TOKEN_URL_TMPL = "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"

ALLOWED_EXTS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt"}

app = FastAPI()

def sb():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def is_allowed(name: str, is_inline: bool) -> bool:
    if is_inline:
        return False
    n = (name or "").lower().strip()
    return any(n.endswith(ext) for ext in ALLOWED_EXTS)
    
def upload_to_gcs(content: bytes, filename: str, doc_hash: str) -> tuple[str, str, str]:
    bucket_name = os.environ.get("GCS_BUCKET")
    if not bucket_name:
        raise RuntimeError("Missing GCS_BUCKET")

    client = storage.Client()
    bucket = client.bucket(bucket_name)

    safe_name = filename.replace("/", "_")
    path = f"invoices/{doc_hash}/{safe_name}"
    blob = bucket.blob(path)

    # Idempotent: if it already exists, don’t re-upload
    if not blob.exists(client=client):
        blob.upload_from_string(content)

    gs_url = f"gs://{bucket_name}/{path}"
    return bucket_name, path, gs_url

async def get_graph_token() -> str:
    tenant_id = os.environ["MS_TENANT_ID"]
    client_id = os.environ["MS_CLIENT_ID"]
    client_secret = os.environ["MS_CLIENT_SECRET"]

    token_url = TOKEN_URL_TMPL.format(tenant_id=tenant_id)
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(token_url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        if r.status_code != 200:
            raise HTTPException(status_code=500, detail=f"Token error: {r.status_code} {r.text}")
        return r.json()["access_token"]

async def graph_get(access_token: str, url: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(url, headers=headers, params=params)
        if r.status_code == 429:
            raise HTTPException(status_code=429, detail="Graph throttled (429). Retry later.")
        if r.status_code >= 400:
            raise HTTPException(status_code=500, detail=f"Graph GET error: {r.status_code} {r.text}")
        return r.json()

async def graph_download(access_token: str, url: str) -> bytes:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=120) as client:
        r = await client.get(url, headers=headers)
        if r.status_code == 429:
            raise HTTPException(status_code=429, detail="Graph throttled (429). Retry later.")
        if r.status_code >= 400:
            raise HTTPException(status_code=500, detail=f"Graph download error: {r.status_code} {r.text}")
        return r.content

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/jobs/pull_outlook")
async def pull_outlook():
    mailbox = os.getenv("OUTLOOK_SHARED_MAILBOX", "invoices@baker-aviation.com")
    top = int(os.getenv("PULL_TOP", "25"))

    access_token = await get_graph_token()
    supa = sb()

    # Read cursor from ingestion_state (overlap by 5 minutes)
    state = (
        supa.table("ingestion_state")
        .select("cursor_received_datetime")
        .eq("source", "outlook")
        .eq("mailbox", mailbox)
        .limit(1)
        .execute()
    )
    cursor = None
    if state.data:
        cursor = state.data[0].get("cursor_received_datetime")

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
        except Exception:
            cursor_dt = datetime.now(timezone.utc) - timedelta(days=1)
    else:
        cursor_dt = datetime.now(timezone.utc) - timedelta(days=1)

    since_dt = cursor_dt - timedelta(minutes=5)
    since_iso = since_dt.isoformat()

    list_url = f"{GRAPH_BASE}/users/{mailbox}/mailFolders/Inbox/messages"
    params = {
        "$filter": f"hasAttachments eq true and receivedDateTime ge {since_iso}",
        "$top": top,
        "$select": "id,subject,receivedDateTime,from,hasAttachments,internetMessageId",
    }

    msg_data = await graph_get(access_token, list_url, params=params)
    messages = msg_data.get("value", [])

    scanned_messages = len(messages)
    downloaded_attachments = 0
    inserted_documents = 0
    skipped_duplicates = 0

    newest_received = cursor_dt

    for m in messages:
        message_id = m["id"]
        subject = m.get("subject", "")
        received_dt_str = m.get("receivedDateTime")
        internet_message_id = m.get("internetMessageId")
        from_email = ((m.get("from") or {}).get("emailAddress") or {}).get("address")

        if received_dt_str:
            rdt = datetime.fromisoformat(received_dt_str.replace("Z", "+00:00"))
            if rdt > newest_received:
                newest_received = rdt

        att_url = f"{GRAPH_BASE}/users/{mailbox}/messages/{message_id}/attachments"
        att_data = await graph_get(access_token, att_url, params={"$top": 50})
        atts = att_data.get("value", [])

        for a in atts:
            if "fileAttachment" not in (a.get("@odata.type") or ""):
                continue

            att_id = a.get("id")
            name = a.get("name") or "attachment"
            content_type = a.get("contentType") or ""
            size = int(a.get("size") or 0)
            is_inline = bool(a.get("isInline") or False)

            if not is_allowed(name, is_inline):
                continue

            download_url = f"{GRAPH_BASE}/users/{mailbox}/messages/{message_id}/attachments/{att_id}/$value"
            content = await graph_download(access_token, download_url)
            downloaded_attachments += 1

            doc_hash = sha256_hex(content) 
            bucket_name, path, gs_url = upload_to_gcs(content, name, doc_hash)
            
            row = {
                "source": "outlook",
                "mailbox": mailbox,
                "message_id": message_id,
                "internet_message_id": internet_message_id,
                "received_datetime": received_dt_str,
                "from_email": from_email,
                "subject": subject,
                "attachment_id": att_id,
                "attachment_filename": name,
                "content_type": content_type,
                "size_bytes": size,
                "document_hash": doc_hash,
                "status": "uploaded",
                "storage_provider": "gcs",
                "storage_bucket": bucket_name,
                "storage_path": path,
                "raw_file_url": gs_url,
            }

            try:
                supa.table("documents").insert(row).execute()
                inserted_documents += 1
            except Exception:
                skipped_duplicates += 1

    # Update cursor in ingestion_state
    supa.table("ingestion_state").upsert(
        {
            "source": "outlook",
            "mailbox": mailbox,
            "cursor_received_datetime": newest_received.isoformat(),
            "last_run_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="source,mailbox",
    ).execute()

    return {
        "mailbox": mailbox,
        "since": since_iso,
        "scanned_messages": scanned_messages,
        "downloaded_attachments": downloaded_attachments,
        "inserted_documents": inserted_documents,
        "skipped_duplicates": skipped_duplicates,
        "new_cursor": newest_received.isoformat(),
    }
PARSER_BASE_URL = os.getenv("PARSER_BASE_URL")  # e.g. "https://invoice-parser-xxxx.run.app"

async def call_parser_parse_document(document_id: str) -> Dict[str, Any]:
    if not PARSER_BASE_URL:
        raise HTTPException(status_code=500, detail="Missing PARSER_BASE_URL env var (invoice-parser service base URL).")
    url = f"{PARSER_BASE_URL.rstrip('/')}/jobs/parse_document"
    async with httpx.AsyncClient(timeout=300) as client:
        r = await client.post(url, params={"document_id": document_id})
        if r.status_code >= 400:
            raise HTTPException(status_code=500, detail=f"Parser error: {r.status_code} {r.text}")
        return r.json()

@app.post("/jobs/parse_document")
async def parse_document_proxy(document_id: str):
    """Proxy to the invoice-parser service."""
    return await call_parser_parse_document(document_id)

@app.post("/jobs/parse_next")
async def parse_next(limit: int = 5, status: str = "failed"):
    """
    Bypasses the broken Supabase RPC claim_documents_for_parsing (which expects documents.claimed_at).
    Instead:
      - selects up to `limit` documents with status=<status>
      - skips any docs missing storage_bucket/storage_path (they will always 400 in parser)
      - marks each as 'parsing'
      - calls the parser service to parse it
      - marks success as 'parsed' or failure as 'failed' + parse_error
    """
    supa = sb()

    docs_res = (
        supa.table("documents")
        .select("id,storage_bucket,storage_path")
        .eq("status", status)
        .limit(limit)
        .execute()
    )

    raw_docs = docs_res.data or []
    docs = [d for d in raw_docs if d.get("storage_bucket") and d.get("storage_path")]

    skipped_missing_storage = [
        {"document_id": d.get("id"), "error": "Missing storage_bucket/storage_path"}
        for d in raw_docs
        if not d.get("storage_bucket") or not d.get("storage_path")
    ]

    claimed = 0
    parsed = 0
    failed = 0
    results = []

    for d in docs:
        doc_id = d["id"]
        claimed += 1

        # best-effort "claim"
        try:
            supa.table("documents").update({"status": "parsing"}).eq("id", doc_id).execute()
        except Exception:
            pass

        try:
            out = await call_parser_parse_document(doc_id)
            results.append({"document_id": doc_id, "ok": True, "result": out})
            parsed += 1
            supa.table("documents").update({"status": "parsed"}).eq("id", doc_id).execute()
        except Exception as e:
            failed += 1
            supa.table("documents").update({
                "status": "failed",
                "parse_error": str(e),
            }).eq("id", doc_id).execute()
            results.append({"document_id": doc_id, "ok": False, "error": str(e)})

    # report skipped too (helps you see what's still broken)
    for s in skipped_missing_storage:
        results.append({"document_id": s["document_id"], "ok": False, "error": s["error"]})

    return {
        "requested": limit,
        "status_filter": status,
        "candidates": len(raw_docs),
        "skipped_missing_storage": len(skipped_missing_storage),
        "claimed": claimed,
        "parsed": parsed,
        "failed": failed,
        "results": results,
    }

