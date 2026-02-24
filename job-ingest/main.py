import os
import base64
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, HTTPException, Query
from google.cloud import storage

from supa import sb  # supports either sb() factory OR sb proxy/client

app = FastAPI()

# -------------------------
# Config
# -------------------------

GCS_BUCKET = os.getenv("GCS_BUCKET")  # REQUIRED
JOB_PREFIX = os.getenv("JOB_PREFIX", "job-apps")

# Supabase tables (adjust if your schema uses different names)
APPS_TABLE = os.getenv("APPS_TABLE", "job_applications")
FILES_TABLE = os.getenv("FILES_TABLE", "job_application_files")

# Outlook / MS Graph creds
MS_TENANT_ID = os.getenv("MS_TENANT_ID")
MS_CLIENT_ID = os.getenv("MS_CLIENT_ID")
MS_CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")

# Optional: limit which Inbox messages count as "applications"
# Comma-separated, matched against subject (case-insensitive)
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
    """
    Some services use sb() (factory) but in others sb may already be a client/proxy.
    This avoids: TypeError: '_SBProxy' object is not callable
    """
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
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _graph_list_inbox_messages(mailbox: str, token: str, top: int) -> List[Dict[str, Any]]:
    """
    Read-only: does NOT move/mark read/delete.
    """
    url = f"https://graph.microsoft.com/v1.0/users/{mailbox}/mailFolders/Inbox/messages"
    params = {
        "$top": str(top),
        "$select": "id,subject,receivedDateTime,hasAttachments,from,internetMessageId",
        "$orderby": "receivedDateTime desc",
    }
    data = _graph_get(url, token, params=params)
    return data.get("value", [])


def _graph_list_attachments(mailbox: str, token: str, message_id: str) -> List[Dict[str, Any]]:
    url = f"https://graph.microsoft.com/v1.0/users/{mailbox}/messages/{message_id}/attachments"
    params = {"$select": "id,name,contentType,size,isInline,@odata.type,contentBytes"}
    data = _graph_get(url, token, params=params)
    return data.get("value", [])


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
    This prevents 23505 duplicate key crashes.
    """
    mid = row.get("source_message_id")
    if mid:
        existing = _get_existing_app_id(supa, mid)
        if existing:
            return existing

    # Try insert
    ins = supa.table(APPS_TABLE).insert(row).execute()
    data = getattr(ins, "data", None) or []
    if data and data[0].get("id"):
        return data[0]["id"]

    # If insert didn't return id for some reason, try fetch
    if mid:
        existing = _get_existing_app_id(supa, mid)
        if existing:
            return existing

    raise RuntimeError("Could not insert or resolve application id")


# -------------------------
# Routes
# -------------------------

@app.get("/_health")
def health():
    return {"ok": True}


@app.post("/jobs/pull_applicants")
def pull_applicants(
    mailbox: str = Query(..., description="Central mailbox, e.g. Hiring@baker-aviation.com"),
    role_bucket: str = Query(..., description="pilot|sales|maintenance|other (metadata only)"),
    max_messages: int = Query(50, ge=1, le=200),
):
    """
    Inbox-only, read-only ingestion.
    Does NOT move or modify emails.

    role_bucket is metadata only (NOT a folder path).
    """
    # Fail early if bucket missing (avoids cryptic google-cloud-storage error)
    bucket_name = _require_nonempty("GCS_BUCKET", GCS_BUCKET)

    token = _get_graph_token()
    supa = _get_supa()

    # Read latest Inbox messages
    msgs = _graph_list_inbox_messages(mailbox=mailbox, token=token, top=max_messages)

    # Filter to reduce noise
    msgs = [m for m in msgs if _looks_like_app(m)]

    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)

    results: List[Dict[str, Any]] = []
    created_or_updated = 0

    for m in msgs:
        mid = m.get("id")
        if not mid:
            continue

        subject = m.get("subject")
        received_at = m.get("receivedDateTime")

        # Attachments
        atts = _graph_list_attachments(mailbox=mailbox, token=token, message_id=mid)
        file_atts = [
            a for a in atts
            if a.get("@odata.type") == "#microsoft.graph.fileAttachment"
            and not a.get("isInline")
            and a.get("contentBytes")
        ]

        if not file_atts:
            results.append({"message_id": mid, "status": "no_file_attachments"})
            continue

        # Create application row (idempotent via source_message_id unique constraint)
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
            raise HTTPException(status_code=500, detail=f"Supabase application insert failed: {e}")

        uploaded_files: List[Dict[str, Any]] = []
        for a in file_atts:
            name = a.get("name") or "attachment"
            content_type = a.get("contentType") or "application/octet-stream"

            try:
                raw = base64.b64decode(a["contentBytes"])
            except Exception:
                uploaded_files.append({"filename": name, "status": "bad_attachment_b64"})
                continue

            safe_name = name.replace("/", "_")
            gcs_key = f"{JOB_PREFIX}/{role_bucket}/{mid}/{safe_name}"

            # Upload to GCS
            blob = bucket.blob(gcs_key)
            blob.upload_from_string(raw, content_type=content_type)

            # Record file row
            file_row = {
                "application_id": app_id,
                "message_id": mid,
                "filename": name,
                "content_type": content_type,
                "gcs_bucket": bucket_name,
                "gcs_key": gcs_key,
                "size_bytes": len(raw),
            }

            try:
                supa.table(FILES_TABLE).insert(file_row).execute()
                uploaded_files.append({"filename": name, "gcs_key": gcs_key, "status": "uploaded"})
            except Exception as e:
                uploaded_files.append({"filename": name, "gcs_key": gcs_key, "status": f"db_insert_failed: {e}"})

        created_or_updated += 1
        results.append(
            {
                "message_id": mid,
                "application_id": app_id,
                "uploaded": uploaded_files,
            }
        )

    return {
        "ok": True,
        "mode": "inbox_readonly",
        "mailbox": mailbox,
        "role_bucket": role_bucket,
        "max_messages": max_messages,
        "matched": len(msgs),
        "created_or_updated": created_or_updated,
        "results": results,
    }