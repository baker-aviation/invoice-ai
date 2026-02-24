diff --git a/main.py b/main.py
index 1111111..2222222 100644
--- a/main.py
+++ b/main.py
@@ -1,10 +1,12 @@
 import os
 import json
 import hashlib
+import base64
 from datetime import datetime, timezone, timedelta
 from typing import Any, Dict, List, Optional, Tuple
 
 import requests
 from fastapi import FastAPI, HTTPException, Query
 from google.cloud import storage
 
 from supa import sb  # same as your invoice-ingest uses
 
 app = FastAPI()
@@ -20,7 +22,7 @@
 # -------------------------
 
-GCS_BUCKET = os.getenv("GCS_BUCKET")
+GCS_BUCKET = os.getenv("GCS_BUCKET")  # REQUIRED
 JOB_PREFIX = os.getenv("JOB_PREFIX", "job-apps")
 
 # Supabase tables
 APPS_TABLE = os.getenv("APPS_TABLE", "job_applications")
 FILES_TABLE = os.getenv("FILES_TABLE", "job_application_files")
@@ -46,6 +48,18 @@
 def _require_env(name: str) -> str:
     v = os.getenv(name)
     if not v:
         raise RuntimeError(f"Missing env var: {name}")
     return v
+
+def _require_nonempty(name: str, value: Optional[str]) -> str:
+    if not value or not str(value).strip():
+        raise RuntimeError(f"Missing env var: {name}")
+    return value
+
+def _get_supa():
+    # supports both patterns: sb() factory OR sb already being a client/proxy
+    try:
+        return sb()  # type: ignore[misc]
+    except TypeError:
+        return sb
 
 def _get_graph_token() -> str:
     tenant = _require_env("MS_TENANT_ID")
     client_id = _require_env("MS_CLIENT_ID")
     client_secret = _require_env("MS_CLIENT_SECRET")
@@ -120,6 +134,31 @@
 def _graph_list_attachments(mailbox: str, token: str, message_id: str) -> List[Dict[str, Any]]:
     url = f"https://graph.microsoft.com/v1.0/users/{mailbox}/messages/{message_id}/attachments"
     params = {"$select": "id,name,contentType,size,isInline,@odata.type,contentBytes"}
     data = _graph_get(url, token, params=params)
     return data.get("value", [])
+
+def _get_existing_app_id(supa, message_id: str) -> Optional[str]:
+    try:
+        res = (
+            supa.table(APPS_TABLE)
+            .select("id")
+            .eq("source_message_id", message_id)
+            .limit(1)
+            .execute()
+        )
+        data = getattr(res, "data", None) or []
+        if data:
+            return data[0].get("id")
+    except Exception:
+        return None
+    return None
+
+def _safe_insert_application(supa, row: Dict[str, Any]) -> str:
+    """
+    Insert into APPS_TABLE, but if source_message_id already exists, return existing id.
+    This prevents the 23505 crash.
+    """
+    mid = row.get("source_message_id")
+    if mid:
+        existing = _get_existing_app_id(supa, mid)
+        if existing:
+            return existing
+    ins = supa.table(APPS_TABLE).insert(row).execute()
+    data = getattr(ins, "data", None) or []
+    if not data or not data[0].get("id"):
+        raise RuntimeError("Insert succeeded but no id returned from Supabase")
+    return data[0]["id"]
 
 @app.post("/jobs/pull_applicants")
 def pull_applicants(
     mailbox: str = Query(..., description="Central mailbox, e.g. jobs@baker-aviation.com"),
     role_bucket: str = Query(..., description="pilot|sales|maintenance|other"),
     max_messages: int = Query(50, ge=1, le=200),
 ):
@@ -132,11 +171,18 @@
     ZERO Outlook-folder-changes mode:
       - Reads from Inbox (read-only) and never moves/marks messages.
       - role_bucket is metadata only (NOT a folder path).
     """
     token = _get_graph_token()
-    supa = sb()
+    supa = _get_supa()
+
+    # Hard fail early if bucket missing so we don't get the cryptic blob error
+    bucket_name = _require_nonempty("GCS_BUCKET", GCS_BUCKET)
 
     # 1) Read latest Inbox messages
     msgs = _graph_list_inbox_messages(mailbox=mailbox, token=token, top=max_messages)
     msgs = [m for m in msgs if _looks_like_app(m)]
@@ -150,12 +196,11 @@
-    storage_client = storage.Client()
-    bucket = storage_client.bucket(GCS_BUCKET)
+    storage_client = storage.Client()
+    bucket = storage_client.bucket(bucket_name)
 
     results: List[Dict[str, Any]] = []
     created = 0
-    skipped = len(msgs) - len(msgs_to_process)
+    skipped = len(msgs) - len(msgs_to_process)
 
     for m in msgs_to_process:
         mid = m["id"]
@@ -173,21 +218,19 @@
         if not file_atts:
             results.append({"message_id": mid, "status": "no_file_attachments"})
             continue
 
         # Create job application row (idempotent)
         app_row = {
             "mailbox": mailbox,
             "role_bucket": role_bucket,
             "subject": subject,
             "received_at": received_at,
             "source_message_id": mid,
         }
 
-        app_insert = supa.table(APPS_TABLE).insert(app_row).execute()
-        app_id = app_insert.data[0].get("id") if app_insert.data else None
+        app_id = _safe_insert_application(supa, app_row)
 
         uploaded_files: List[Dict[str, Any]] = []
         for a in file_atts:
             name = a.get("name") or "attachment"
             content_type = a.get("contentType") or "application/octet-stream"
             b64 = a.get("contentBytes")
-            raw = None
-            try:
-                import base64
-                raw = base64.b64decode(b64)
-            except Exception:
-                continue
+            try:
+                raw = base64.b64decode(b64)
+            except Exception:
+                results.append({"message_id": mid, "status": "bad_attachment_b64", "filename": name})
+                continue
 
             safe_name = name.replace("/", "_")
             gcs_key = f"{JOB_PREFIX}/{role_bucket}/{mid}/{safe_name}"
             blob = bucket.blob(gcs_key)
             blob.upload_from_string(raw, content_type=content_type)
@@ -200,7 +243,7 @@
             supa.table(FILES_TABLE).insert(file_row).execute()
             uploaded_files.append({"filename": name, "gcs_key": gcs_key})
 
         created += 1
         results.append({
             "message_id": mid,
             "application_id": app_id,
             "uploaded": uploaded_files,
         })
 
     return {
         "ok": True,
         "mode": "inbox_readonly",
         "mailbox": mailbox,
         "role_bucket": role_bucket,
         "max_messages": max_messages,
         "matched": len(msgs),
         "skipped_already_processed": skipped,
         "created": created,
         "results": results,
     }