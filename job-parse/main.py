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

from pypdf import PdfReader
from docx import Document
from starlette.responses import RedirectResponse

from datetime import datetime, timedelta, timezone

app = FastAPI()
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


def _get_gcs_signed_url(bucket_name: str, gcs_key: str, expires_seconds: int = 604800) -> Optional[str]:
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
                "enum": ["pilot_sic", "pilot_pic", "dispatcher", "sales", "other"],
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
  - dispatcher / sales / other as appropriate.

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
        expires_seconds=604800,
    )
    if not signed_url:
        raise HTTPException(status_code=500, detail="could not sign url")

    return RedirectResponse(url=signed_url, status_code=302)


@app.get("/_health")
def health():
    return {"ok": True}


@app.post("/jobs/parse_application")
def parse_application(application_id: int = Query(..., ge=1)):
    supa = _supa()
    bucket = _gcs_bucket()

    files = _fetch_files_for_application(supa, application_id)
    if not files:
        raise HTTPException(
            status_code=404,
            detail=f"No files found for application_id={application_id}",
        )

    chunks: List[str] = []
    total_chars = 0
    used_files: List[Dict[str, Any]] = []

    for f in files:
        filename = f.get("filename") or ""
        content_type = f.get("content_type") or ""
        gcs_key = f.get("gcs_key")
        if not gcs_key:
            continue

        ext = _guess_ext(filename, content_type)
        if ext not in ("pdf", "docx", "txt"):
            # skip images and unknown types for now
            continue

        try:
            blob_bytes = _download_gcs_bytes(bucket, gcs_key)
        except Exception:
            continue

        if ext == "pdf":
            text = _extract_text_pdf(blob_bytes)
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
            detail="No parseable text found in files (pdf/docx/txt).",
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