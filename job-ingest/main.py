import os
import base64
import hashlib
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, HTTPException, Query
from google.cloud import storage

from supa import sb

app = FastAPI()

# -------------------------
# Config
# -------------------------

GCS_BUCKET = os.getenv("GCS_BUCKET")  # REQUIRED
JOB_PREFIX = os.getenv("JOB_PREFIX", "job-apps")

APPS_TABLE = os.getenv("APPS_TABLE", "job_applications")
FILES_TABLE = os.getenv("FILES_TABLE", "job_application_files")

INBOX_KEYWORDS = [
    s.strip().lower()
    for s in os.getenv(
        "INBOX_KEYWORDS",
        "application,resume,cv,first officer,sic,pilot,maintenance,technician,dispatcher,sales",
    ).split(",")
    if s.strip()
]

# -------------------------
# Helpers
# -------------------------


def _u(value: str) -> str:
    """
    URL-encode helper for path segments.
    Keep '=' unescaped because Graph message IDs often end with '='.
    """
    return urllib.parse.quote(value, safe="=")


def _require_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def _require_nonempty(name: str, value: Optional[str]) -> str:
    if not value or not str(value).strip():
        raise RuntimeError(f"Missing env var: {name}")
    return value


def _get_supa():
    # supports both patterns: sb() factory OR sb already being a client/proxy
    try:
        return sb()  # type: ignore[misc]
    except TypeError:
        return sb


def _get_graph_token() -> str:
    tenant = _require_env("MS_TENANT_ID")
    client_id = _require_env("MS_CLIENT_ID")
    client_secret = _require_env("MS_CLIENT_SECRET")

    r = requests.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
            "scope": "https://graph.microsoft.com/.default",
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def _graph_get(url: str, token: str, params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    r = requests.get(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        params=params or {},
        timeout=30,
    )
    try:
        r.raise_for_status()
    except requests.HTTPError as e:
        body = (r.text or "")[:4000]
        raise requests.HTTPError(f"{e} | body={body}", response=r)
    return r.json()


def _graph_list_inbox_messages_page(
    mailbox: str,
    token: str,
    *,
    top: int,
    received_since_iso: Optional[str] = None,
    next_link: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """
    Returns (messages, next_link).
    Uses @odata.nextLink pagination when present.
    """
    if next_link:
        data = _graph_get(next_link, token)
        msgs = data.get("value", []) or []
        return msgs, data.get("@odata.nextLink")

    mbox = _u(mailbox)
    url = f"https://graph.microsoft.com/v1.0/users/{mbox}/mailFolders/Inbox/messages"

    params: Dict[str, str] = {
        "$top": str(top),
        "$select": "id,subject,receivedDateTime,hasAttachments",
        "$orderby": "receivedDateTime desc",
    }
    if received_since_iso:
        params["$filter"] = f"receivedDateTime ge {received_since_iso}"

    data = _graph_get(url, token, params=params)
    msgs = data.get("value", []) or []
    return msgs, data.get("@odata.nextLink")


def _graph_list_inbox_messages(
    mailbox: str,
    token: str,
    *,
    max_messages: int,
    received_since_iso: Optional[str] = None,
    page_size: int = 50,
) -> List[Dict[str, Any]]:
    """
    Paginate Inbox messages until max_messages reached or no nextLink.
    """
    out: List[Dict[str, Any]] = []
    next_link: Optional[str] = None

    while len(out) < max_messages:
        take = min(page_size, max_messages - len(out))
        msgs, next_link = _graph_list_inbox_messages_page(
            mailbox,
            token,
            top=take,
            received_since_iso=received_since_iso,
            next_link=next_link,
        )
        if not msgs:
            break
        out.extend(msgs)
        if not next_link:
            break

    return out


def _graph_list_attachments(mailbox: str, token: str, message_id: str) -> List[Dict[str, Any]]:
    """
    List attachments for a message.

    IMPORTANT:
    - Do NOT include '@odata.type' in $select (Graph 400s).
    - This list does NOT include contentBytes; fetch contentBytes per attachment via _graph_get_attachment().
    - Some tenants 400 on /users/{mailbox}/messages/{id}/attachments, so fallback to folder-scoped.
    """
    mbox = _u(mailbox)
    mid = _u(message_id)

    params = {"$select": "id,name,contentType,size,isInline"}

    url1 = f"https://graph.microsoft.com/v1.0/users/{mbox}/messages/{mid}/attachments"
    try:
        data = _graph_get(url1, token, params=params)
        return data.get("value", [])
    except requests.HTTPError as e:
        if getattr(e, "response", None) is None or e.response.status_code != 400:
            raise

    url2 = f"https://graph.microsoft.com/v1.0/users/{mbox}/mailFolders/Inbox/messages/{mid}/attachments"
    data = _graph_get(url2, token, params=params)
    return data.get("value", [])


def _graph_get_attachment(mailbox: str, token: str, message_id: str, attachment_id: str) -> Dict[str, Any]:
    """
    Fetch a single attachment.

    IMPORTANT:
    - Do NOT $select=contentBytes (some tenants error because they treat it as base attachment type)
    - Instead, GET the attachment and read contentBytes if present.
    """
    mbox = _u(mailbox)
    mid = _u(message_id)
    aid = urllib.parse.quote(attachment_id, safe="")  # encode everything

    url1 = f"https://graph.microsoft.com/v1.0/users/{mbox}/messages/{mid}/attachments/{aid}"
    try:
        return _graph_get(url1, token)
    except requests.HTTPError as e:
        if getattr(e, "response", None) is None or e.response.status_code != 400:
            raise

    url2 = f"https://graph.microsoft.com/v1.0/users/{mbox}/mailFolders/Inbox/messages/{mid}/attachments/{aid}"
    return _graph_get(url2, token)


def _looks_like_app(msg: Dict[str, Any]) -> bool:
    if not msg.get("hasAttachments"):
        return False
    if not INBOX_KEYWORDS:
        return True
    subj = (msg.get("subject") or "").lower()
    return any(k in subj for k in INBOX_KEYWORDS)


def _get_existing_app_id(supa, message_id: str) -> Optional[int]:
    try:
        res = (
            supa.table(APPS_TABLE)
            .select("id")
            .eq("source_message_id", message_id)
            .limit(1)
            .execute()
        )
        data = getattr(res, "data", None) or []
        if data and data[0].get("id") is not None:
            return int(data[0]["id"])
    except Exception:
        return None
    return None


def _safe_insert_application(supa, row: Dict[str, Any]) -> int:
    mid = row.get("source_message_id")
    if mid:
        existing = _get_existing_app_id(supa, mid)
        if existing:
            return existing

    ins = supa.table(APPS_TABLE).insert(row).execute()
    data = getattr(ins, "data", None) or []
    if data and data[0].get("id") is not None:
        return int(data[0]["id"])

    if mid:
        existing = _get_existing_app_id(supa, mid)
        if existing:
            return existing

    raise RuntimeError("Could not insert or resolve application id")


def _file_exists(supa, gcs_key: str) -> bool:
    try:
        res = (
            supa.table(FILES_TABLE)
            .select("id")
            .eq("gcs_key", gcs_key)
            .limit(1)
            .execute()
        )
        data = getattr(res, "data", None) or []
        return bool(data)
    except Exception:
        return False


def _iso_days_ago(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=int(days))
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


# -------------------------
# Core ingest routine
# -------------------------


def _ingest_messages(
    *,
    mailbox: str,
    role_bucket: str,
    max_messages: int,
    received_since_iso: Optional[str],
) -> Dict[str, Any]:
    bucket_name = _require_nonempty("GCS_BUCKET", GCS_BUCKET)

    token = _get_graph_token()
    supa = _get_supa()

    msgs = _graph_list_inbox_messages(
        mailbox,
        token,
        max_messages=max_messages,
        received_since_iso=received_since_iso,
        page_size=50,
    )
    msgs = [m for m in msgs if _looks_like_app(m)]

    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)

    results: List[Dict[str, Any]] = []
    processed = 0

    for m in msgs:
        mid = m.get("id")
        if not mid:
            continue

        subject = m.get("subject")
        received_at = m.get("receivedDateTime")

        # 1) List attachments
        try:
            atts = _graph_list_attachments(mailbox, token, mid)
        except requests.HTTPError as e:
            status = None
            body = ""
            if getattr(e, "response", None) is not None:
                status = e.response.status_code
                body = (e.response.text or "")[:2000]
            results.append(
                {
                    "message_id": mid,
                    "status": "attachments_list_failed",
                    "status_code": status,
                    "error_body": body,
                }
            )
            continue

        # keep non-inline attachments with an id
        candidates = [a for a in atts if not a.get("isInline") and a.get("id")]
        if not candidates:
            results.append({"message_id": mid, "status": "no_attachments"})
            continue

        # 2) Pre-fetch candidates and ONLY proceed if we find at least one fileAttachment (contentBytes present)
        # This prevents orphan job_applications rows caused by itemAttachment attachments (no contentBytes).
        prefetched: List[Dict[str, Any]] = []
        skipped: List[Dict[str, Any]] = []

        for a in candidates:
            att_id = a["id"]
            name_hint = a.get("name")

            try:
                full = _graph_get_attachment(mailbox, token, mid, att_id)
            except requests.HTTPError as e:
                status = None
                body = ""
                if getattr(e, "response", None) is not None:
                    status = e.response.status_code
                    body = (e.response.text or "")[:1000]
                skipped.append(
                    {
                        "filename": name_hint,
                        "status": "attachment_fetch_failed",
                        "status_code": status,
                        "error": str(e),
                        "error_body": body,
                    }
                )
                continue

            b64 = full.get("contentBytes")
            if not b64:
                # This is usually itemAttachment (embedded email) or a type that has no bytes.
                skipped.append(
                    {
                        "filename": full.get("name") or name_hint,
                        "status": "no_contentBytes",
                        "odata_type": full.get("@odata.type") or full.get("odata.type"),
                    }
                )
                continue

            prefetched.append(
                {
                    "att_id": att_id,
                    "meta": a,
                    "full": full,
                }
            )

        if not prefetched:
            results.append(
                {
                    "message_id": mid,
                    "status": "no_file_attachments",
                    "skipped": skipped,
                }
            )
            continue

        # 3) Create application row (idempotent) ONLY AFTER we know we have at least 1 real file
        app_row = {
            "mailbox": mailbox,
            "role_bucket": role_bucket,
            "subject": subject,
            "received_at": received_at,
            "source_message_id": mid,
        }

        try:
            app_id = _safe_insert_application(supa, app_row)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Supabase insert failed: {e}")

        uploaded_files: List[Dict[str, Any]] = []

        # 4) Upload prefetched fileAttachments
        for item in prefetched:
            att_id = item["att_id"]
            full = item["full"]
            meta = item["meta"]
            name_hint = meta.get("name")

            b64 = full.get("contentBytes")
            if not b64:
                # Shouldn't happen because we filtered, but keep safe.
                uploaded_files.append(
                    {
                        "filename": full.get("name") or name_hint,
                        "status": "no_contentBytes",
                        "odata_type": full.get("@odata.type") or full.get("odata.type"),
                    }
                )
                continue

            name = full.get("name") or name_hint or "attachment"
            content_type = full.get("contentType") or meta.get("contentType") or "application/octet-stream"

            try:
                raw = base64.b64decode(b64)
            except Exception:
                uploaded_files.append({"filename": name, "status": "bad_attachment_b64"})
                continue

            sha256 = hashlib.sha256(raw).hexdigest()

            safe_name = name.replace("/", "_")
            # JOB_PREFIX/role_bucket/message_id/filename
            gcs_key = f"{JOB_PREFIX}/{role_bucket}/{mid}/{safe_name}"

            if _file_exists(supa, gcs_key):
                uploaded_files.append({"filename": name, "gcs_key": gcs_key, "status": "already_saved"})
                continue

            blob = bucket.blob(gcs_key)
            blob.upload_from_string(raw, content_type=content_type)

            file_row = {
                "application_id": app_id,
                "message_id": mid,
                "filename": name,
                "content_type": content_type,
                "gcs_bucket": bucket_name,
                "gcs_key": gcs_key,
                "size_bytes": len(raw),
                "graph_attachment_id": att_id,
                "sha256": sha256,
            }

            try:
                supa.table(FILES_TABLE).insert(file_row).execute()
                uploaded_files.append({"filename": name, "gcs_key": gcs_key, "status": "uploaded"})
            except Exception as e:
                uploaded_files.append({"filename": name, "gcs_key": gcs_key, "status": f"db_insert_failed: {e}"})

        # carry forward any skipped attachment info for visibility
        if skipped:
            uploaded_files.extend(skipped)

        processed += 1
        results.append({"message_id": mid, "application_id": app_id, "uploaded": uploaded_files})

    return {
        "ok": True,
        "mailbox": mailbox,
        "role_bucket": role_bucket,
        "received_since": received_since_iso,
        "matched_after_filter": len(msgs),
        "processed": processed,
        "results": results,
    }


# -------------------------
# Routes
# -------------------------


@app.get("/_health")
def health():
    return {"ok": True}


@app.post("/jobs/pull_applicants")
def pull_applicants(
    mailbox: str = Query(...),
    role_bucket: str = Query(...),
    max_messages: int = Query(50, ge=1, le=500),
):
    """
    Backwards compatible:
    - pulls newest max_messages, paginated
    - filters by hasAttachments + subject keywords
    """
    return _ingest_messages(
        mailbox=mailbox,
        role_bucket=role_bucket,
        max_messages=max_messages,
        received_since_iso=None,
    )


@app.post("/jobs/backfill_applicants")
def backfill_applicants(
    mailbox: str = Query(...),
    role_bucket: str = Query(...),
    days: int = Query(90, ge=1, le=365),
    max_messages: int = Query(300, ge=1, le=5000),
):
    """
    Backfill last N days (default 90).
    - paginates until max_messages or no more
    - inserts idempotently (won't duplicate)
    """
    since_iso = _iso_days_ago(days)
    return _ingest_messages(
        mailbox=mailbox,
        role_bucket=role_bucket,
        max_messages=max_messages,
        received_since_iso=since_iso,
    )