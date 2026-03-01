import os
import io
import json
from typing import Any, Dict, List, Optional

import requests
from fastapi import FastAPI, HTTPException, Query
from google.cloud import storage
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from supabase import create_client, Client
from supa import safe_select_many, safe_select_one

import base64
from pypdf import PdfReader
import fitz  # PyMuPDF — renders PDF pages to images for OCR fallback
from docx import Document
from starlette.responses import RedirectResponse

from datetime import datetime, timedelta, timezone

from auth_middleware import add_auth_middleware

app = FastAPI()
add_auth_middleware(app)
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# -------------------------
# ENV / Config
# -------------------------

# Supabase (use service role key for server-side jobs)
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# GCS (same bucket you used in job-ingest)
GCS_BUCKET = os.getenv("GCS_BUCKET")

# Tables
APPS_TABLE = os.getenv("APPS_TABLE", "job_applications")
FILES_TABLE = os.getenv("FILES_TABLE", "job_application_files")
PARSE_TABLE = os.getenv("PARSE_TABLE", "job_application_parse")

# OpenAI
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

# Parsing limits
MAX_CHARS_PER_FILE = int(os.getenv("MAX_CHARS_PER_FILE", "120000"))
MAX_TOTAL_CHARS = int(os.getenv("MAX_TOTAL_CHARS", "180000"))
MAX_OCR_PAGES = int(os.getenv("MAX_OCR_PAGES", "5"))

# Soft gate PIC thresholds (your rule)
PIC_SOFT_GATE_TT = float(os.getenv("PIC_SOFT_GATE_TT", "3000"))
PIC_SOFT_GATE_PIC = float(os.getenv("PIC_SOFT_GATE_PIC", "1500"))

# -------------------------
# Helpers
# -------------------------


def _strip_nulls(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    # Remove actual null bytes that Postgres rejects
    return s.replace("\x00", "")


def _sanitize_for_db(obj: Any) -> Any:
    """
    Recursively remove null bytes from any strings in dict/list structures.
    Safe to run on the entire OpenAI extraction before storing in Postgres/Supabase.
    """
    if obj is None:
        return None
    if isinstance(obj, str):
        return obj.replace("\x00", "")
    if isinstance(obj, list):
        return [_sanitize_for_db(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _sanitize_for_db(v) for k, v in obj.items()}
    return obj


def _require(name: str, value: Optional[str]) -> str:
    if not value or not str(value).strip():
        raise RuntimeError(f"Missing env var: {name}")
    return value


def _supa() -> Client:
    url = _require("SUPABASE_URL", SUPABASE_URL)
    key = _require("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY)
    return create_client(url, key)


def _gcs_bucket() -> storage.Bucket:
    bucket_name = _require("GCS_BUCKET", GCS_BUCKET)
    client = storage.Client()
    return client.bucket(bucket_name)


def _download_gcs_bytes(bucket: storage.Bucket, gcs_key: str) -> bytes:
    blob = bucket.blob(gcs_key)
    # blob.exists() makes an extra API call; download_as_bytes will error if missing,
    # but keeping this for clearer error messages.
    if not blob.exists():
        raise FileNotFoundError(f"GCS key not found: {gcs_key}")
    return blob.download_as_bytes()


def _get_gcs_signed_url(bucket_name: str, gcs_key: str, expires_seconds: int = 7200) -> Optional[str]:
    """
    Generate a V4 signed URL for a GCS object.
    Works locally and on Cloud Run. On Cloud Run, we often need to use the
    IAM signBlob path (service_account_email + access_token).
    """
    if not bucket_name or not gcs_key:
        return None

    try:
        from google.cloud import storage
        import google.auth
        from google.auth.transport.requests import Request

        client = storage.Client()
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(gcs_key)

        creds, _ = google.auth.default()
        req = Request()
        if not creds.valid:
            creds.refresh(req)

        # If running on Cloud Run, this may be needed for IAM-based signing
        sa_email = getattr(creds, "service_account_email", None) or os.getenv("SIGNED_URL_SERVICE_ACCOUNT_EMAIL")

        # Try normal signing first (works locally with SA key JSON)
        try:
            return blob.generate_signed_url(
                version="v4",
                expiration=expires_seconds,
                method="GET",
            )
        except Exception:
            # Cloud Run fallback: IAM signBlob using access_token + SA email
            if not sa_email:
                raise RuntimeError("Missing SIGNED_URL_SERVICE_ACCOUNT_EMAIL for Cloud Run signing fallback.")

            return blob.generate_signed_url(
                version="v4",
                expiration=expires_seconds,
                method="GET",
                service_account_email=sa_email,
                access_token=creds.token,
            )

    except Exception as e:
        print("SIGNED URL ERROR:", repr(e), "bucket=", bucket_name, "key=", gcs_key)
        return None


def _extract_text_pdf(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data))
    parts: List[str] = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        t = _strip_nulls(t) or ""
        if t.strip():
            parts.append(t)
    return "\n\n".join(parts).strip()


def _ocr_pdf_via_vision(data: bytes) -> str:
    """
    Fallback for scanned/image-based PDFs: render pages to PNG with PyMuPDF,
    then send to OpenAI vision API to extract text.
    """
    api_key = OPENAI_API_KEY
    if not api_key:
        return ""

    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as e:
        print(f"OCR: fitz.open failed: {e}", flush=True)
        return ""

    page_count = min(len(doc), MAX_OCR_PAGES)
    if page_count == 0:
        doc.close()
        return ""

    # Render pages to base64 PNGs
    images: List[Dict[str, Any]] = []
    for i in range(page_count):
        try:
            page = doc[i]
            # 2x zoom for readable OCR (144 DPI)
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            png_bytes = pix.tobytes("png")
            b64 = base64.b64encode(png_bytes).decode("ascii")
            images.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{b64}",
                    "detail": "high",
                },
            })
        except Exception as e:
            print(f"OCR: page {i} render failed: {e}", flush=True)
    doc.close()

    if not images:
        return ""

    print(f"OCR: sending {len(images)} page(s) to vision API", flush=True)

    # Build the message content: instruction text + page images
    content: List[Dict[str, Any]] = [
        {"type": "input_text", "text": (
            "Extract ALL text from this scanned document. "
            "Preserve the original layout, headings, and structure as much as possible. "
            "Return only the extracted text, no commentary."
        )},
    ]
    content.extend(images)

    payload = {
        "model": OPENAI_MODEL,
        "input": [{"role": "user", "content": content}],
    }

    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=120,
        )
        if r.status_code >= 400:
            print(f"OCR: OpenAI vision error {r.status_code}: {(r.text or '')[:500]}", flush=True)
            return ""

        resp_json = r.json()
        text_out = resp_json["output"][0]["content"][0]["text"]
        text_out = (_strip_nulls(text_out) or "").strip()
        print(f"OCR: extracted {len(text_out)} chars", flush=True)
        return text_out
    except Exception as e:
        print(f"OCR: vision request failed: {e}", flush=True)
        return ""


def _ocr_image_via_vision(data: bytes, content_type: str) -> str:
    """
    OCR a standalone image file (JPEG, PNG, etc.) via OpenAI vision API.
    """
    api_key = OPENAI_API_KEY
    if not api_key:
        return ""

    # Map content type to data URI media type
    ct = (content_type or "").lower()
    if "png" in ct:
        media = "image/png"
    elif "webp" in ct:
        media = "image/webp"
    elif "gif" in ct:
        media = "image/gif"
    else:
        media = "image/jpeg"  # default for jpg/bmp/tiff/unknown

    b64 = base64.b64encode(data).decode("ascii")
    print(f"OCR image: sending {len(data)} bytes as {media} to vision API", flush=True)

    content: List[Dict[str, Any]] = [
        {"type": "input_text", "text": (
            "Extract ALL text from this scanned document image. "
            "Preserve the original layout, headings, and structure as much as possible. "
            "Return only the extracted text, no commentary."
        )},
        {
            "type": "image_url",
            "image_url": {"url": f"data:{media};base64,{b64}", "detail": "high"},
        },
    ]

    payload = {
        "model": OPENAI_MODEL,
        "input": [{"role": "user", "content": content}],
    }

    try:
        r = requests.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=120,
        )
        if r.status_code >= 400:
            print(f"OCR image: OpenAI vision error {r.status_code}: {(r.text or '')[:500]}", flush=True)
            return ""

        resp_json = r.json()
        text_out = resp_json["output"][0]["content"][0]["text"]
        text_out = (_strip_nulls(text_out) or "").strip()
        print(f"OCR image: extracted {len(text_out)} chars", flush=True)
        return text_out
    except Exception as e:
        print(f"OCR image: vision request failed: {e}", flush=True)
        return ""


def _extract_text_docx(data: bytes) -> str:
    doc = Document(io.BytesIO(data))
    parts: List[str] = []
    for p in doc.paragraphs:
        t = _strip_nulls(p.text) or ""
        if t.strip():
            parts.append(t)
    return "\n".join(parts).strip()


def _guess_ext(filename: str, content_type: str) -> str:
    fn = (filename or "").lower()
    ct = (content_type or "").lower()
    if fn.endswith(".pdf") or "pdf" in ct:
        return "pdf"
    if fn.endswith(".docx") or "wordprocessingml" in ct:
        return "docx"
    if fn.endswith(".txt") or "text/plain" in ct:
        return "txt"
    if any(fn.endswith(e) for e in (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".tif")):
        return "image"
    if any(t in ct for t in ("image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/tiff")):
        return "image"
    return "unknown"


def _truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[:n] + "\n\n[TRUNCATED]\n"


def _compute_soft_gate_pic_met(result: Dict[str, Any]) -> Optional[bool]:
    """
    Soft gate rule:
      TT >= PIC_SOFT_GATE_TT AND PIC >= PIC_SOFT_GATE_PIC
    Returns None if either metric is missing.
    """
    pm = result.get("pilot_metrics") or {}
    tt = pm.get("total_time_hours")
    pic = pm.get("pic_time_hours")
    if isinstance(tt, (int, float)) and isinstance(pic, (int, float)):
        return (tt >= PIC_SOFT_GATE_TT) and (pic >= PIC_SOFT_GATE_PIC)
    return None


def _compute_soft_gate_pic_status(result: Dict[str, Any]) -> Optional[str]:
    """
    Human-readable PIC gate status string.
    The frontend picGateShort() checks:
      - starts with "meets" → Met
      - starts with "close" or contains "near" → Close
      - anything else → Not met
    """
    pm = result.get("pilot_metrics") or {}
    tt = pm.get("total_time_hours")
    pic = pm.get("pic_time_hours")
    if not isinstance(tt, (int, float)) or not isinstance(pic, (int, float)):
        return None
    tt_ok = tt >= PIC_SOFT_GATE_TT
    pic_ok = pic >= PIC_SOFT_GATE_PIC
    if tt_ok and pic_ok:
        return "Meets requirements"
    # "Close" if both are at least 75% of the threshold
    if tt >= PIC_SOFT_GATE_TT * 0.75 and pic >= PIC_SOFT_GATE_PIC * 0.75:
        return "Close — near minimums"
    return "Does not meet minimums"


def _openai_extract(resume_text: str) -> Dict[str, Any]:
    """
    Uses OpenAI Responses API with strict JSON schema.
    """
    api_key = _require("OPENAI_API_KEY", OPENAI_API_KEY)

    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "category",
            "employment_type",
            "candidate",
            "pilot_metrics",
            "type_ratings",
            "notes",
            "confidence",
        ],
        "properties": {
            "category": {
                "type": "string",
                "enum": [
                    "pilot_pic", "pilot_sic", "dispatcher",
                    "maintenance", "sales", "hr", "admin",
                    "management", "line_service", "other",
                ],
            },
            "employment_type": {
                "type": "string",
                "enum": ["hourly", "salary", "contract", "unknown"],
            },
            "candidate": {
                "type": "object",
                "additionalProperties": False,
                # IMPORTANT: OpenAI schema validator requires required to include every property key
                "required": ["name", "email", "phone", "location"],
                "properties": {
                    "name": {"type": ["string", "null"]},
                    "email": {"type": ["string", "null"]},
                    "phone": {"type": ["string", "null"]},
                    "location": {"type": ["string", "null"]},
                },
            },
            "pilot_metrics": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "total_time_hours",
                    "turbine_time_hours",
                    "pic_time_hours",
                    "sic_time_hours",
                ],
                "properties": {
                    "total_time_hours": {"type": ["number", "null"]},
                    "turbine_time_hours": {"type": ["number", "null"]},
                    "pic_time_hours": {"type": ["number", "null"]},
                    "sic_time_hours": {"type": ["number", "null"]},
                },
            },
            "type_ratings": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "has_citation_x",
                    "has_challenger_300",
                    "ratings",
                    "raw_snippet",
                ],
                "properties": {
                    "has_citation_x": {"type": ["boolean", "null"]},
                    "has_challenger_300": {"type": ["boolean", "null"]},
                    "ratings": {"type": "array", "items": {"type": "string"}},
                    "raw_snippet": {"type": ["string", "null"]},
                },
            },
            "notes": {"type": ["string", "null"]},
            "confidence": {
                "type": ["object", "null"],
                "additionalProperties": {"type": "number"},
            },
        },
    }

    instructions = """
You extract structured hiring signals from resumes and cover letters.

Return ONLY valid JSON that matches the provided JSON Schema.

Rules:

- category:
  - pilot_pic if applicant clearly indicates PIC time OR captain experience.
  - pilot_sic if applicant indicates SIC / First Officer time but PIC not clearly stated.
  - dispatcher if dispatch or flight-following role.
  - maintenance if A&P mechanic, avionics tech, or any aircraft maintenance role.
  - sales if sales, business development, or charter sales.
  - hr if human resources, recruiting, or talent acquisition.
  - admin if administrative, office, or executive assistant role.
  - management if operations manager, director, chief pilot, or similar leadership.
  - line_service if line service, FBO ramp, fueling, or ground handling.
  - other if none of the above clearly fits.

- employment_type:
  - hourly if applicant explicitly mentions hourly rate, day rate, contract rate, or similar.
  - otherwise unknown.

- pilot_metrics:
  - Parse numeric hour totals.
  - Example: "Total Time: 4,200" => 4200
  - If not present, return null.

- type_ratings:
  - has_citation_x: true ONLY if the resume explicitly lists "Citation X", "CE-750", "CE750", or "C750"
    as a TYPE RATING held by the applicant. Do NOT set true for other Citation variants (Citation II,
    Citation III, Citation V, Citation Sovereign, Citation Latitude, Citation Excel, Citation Mustang,
    C550, C560, C650, C680, etc.) — those are different aircraft. Do NOT infer from generic "Cessna"
    or "Citation" mentions without the specific X/CE-750/C750 designation.
  - has_challenger_300: true if the resume explicitly lists "Challenger 300", "Challenger 350",
    "CL-300", or "CL-350" as a TYPE RATING. The 300 and 350 share the same type certificate.
    Do NOT set true for generic "Challenger" without a model number, or other Bombardier/Canadair
    variants (CRJ, Global, Learjet, etc.).
  - ratings: list only the specific type rating codes/names explicitly mentioned (e.g. CE-750, CL-300).
    Normalize to standard format. Do not infer or guess ratings not clearly stated.
  - raw_snippet: the exact small text snippet from the resume where type ratings appear.

- notes:
  - short summary focused on TT, PIC, turbine, SIC, and aircraft type ratings.
"""

    payload = {
        "model": OPENAI_MODEL,
        "input": [
            {"role": "system", "content": instructions.strip()},
            {"role": "user", "content": resume_text},
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "job_resume_extract",
                "schema": schema,
            }
        },
    }

    r = requests.post(
        "https://api.openai.com/v1/responses",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=90,
    )

    if r.status_code >= 400:
        raise RuntimeError(f"OpenAI error {r.status_code}: {(r.text or '')[:2000]}")

    data = r.json()

    try:
        text_out = data["output"][0]["content"][0]["text"]
        return json.loads(text_out)
    except Exception:
        raise RuntimeError(
            f"Could not parse OpenAI response into JSON. Raw={(r.text or '')[:2000]}"
        )


def _upsert_parse_row(supa: Client, application_id: int, result: Dict[str, Any]) -> None:
    # sanitize again (cheap insurance)
    result = _sanitize_for_db(result)

    candidate = result.get("candidate") or {}
    pm = result.get("pilot_metrics") or {}
    tr = result.get("type_ratings") or {}

    soft_gate_pic_met = result.get("soft_gate_pic_met")
    if soft_gate_pic_met is None:
        soft_gate_pic_met = _compute_soft_gate_pic_met(result)

    soft_gate_pic_status = result.get("soft_gate_pic_status")
    if soft_gate_pic_status is None:
        soft_gate_pic_status = _compute_soft_gate_pic_status(result)

    row = {
        "application_id": application_id,

        # core outputs
        "category": result.get("category"),
        "employment_type": result.get("employment_type"),

        # candidate fields
        "candidate_name": candidate.get("name"),
        "email": candidate.get("email"),
        "phone": candidate.get("phone"),
        "location": candidate.get("location"),

        # pilot metrics
        "total_time_hours": pm.get("total_time_hours"),
        "turbine_time_hours": pm.get("turbine_time_hours"),
        "pic_time_hours": pm.get("pic_time_hours"),
        "sic_time_hours": pm.get("sic_time_hours"),

        # type ratings
        "has_citation_x": tr.get("has_citation_x"),
        "has_challenger_300_type_rating": tr.get("has_challenger_300"),
        "type_ratings": tr.get("ratings") or [],
        "type_ratings_raw": tr.get("raw_snippet"),

        # soft gate
        "soft_gate_pic_met": soft_gate_pic_met,
        "soft_gate_pic_status": soft_gate_pic_status,

        # misc
        "notes": result.get("notes"),
        "confidence": result.get("confidence"),
        "raw_extraction": result,
        "model": OPENAI_MODEL,
    }

    supa.table(PARSE_TABLE).upsert(row, on_conflict="application_id").execute()


def _fetch_files_for_application(supa: Client, application_id: int) -> List[Dict[str, Any]]:
    res = (
        supa.table(FILES_TABLE)
        .select("id,application_id,filename,content_type,gcs_bucket,gcs_key,size_bytes,created_at")
        .eq("application_id", application_id)
        .order("created_at", desc=False)
        .execute()
    )
    return getattr(res, "data", None) or []


def _already_parsed(supa: Client, application_id: int) -> bool:
    res = (
        supa.table(PARSE_TABLE)
        .select("id")
        .eq("application_id", application_id)
        .limit(1)
        .execute()
    )
    data = getattr(res, "data", None) or []
    return bool(data)


def _pick_next_applications(supa: Client, limit: int) -> List[Dict[str, Any]]:
    """
    Simple queue: scan recent applications and skip those already parsed.
    """
    res = (
        supa.table(APPS_TABLE)
        .select("id,mailbox,role_bucket,subject,received_at,source_message_id,created_at")
        .order("created_at", desc=True)
        .limit(300)
        .execute()
    )
    apps = getattr(res, "data", None) or []

    out: List[Dict[str, Any]] = []
    for a in apps:
        aid = a.get("id")
        if not aid:
            continue
        if _already_parsed(supa, int(aid)):
            continue
        out.append(a)
        if len(out) >= limit:
            break
    return out


def _parse_iso_dt(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    # accept Z or +00:00
    s = s.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iso_days_ago(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=int(days))


# -------------------------
# Routes
# -------------------------

@app.get("/api/files/{file_id}")
def api_file_redirect(file_id: int):
    """
    Stable file URL:
      /api/files/{file_id} -> 302 redirect to a fresh signed GCS URL
    """
    f = safe_select_one(
        FILES_TABLE,
        "id, gcs_bucket, gcs_key, filename, content_type",
        eq={"id": file_id},
    )
    if not f:
        raise HTTPException(status_code=404, detail="file not found")

    signed_url = _get_gcs_signed_url(
        f.get("gcs_bucket") or "",
        f.get("gcs_key") or "",
        expires_seconds=7200,  # 2 hours
    )
    if not signed_url:
        raise HTTPException(status_code=500, detail="could not sign url")

    return RedirectResponse(url=signed_url, status_code=302)


@app.get("/_health")
def health():
    return {"ok": True}


@app.get("/debug/application/{application_id}")
def debug_application(application_id: int):
    """
    Diagnostic endpoint: show file rows, GCS blob status, and detected
    file types for a given application_id — without actually parsing.
    """
    supa = _supa()
    bucket = _gcs_bucket()

    files = _fetch_files_for_application(supa, application_id)
    file_details: List[Dict[str, Any]] = []

    for f in files:
        filename = f.get("filename") or ""
        content_type = f.get("content_type") or ""
        gcs_key = f.get("gcs_key") or ""
        ext = _guess_ext(filename, content_type)

        # Check GCS blob existence + size
        gcs_exists = False
        gcs_size = None
        if gcs_key:
            try:
                blob = bucket.blob(gcs_key)
                gcs_exists = blob.exists()
                if gcs_exists:
                    blob.reload()
                    gcs_size = blob.size
            except Exception as e:
                gcs_exists = f"error: {e}"

        file_details.append({
            "file_id": f.get("id"),
            "filename": filename,
            "content_type": content_type,
            "detected_ext": ext,
            "gcs_key": gcs_key,
            "gcs_exists": gcs_exists,
            "gcs_size_bytes": gcs_size,
            "db_size_bytes": f.get("size_bytes"),
        })

    # Also check the application row itself
    app_row = safe_select_one(
        APPS_TABLE,
        "id, mailbox, role_bucket, subject, received_at, created_at, source_message_id",
        eq={"id": application_id},
    )

    return {
        "ok": True,
        "application_id": application_id,
        "application": app_row,
        "file_count": len(files),
        "files": file_details,
    }


@app.post("/jobs/parse_application")
def parse_application(application_id: int = Query(..., ge=1)):
    supa = _supa()
    bucket = _gcs_bucket()

    files = _fetch_files_for_application(supa, application_id)
    print(f"PARSE app={application_id} found {len(files) if files else 0} file rows", flush=True)
    if not files:
        raise HTTPException(
            status_code=404,
            detail=f"No files found for application_id={application_id}",
        )

    # Log every file row for debugging
    for i, f in enumerate(files):
        print(f"  FILE[{i}] id={f.get('id')} fn={f.get('filename')} ct={f.get('content_type')} gcs_key={f.get('gcs_key')}", flush=True)

    chunks: List[str] = []
    total_chars = 0
    used_files: List[Dict[str, Any]] = []

    for f in files:
        filename = f.get("filename") or ""
        content_type = f.get("content_type") or ""
        gcs_key = f.get("gcs_key")
        if not gcs_key:
            print(f"  SKIP app={application_id} file={filename} — no gcs_key", flush=True)
            continue

        ext = _guess_ext(filename, content_type)
        print(f"PARSE app={application_id} file={filename} ct={content_type} ext={ext}", flush=True)
        if ext not in ("pdf", "docx", "txt", "image"):
            print(f"  -> skipping unsupported type", flush=True)
            continue

        try:
            blob_bytes = _download_gcs_bytes(bucket, gcs_key)
        except Exception as e:
            print(f"  -> GCS download failed: {e}", flush=True)
            continue

        if ext == "pdf":
            text = _extract_text_pdf(blob_bytes)
            # Fallback: scanned/image PDFs — use OpenAI vision OCR
            if not text.strip():
                print(f"PDF text extraction empty for {filename}, trying vision OCR...", flush=True)
                text = _ocr_pdf_via_vision(blob_bytes)
        elif ext == "image":
            text = _ocr_image_via_vision(blob_bytes, content_type)
        elif ext == "docx":
            text = _extract_text_docx(blob_bytes)
        else:
            try:
                text = blob_bytes.decode("utf-8", errors="ignore")
            except Exception:
                text = ""

        text = (_strip_nulls(text) or "").strip()
        if not text:
            continue

        text = _truncate(text, MAX_CHARS_PER_FILE)

        header = f"\n\n===== FILE: {filename} ({content_type}) =====\n"
        piece = header + text

        if total_chars + len(piece) > MAX_TOTAL_CHARS:
            break

        chunks.append(piece)
        total_chars += len(piece)
        used_files.append(
            {"filename": filename, "gcs_key": gcs_key, "content_type": content_type}
        )

    if not chunks:
        raise HTTPException(
            status_code=422,
            detail="No parseable text found in files (pdf/docx/txt/image).",
        )

    combined_text = _strip_nulls("\n".join(chunks)) or "\n".join(chunks)

    print("DEBUG TEXT LENGTH:", len(combined_text))
    print("DEBUG TEXT SAMPLE:", combined_text[:1500])

    # OpenAI extraction
    try:
        extracted = _openai_extract(combined_text)
    except Exception as e:
        print(f"OpenAI extraction failed: {e}", flush=True)
        raise HTTPException(status_code=500, detail="OpenAI extraction failed")

    # sanitize + compute soft gate
    extracted = _sanitize_for_db(extracted)
    extracted["soft_gate_pic_met"] = _compute_soft_gate_pic_met(extracted)

    # Upsert parse row
    try:
        _upsert_parse_row(supa, application_id, extracted)
    except Exception as e:
        print(f"Supabase upsert failed: {e}", flush=True)
        raise HTTPException(status_code=500, detail="Supabase upsert failed")

    return {
        "ok": True,
        "application_id": application_id,
        "model": OPENAI_MODEL,
        "files_used": used_files,
        "extracted": extracted,
    }


@app.post("/jobs/parse_next")
def parse_next(limit: int = Query(10, ge=1, le=50)):
    supa = _supa()
    apps = _pick_next_applications(supa, limit=limit)

    results: List[Dict[str, Any]] = []
    for a in apps:
        aid = int(a["id"])
        try:
            out = parse_application(application_id=aid)  # reuse route logic
            extracted = out.get("extracted") or {}
            results.append(
                {
                    "application_id": aid,
                    "status": "parsed",
                    "category": extracted.get("category"),
                    "soft_gate_pic_met": extracted.get("soft_gate_pic_met"),
                }
            )
        except HTTPException as e:
            results.append(
                {"application_id": aid, "status": "failed", "error": str(e.detail)}
            )

    return {"ok": True, "attempted": len(apps), "results": results}


@app.post("/jobs/parse_backlog")
def parse_backlog(
    days: int = Query(90, ge=1, le=365),
    limit: int = Query(25, ge=1, le=100),
):
    """
    Parse up to `limit` unparsed applications from the last `days` days.

    Uses job_applications.received_at (fallback to created_at) for windowing.
    Skips any application_id already present in job_application_parse.
    """
    supa = _supa()

    # pull a reasonably large window, then filter in-memory (keeps it simple)
    res = (
        supa.table(APPS_TABLE)
        .select("id,mailbox,role_bucket,subject,received_at,created_at,source_message_id")
        .order("created_at", desc=True)
        .limit(2000)
        .execute()
    )
    apps = getattr(res, "data", None) or []

    cutoff = _iso_days_ago(days)

    recent: List[Dict[str, Any]] = []
    for a in apps:
        dt = _parse_iso_dt(a.get("received_at")) or _parse_iso_dt(a.get("created_at"))
        if not dt:
            continue
        if dt >= cutoff:
            recent.append(a)

    # newest first by received_at/created_at string (good enough after filtering)
    recent.sort(key=lambda x: str(x.get("received_at") or x.get("created_at") or ""), reverse=True)

    # get parsed ids (limit big enough for typical 3 month window; if huge we can optimize later)
    parsed = safe_select_many(PARSE_TABLE, "application_id", limit=20000) or []
    parsed_ids = {int(r["application_id"]) for r in parsed if r.get("application_id") is not None}

    to_parse = []
    for a in recent:
        aid = a.get("id")
        if aid is None:
            continue
        if int(aid) in parsed_ids:
            continue
        to_parse.append(a)
        if len(to_parse) >= int(limit):
            break

    results: List[Dict[str, Any]] = []
    parsed_n = 0
    failed_n = 0

    for a in to_parse:
        aid = int(a["id"])
        try:
            out = parse_application(application_id=aid)
            extracted = out.get("extracted") or {}
            results.append(
                {
                    "application_id": aid,
                    "status": "parsed",
                    "category": extracted.get("category"),
                    "soft_gate_pic_met": extracted.get("soft_gate_pic_met"),
                }
            )
            parsed_n += 1
        except HTTPException as e:
            results.append({"application_id": aid, "status": "failed", "error": str(e.detail)})
            failed_n += 1

    return {
        "ok": True,
        "days": int(days),
        "limit": int(limit),
        "eligible_recent": len(recent),
        "attempted": len(to_parse),
        "parsed": parsed_n,
        "failed": failed_n,
        "results": results,
    }


# ---------------------------------------------------------------------
# API: Jobs (Dashboard)
# ---------------------------------------------------------------------

@app.get("/api/jobs")
def api_jobs(
    limit: int = Query(50, ge=1, le=200),
    q: Optional[str] = None,
    category: Optional[str] = None,
    employment_type: Optional[str] = None,
    needs_review: Optional[bool] = None,
    soft_gate_pic_met: Optional[bool] = None,
    has_challenger_300_type_rating: Optional[bool] = None,
) -> Dict[str, Any]:
    """
    Returns parsed job applications (1 row per application in parse table).
    Mirrors invoice-alerts /api/invoices list behavior.
    """
    rows = safe_select_many(
        PARSE_TABLE,
        "id, application_id, created_at, updated_at, category, employment_type, "
        "candidate_name, email, phone, location, "
        "total_time_hours, turbine_time_hours, pic_time_hours, sic_time_hours, "
        "has_citation_x, has_challenger_300_type_rating, type_ratings, "
        "soft_gate_pic_met, soft_gate_pic_status, needs_review, notes, model",
        limit=2000,
    ) or []

    qn = (q or "").strip().lower()
    if qn:
        def _matches(r: Dict[str, Any]) -> bool:
            hay = " ".join([
                str(r.get("candidate_name") or ""),
                str(r.get("email") or ""),
                str(r.get("phone") or ""),
                str(r.get("location") or ""),
                str(r.get("category") or ""),
                str(r.get("employment_type") or ""),
                str(r.get("soft_gate_pic_status") or ""),
                str(r.get("notes") or ""),
            ]).lower()
            return qn in hay

        rows = [r for r in rows if _matches(r)]

    if category:
        rows = [r for r in rows if (r.get("category") or "") == category]

    if employment_type:
        rows = [r for r in rows if (r.get("employment_type") or "") == employment_type]

    if needs_review is not None:
        rows = [r for r in rows if bool(r.get("needs_review")) == needs_review]

    if soft_gate_pic_met is not None:
        rows = [r for r in rows if bool(r.get("soft_gate_pic_met")) == soft_gate_pic_met]

    if has_challenger_300_type_rating is not None:
        rows = [r for r in rows if bool(r.get("has_challenger_300_type_rating")) == has_challenger_300_type_rating]

    rows = sorted(rows, key=lambda r: str(r.get("created_at") or ""), reverse=True)[: int(limit)]

    return {"ok": True, "count": len(rows), "jobs": rows}


# ---------------------------------------------------------------------
# API: Job Detail
# ---------------------------------------------------------------------

@app.get("/api/jobs/{application_id}")
def api_job_detail(application_id: int) -> Dict[str, Any]:
    """
    Returns full job parse detail including:
      - all parsed fields
      - raw_extraction
      - confidence
      - signed file URLs (resume PDFs, etc.)

    Mirrors invoice-alerts /api/invoices/{document_id}.
    """

    # Fetch parsed job row
    job = safe_select_one(
        PARSE_TABLE,
        "*",
        eq={"application_id": application_id},
    )

    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    # Fetch associated files
    files = safe_select_many(
        FILES_TABLE,
        "id, application_id, created_at, gcs_bucket, gcs_key, filename, content_type, size_bytes",
        eq={"application_id": application_id},
        limit=50,
    ) or []

    signed_files: List[Dict[str, Any]] = []

    for f in files:
        signed_url = None
        try:
            signed_url = _get_gcs_signed_url(
                f.get("gcs_bucket") or "",
                f.get("gcs_key") or "",
            )
        except Exception:
            signed_url = None

        signed_files.append(
            {
                "id": f.get("id"),
                "filename": f.get("filename"),
                "content_type": f.get("content_type"),
                "size_bytes": f.get("size_bytes"),
                "created_at": f.get("created_at"),
                "signed_url": signed_url,
            }
        )

    return {
        "ok": True,
        "job": job,
        "files": signed_files,
    }