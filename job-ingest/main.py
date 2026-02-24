import os
import base64
import urllib.parse
from typing import Any, Dict, List, Optional

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
    URL-encode helper.
    Keep '=' unescaped because Graph message IDs often end with '='
    and encoding it as %3D can cause 400 errors in path segments.
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
        # Attach body to the exception message so we can see Graph's real complaint
        body = (r.text or "")[:4000]
        raise requests.HTTPError(f"{e} | body={body}", response=r)
    return r.json()


def _graph_list_inbox_messages(mailbox: str, token: str, top: int) -> List[Dict[str, Any]]:
    mbox = _u(mailbox)
    url = f"https://graph.microsoft.com/v1.0/users/{mbox}/mailFolders/Inbox/messages"
    params = {
        "$top": str(top),
        "$select": "id,subject,receivedDateTime,hasAttachments",
        "$orderby": "receivedDateTime desc",
    }
    data = _graph_get(url, token, params=params)
    return data.get("value", [])


def _graph_list_attachments(mailbox: str, token: str, message_id: str) -> List[Dict[str, Any]]:
    """
    List attachments for a message.

    IMPORTANT:
    - Don't include '@odata.type' in $select (Graph 400s).
    - This list call often does NOT include contentBytes; we fetch contentBytes
      per attachment via _graph_get_attachment().
    - Some tenants 400 on /users/{mailbox}/messages/{id}/attachments, so we fallback
      to folder-scoped /mailFolders/Inbox/messages/{id}/attachments.
    """
    mbox = _u(mailbox)
    mid = urllib.parse.quote(message_id, safe="=")

    params = {"$select": "id,name,contentType,size,isInline"}

    # Try direct path first
    url1 = f"https://graph.microsoft.com/v1.0/users/{mbox}/messages/{mid}/attachments"
    try:
        data = _graph_get(url1, token, params=params)
        return data.get("value", [])
    except requests.HTTPError as e:
        if getattr(e, "response", None) is None or e.response.status_code != 400:
            raise

    # Folder-scoped fallback
    url2 = f"https://graph.microsoft.com/v1.0/users/{mbox}/mailFolders/Inbox/messages/{mid}/attachments"
    data = _graph_get(url2, token, params=params)
    return data.get("value", [])


def _graph_get_attachment(mailbox: str, token: str, message_id: str, attachment_id: str) -> Dict[str, Any]:
    """
    Fetch a single attachment by id so we can get contentBytes reliably.

    Critical:
    - message_id: keep '=' safe
    - attachment_id: encode EVERYTHING (safe="")
    """
    mbox = _u(mailbox)
    mid = urllib.parse.quote(message_id, safe="=")
    aid = urllib.parse.quote(attachment_id, safe="")  # keep '=' unescaped

    params = {"$select": "id,name,contentType,size,isInline,contentBytes"}

    # Try direct path first
    url1 = f"https://graph.microsoft.com/v1.0/users/{mbox}/messages/{mid}/attachments/{aid}"
    try:
        return _graph_get(url1, token, params=params)
    except requests.HTTPError as e:
        if getattr(e, "response", None) is None or e.response.status_code != 400:
            raise

    # Folder-scoped fallback
    url2 = f"https://graph.microsoft.com/v1.0/users/{mbox}/mailFolders/Inbox/messages/{mid}/attachments/{aid}"
    return _graph_get(url2, token, params=params)


def _looks_like_app(msg: Dict[str, Any]) -> bool:
    if not msg.get("hasAttachments"):
        return False
    if not INBOX_KEYWORDS:
        return True
    subj = (msg.get("subject") or "").lower()
    return any(k in subj for k in INBOX_KEYWORDS)


def _get_existing_app_id(supa, message_id: str) -> Optional[str]:
    try:
        res = (
            supa.table(APPS_TABLE)
            .select("id")
            .eq("source_message_id", message_id)
            .limit(1)
            .execute()
        )
        data = getattr(res, "data", None) or []
        if data and data[0].get("id"):
            return data[0]["id"]
    except Exception:
        return None
    return None


def _safe_insert_application(supa, row: Dict[str, Any]) -> str:
    """
    Insert into APPS_TABLE, but if source_message_id already exists, return existing id.
    Prevents 23505 duplicate key crashes.
    """
    mid = row.get("source_message_id")
    if mid:
        existing = _get_existing_app_id(supa, mid)
        if existing:
            return existing

    ins = supa.table(APPS_TABLE).insert(row).execute()
    data = getattr(ins, "data", None) or []
    if data and data[0].get("id"):
        return data[0]["id"]

    # fallback: re-fetch if insert didn't return row
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
    max_messages: int = Query(50, ge=1, le=200),
):
    bucket_name = _require_nonempty("GCS_BUCKET", GCS_BUCKET)

    token = _get_graph_token()
    supa = _get_supa()

    msgs = _graph_list_inbox_messages(mailbox, token, max_messages)
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

        # 1) List attachments (no contentBytes here)
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

        # keep non-inline attachments that have an id
        file_atts = [a for a in atts if not a.get("isInline") and a.get("id")]
        if not file_atts:
            results.append({"message_id": mid, "status": "no_attachments"})
            continue

        # 2) Create application row (idempotent)
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

        # 3) Fetch each attachment by id to get contentBytes reliably
        for a in file_atts:
            att_id = a["id"]

            try:
                full = _graph_get_attachment(mailbox, token, mid, att_id)
            except requests.HTTPError as e:
                status = None
                body = ""
                if getattr(e, "response", None) is not None:
                    status = e.response.status_code
                    body = (e.response.text or "")[:4000]

                uploaded_files.append({
                    "filename": a.get("name"),
                    "status": "attachment_fetch_failed",
                    "status_code": status,
                    "error": str(e),
                    "error_body": body,
                })
                continue

            b64 = full.get("contentBytes")
            if not b64:
                uploaded_files.append(
                    {
                        "filename": full.get("name") or a.get("name"),
                        "status": "no_contentBytes",
                    }
                )
                continue

            name = full.get("name") or "attachment"
            content_type = full.get("contentType") or "application/octet-stream"

            try:
                raw = base64.b64decode(b64)
            except Exception:
                uploaded_files.append({"filename": name, "status": "bad_attachment_b64"})
                continue

            safe_name = name.replace("/", "_")
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
            }

            supa.table(FILES_TABLE).insert(file_row).execute()
            uploaded_files.append({"filename": name, "gcs_key": gcs_key, "status": "uploaded"})

        processed += 1
        results.append({"message_id": mid, "application_id": app_id, "uploaded": uploaded_files})

    return {
        "ok": True,
        "mode": "inbox_readonly",
        "matched": len(msgs),
        "processed": processed,
        "results": results,
    }