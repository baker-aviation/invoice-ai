#!/usr/bin/env python3
"""
process_pdf.py

End-to-end PDF processor:
- Detect single vs statement
- Split if needed
- Extract invoice JSON(s)
- Validate
- Persist to Supabase (documents, parsed_invoices, parsed_line_items, invoice_errors)
- Write manifest.json

Hardening included:
✅ Scrubs NUL bytes (\x00) to prevent Postgres 22P05
✅ Clears previous is_latest for the SAME logical invoice (document_id + source_invoice_id) before upsert
✅ Idempotent upserts (document + parsed_invoice)
✅ Statement-safe source_invoice_id
✅ Best-effort soft duplicate checks (does NOT require schema changes)
✅ Keeps working for non-part / FBO / “other” invoices (doc_type defaults to "other")
✅ Treats business-unique duplicates as a handled condition (won’t fail the whole job)

Env required:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
Also required for extraction:
  OPENAI_API_KEY

Optional:
  EXTRACTION_VERSION
  PARSER_VERSION (defaults to EXTRACTION_VERSION or "0.1.0")
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from extract_invoice import read_pdf_text


# ---------------------------
# Exceptions
# ---------------------------

class DuplicateInvoiceError(Exception):
    """Raised when parsed_invoices_business_unique rejects insert/upsert (business duplicate)."""
    pass


# ---------------------------
# Helpers
# ---------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def run(cmd: List[str]) -> None:
    subprocess.check_call(cmd)

def load_json_file(p: Path) -> Dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8"))

def write_manifest(out_dir: Path, payload: Dict[str, Any]) -> Path:
    p = out_dir / "manifest.json"
    p.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return p


# ---------------------------
# Text Scrubbing (Prevents Postgres 22P05)
# ---------------------------

def scrub_text(s: Optional[str]) -> Optional[str]:
    if s is None:
        return None
    # Postgres cannot store NUL bytes in text/json fields
    return s.replace("\x00", "")

def scrub_obj(x):
    if isinstance(x, str):
        return scrub_text(x)
    if isinstance(x, list):
        return [scrub_obj(v) for v in x]
    if isinstance(x, dict):
        return {k: scrub_obj(v) for k, v in x.items()}
    return x


# ---------------------------
# Invoice ID detection (statement heuristic)
# ---------------------------

INV_PATTERNS = [
    re.compile(r"\bRef Number\s+([A-Z0-9-]{6,})\b", re.I),
    re.compile(r"\bInvoice\s+(?:No\.?|#|Number)?\s*([A-Z0-9-]{3,})\b", re.I),
    re.compile(r"\bCredit Memo No\.?:\s*([A-Z0-9-]{3,})\b", re.I),
    re.compile(r"\bINV\d{6,}\b", re.I),
]

def detect_invoice_ids(text: str) -> List[str]:
    ids = set()
    for pat in INV_PATTERNS:
        for m in pat.finditer(text or ""):
            if m.groups():
                ids.add(m.group(1))
            else:
                ids.add(m.group(0))

    # For Avfuel activity invoices, also detect receipt numbers (7-9 digit
    # integers at the start of table rows) so they appear in detected_invoice_ids.
    if is_avfuel_activity_invoice(text or ""):
        master_ref = None
        m_ref = _MASTER_REF_RE.search(text or "")
        if m_ref:
            master_ref = m_ref.group(1)
        for m in _RECEIPT_LINE_RE.finditer(text or ""):
            receipt_no = m.group(1)
            if master_ref and receipt_no == master_ref:
                continue
            ids.add(receipt_no)

    return sorted(ids)

def maybe_statement_gate(text: str, invoice_ids: List[str]) -> Tuple[bool, int]:
    page_count = text.count("--- PAGE")
    # Relax: allow even single-page docs if multiple invoice IDs detected
    has_multi_ids = len(invoice_ids) >= 2
    has_multi_pages = page_count >= 2
    has_statement_markers = (
        "Ref Number" in (text or "")
        or bool(re.search(r"\bCredit Memo\b", text or "", re.I))
        or bool(re.search(r"\bInvoice\b", text or "", re.I))
    )
    maybe_statement = has_multi_ids or (has_multi_pages and has_statement_markers)
    return maybe_statement, page_count


# ---------------------------
# Text-based statement splitting (handles multi-invoice-per-page)
# ---------------------------

_SECTION_BOUNDARY_PATTERNS = [
    re.compile(r"\bRef Number\s+([A-Z0-9][A-Z0-9-]*)\b", re.I),
    re.compile(r"\bInvoice\s+(?:No\.?|#|Number)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})\b", re.I),
    re.compile(r"\bCredit Memo\s+(?:No\.?|#|Number)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})\b", re.I),
    re.compile(r"\b(INV\d{6,})\b", re.I),
]

# IDs that are clearly not invoice numbers
_BAD_SECTION_ID = re.compile(
    r"^(?:PAGE|DATE|CUSTOMER|TOTAL|USD|AMOUNT|NUMBER|THE|AND|FOR|TAX|NET)$", re.I
)



# ---------------------------
# Avfuel activity invoice splitting (tabular multi-invoice)
# ---------------------------

_AVFUEL_ACTIVITY_RE = re.compile(r"ACTIVITY\s+INVOICE", re.I)
_AVFUEL_VENDOR_RE = re.compile(r"AVFUEL", re.I)

# Receipt numbers: 7-9 digit integers at the start of a line (after optional whitespace).
# Avfuel receipt numbers are typically 8 digits (e.g. 24135600).
_RECEIPT_LINE_RE = re.compile(r"^\s{0,20}(\d{7,9})\b", re.MULTILINE)

# Master REF NO line — we skip this to avoid creating a section for the header ref
_MASTER_REF_RE = re.compile(r"REF\s+(?:NO|NUMBER)\s*:?\s*(\d+)", re.I)


def is_avfuel_activity_invoice(text: str) -> bool:
    """Detect Avfuel activity invoice format."""
    return bool(_AVFUEL_ACTIVITY_RE.search(text) and _AVFUEL_VENDOR_RE.search(text))


def split_avfuel_activity_invoice(text: str) -> List[Tuple[str, str]]:
    """
    Split an Avfuel Activity Invoice into per-receipt text sections.
    Each receipt row in the table becomes its own section, prefixed with
    the document header context so the LLM can extract vendor/customer info.

    Returns list of (receipt_number, text_section) tuples.
    Returns empty list if not an Avfuel activity invoice or < 2 receipts found.
    """
    if not is_avfuel_activity_invoice(text):
        return []

    # Find the master REF NO so we can exclude it from receipt matches
    master_ref = None
    m_ref = _MASTER_REF_RE.search(text)
    if m_ref:
        master_ref = m_ref.group(1)

    # Find all receipt number positions
    matches = []
    for m in _RECEIPT_LINE_RE.finditer(text):
        receipt_no = m.group(1)
        # Skip if this is the master REF NO
        if master_ref and receipt_no == master_ref:
            continue
        matches.append((m.start(), receipt_no))

    if len(matches) < 2:
        return []

    # Extract header context (everything before the first receipt row).
    # This includes vendor name, customer, period, column headers, etc.
    header = text[:matches[0][0]].strip()

    # Split text at each receipt boundary
    sections: List[Tuple[str, str]] = []
    for i, (pos, receipt_no) in enumerate(matches):
        end = matches[i + 1][0] if i + 1 < len(matches) else len(text)
        receipt_text = text[pos:end].strip()

        # Skip if the receipt text looks like a TOTAL/summary line
        if re.match(r"^\s*\d+\s*$", receipt_text):
            continue

        # Build synthetic section: header context + this receipt's data
        section = (
            f"{header}\n\n"
            f"--- SINGLE RECEIPT FROM ACTIVITY INVOICE ---\n"
            f"Receipt Number: {receipt_no}\n"
            f"{receipt_text}\n"
        )
        sections.append((receipt_no, section))

    return sections if len(sections) >= 2 else []


def split_text_into_sections(text: str) -> List[Tuple[str, str]]:
    """
    Split extracted PDF text into invoice sections by detecting invoice ID
    boundaries. Works even when multiple invoices share a single page.

    Returns list of (invoice_id, text_section) tuples.
    Returns empty list if fewer than 2 distinct invoices found.
    """
    matches: List[Tuple[int, str]] = []
    for pat in _SECTION_BOUNDARY_PATTERNS:
        for m in pat.finditer(text or ""):
            inv_id = (m.group(1) if m.groups() else m.group(0)).strip()
            if not inv_id or len(inv_id) < 3:
                continue
            if _BAD_SECTION_ID.match(inv_id):
                continue
            # Find start of the line containing this match
            line_start = text.rfind("\n", 0, m.start())
            line_start = 0 if line_start < 0 else line_start + 1
            matches.append((line_start, inv_id))

    if not matches:
        return []

    # Sort by position in text
    matches.sort(key=lambda x: x[0])

    # Deduplicate: merge consecutive matches with the same invoice ID
    # (handles multi-page invoices where the same ID appears on each page)
    deduped: List[Tuple[int, str]] = [matches[0]]
    for pos, inv_id in matches[1:]:
        if inv_id != deduped[-1][1]:
            deduped.append((pos, inv_id))

    if len(deduped) < 2:
        return []

    # Split text at boundaries
    sections: List[Tuple[str, str]] = []
    for i, (pos, inv_id) in enumerate(deduped):
        end_pos = deduped[i + 1][0] if i + 1 < len(deduped) else len(text)
        section_text = text[pos:end_pos].strip()
        if section_text:
            sections.append((inv_id, section_text))

    return sections


# ---------------------------
# Date normalization
# ---------------------------

DATE_CLEAN_RE = re.compile(r"[,\.\s]+$")

def normalize_date_to_iso(date_str: Optional[str]) -> Optional[str]:
    if not date_str:
        return None
    s = str(date_str).strip()
    s = DATE_CLEAN_RE.sub("", s)  # remove trailing "." or ","
    # already ISO?
    for fmt in ("%Y-%m-%d",):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass
    # common US formats
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%m-%d-%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass
    # common long formats
    for fmt in ("%b %d %Y", "%B %d %Y", "%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass
    return None


# ---------------------------
# Validation runner
# ---------------------------

def validate_json(path: Path) -> Dict[str, Any]:
    out = subprocess.check_output(["python3", "validate_invoice.py", "--infile", str(path)], text=True)
    return json.loads(out)


# ---------------------------
# Supabase REST client (requests-only)
# ---------------------------

@dataclass
class Supa:
    url: str
    key: str

    def _rest(self, method: str, table: str, *, params=None, json_body=None, prefer: str = ""):
        base = self.url.rstrip("/")
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        endpoint = f"{base}/rest/v1/{table}"
        resp = requests.request(method, endpoint, params=params, json=json_body, headers=headers, timeout=120)

        if resp.status_code >= 300:
            # Treat business-unique duplicates as handled (do not crash worker)
            if resp.status_code == 409 and "parsed_invoices_business_unique" in (resp.text or ""):
                raise DuplicateInvoiceError(resp.text)
            raise RuntimeError(f"Supabase REST error {resp.status_code}: {resp.text}")

        if resp.text.strip():
            return resp.json()
        return None

    # documents: upsert by (gcs_bucket, gcs_path)
    def upsert_documents(self, row: Dict[str, Any]) -> Dict[str, Any]:
        data = self._rest(
            "POST",
            "documents",
            params={"on_conflict": "gcs_bucket,gcs_path", "select": "*"},
            json_body=row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return data[0]

    def update_document(self, doc_id: str, patch: Dict[str, Any]) -> None:
        self._rest(
            "PATCH",
            "documents",
            params={"id": f"eq.{doc_id}"},
            json_body=patch,
            prefer="return=minimal",
        )

    def insert_invoice_error(self, row: Dict[str, Any]) -> None:
        self._rest(
            "POST",
            "invoice_errors",
            json_body=row,
            prefer="return=minimal",
        )

    # parsed_invoices: upsert by (document_id, source_invoice_id, parser_version)
    def upsert_parsed_invoice(self, row: Dict[str, Any]) -> Dict[str, Any]:
        data = self._rest(
            "POST",
            "parsed_invoices",
            params={"on_conflict": "document_id,source_invoice_id,parser_version", "select": "*"},
            json_body=row,
            prefer="resolution=merge-duplicates,return=representation",
        )
        return data[0]

    # parsed_line_items: replace by parsed_invoice_id
    def replace_line_items(self, parsed_invoice_id: str, items: List[Dict[str, Any]]) -> None:
        self._rest(
            "DELETE",
            "parsed_line_items",
            params={"parsed_invoice_id": f"eq.{parsed_invoice_id}"},
            prefer="return=minimal",
        )
        if items:
            self._rest(
                "POST",
                "parsed_line_items",
                json_body=items,
                prefer="return=minimal",
            )

    def find_existing_business_unique(
        self,
        *,
        vendor_name: str,
        invoice_number: str,
        total_amount: float
    ) -> Optional[Dict[str, Any]]:
        # Matches the unique constraint: (vendor_name, invoice_number, total_amount)
        params = {
            "select": "id,document_id,source_invoice_id,invoice_number,invoice_date,total,total_amount,created_at",
            "vendor_name": f"eq.{vendor_name}",
            "invoice_number": f"eq.{invoice_number}",
            "total_amount": f"eq.{total_amount}",
            "limit": "1",
            "order": "created_at.desc",
        }
        rows = self._rest("GET", "parsed_invoices", params=params) or []
        return rows[0] if rows else None

    # soft duplicate check in parsed_invoices (no schema changes required)
    def find_soft_duplicate(
        self,
        *,
        vendor_name: Optional[str],
        invoice_date: Optional[str],
        invoice_number: Optional[str],
        total: Optional[float],
        within_days: int = 3,
        limit: int = 3,
    ) -> List[Dict[str, Any]]:
        """
        Looks for "similar" invoices:
        - same vendor_name (exact)
        - same invoice_number OR (same date-window and same total)
        """
        vn = (vendor_name or "").strip()
        if not vn or vn in {",", "/", "-"} or len(vn) < 3:
            return []

        base_params: Dict[str, str] = {
            "select": "id,document_id,source_invoice_id,invoice_number,invoice_date,total,total_amount,created_at",
            "vendor_name": f"eq.{vn}",
            "order": "created_at.desc",
            "limit": str(limit),
        }

        # Case A: exact invoice_number match
        invno = (invoice_number or "").strip()
        if invno:
            params_a = dict(base_params)
            params_a["invoice_number"] = f"eq.{invno}"
            try:
                rows = self._rest("GET", "parsed_invoices", params=params_a) or []
                return rows[:limit]
            except Exception:
                pass

        # Case B: date-window + total match
        if invoice_date and total is not None:
            try:
                d0 = datetime.fromisoformat(invoice_date)
            except Exception:
                d0 = None
            if d0:
                dmin = (d0 - timedelta(days=within_days)).date().isoformat()
                dmax = (d0 + timedelta(days=within_days)).date().isoformat()

                params_b = dict(base_params)
                # Supabase PostgREST: range via invoice_date=gte... and 'and' for upper bound + total
                params_b["invoice_date"] = f"gte.{dmin}"
                params_b["and"] = f"(invoice_date.lte.{dmax},total.eq.{total})"

                try:
                    rows = self._rest("GET", "parsed_invoices", params=params_b) or []
                    return rows[:limit]
                except Exception:
                    return []

        return []


# ---------------------------
# Mapping extracted JSON -> DB rows
# ---------------------------

def compute_source_invoice_id(raw: Dict[str, Any], fallback: str) -> str:
    inv = raw.get("invoice_number")
    if inv and str(inv).strip():
        return str(inv).strip()
    return fallback

def _clean_vendor_name(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    vn = str(v).strip()
    if not vn or vn in {",", "/", "-"}:
        return None
    if len(vn) < 3:
        return None
    return vn

def classify_doc_type(raw: dict) -> str:
    text = str(raw).lower()

    if any(k in text for k in [
        "fuel release",
        "release number",
        "fuel contract",
        "pricing schedule",
        "supplier agreement"
    ]):
        return "fuel_release"

    # Maintenance / parts / MRO invoices
    if any(k in text for k in [
        "maintenance",
        "repair",
        "overhaul",
        "inspection",
        "avionics",
        "airframe",
        "engine shop",
        "work order",
        "work performed",
        "squawk",
        "discrepancy",
        "service bulletin",
        "parts order",
        "component",
        "aog",
        " mro",
        " mx ",
        "annual inspection",
        "progressive inspection",
        "100 hour",
        "100-hour",
        "phase inspection",
        "hot section",
        "turbine",
        "propeller",
        "landing gear",
        "hydraulic",
        "sheet metal",
        "interior refurb",
        "paint",
        "warranty claim",
        "core return",
        "exchange unit",
        "rotable",
    ]):
        return "maintenance"

    # Lease / rent / management / utility invoices
    if any(k in text for k in [
        "lease",
        "rent",
        "monthly rent",
        "hangar rent",
        "office rent",
        "utilities",
        "electric",
        "water bill",
        "management fee",
        "charter management",
        "aircraft management",
        "property",
        "insurance premium",
        "hull insurance",
        "liability insurance",
    ]):
        return "lease_utility"

    # Subscriptions / recurring services
    if any(k in text for k in [
        "starlink",
        "subscription",
        "monthly service",
        "recurring charge",
        "satcom",
        "internet service",
        "connectivity",
        "wifi service",
        "streaming",
        "software license",
        "annual license",
        "renewal",
    ]):
        return "subscriptions"

    # Pilot operations / training / OEM support
    if any(k in text for k in [
        "prod support",
        "product support",
        "pilot supplies",
        "training",
        "simulator",
        "recurrent training",
        "type rating",
        "initial training",
        "charts",
        "jeppesen",
        "foreflight",
        "navigation data",
        "crew supplies",
        "flight planning",
        "dispatch",
        "oem support",
        "smart parts",
        "bombardier",
        "gulfstream",
        "dassault",
        "embraer",
        "textron support",
    ]):
        return "pilot_operations"

    # Parts / supplies invoices (before fbo_fee to avoid "handling" false positive)
    if any(k in text for k in [
        "parts order",
        "part number",
        "p/n ",
        "part no",
        "assembly",
        "civil aircraft",
        "aircraft parts",
        "aircraft supplies",
        "aviall",
        "heico",
        "honeywell",
        "textron aviation parts",
        "shipping and handling",
        "ship to",
        "qty shipped",
        "back order",
        "unit of measure",
        "packing slip",
        "bill of material",
    ]):
        return "parts"

    if any(k in text for k in [
        "hangar",
        "parking",
        "ground handling",
        "ramp handling",
        "ramp fee",
        "facility fee",
        "gpu",
        "lav",
        "de-ice",
        "catering",
        "landing fee",
        "into-plane",
        "overnight fee",
        "jet a",
        "jet-a",
        "jeta",
        "avgas",
        "100ll",
        "fuel surcharge",
        "fueling",
        "defueling",
        "gallons",
        "into plane",
        "fbo",
        "fixed base",
        "fuel flowage",
        "flowage fee",
        "prist",
        "fsii",
        # Known FBO vendors
        "sheltair",
        "atlantic aviation",
        "signature flight",
        "million air",
        "jet aviation",
        "xjet",
        "priester",
        "ross aviation",
        "pentastar",
        "cutter aviation",
        "clay lacy",
        "azorra",
        "world fuel",
        "avfuel",
        "wilson air",
    ]):
        return "fbo_fee"

    return "other"


def normalize_rows(
    raw: Dict[str, Any],
    *,
    document_id: str,
    parser_version: str,
    model: str,
    validation: Dict[str, Any],
    source_invoice_id: str,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:

    totals = raw.get("totals") or {}
    line_items = raw.get("line_items") or []
    vendor_name = _clean_vendor_name((raw.get("vendor") or {}).get("name"))

    invoice_date_iso = normalize_date_to_iso(raw.get("invoice_date"))

    total_amount = totals.get("total_amount")
    total = totals.get("total") if totals.get("total") is not None else total_amount

    src_id = (source_invoice_id or raw.get("invoice_number") or document_id)
    src_id = str(src_id).strip() if src_id else document_id

    doc_type = classify_doc_type(raw)

    inv_row = {
        "document_id": document_id,
        "doc_type": doc_type,
        "parser_version": parser_version,
        "vendor_name": vendor_name,
        "invoice_number": raw.get("invoice_number"),
        "invoice_date": invoice_date_iso,
        "currency": raw.get("currency") or "USD",
        "tail_number": raw.get("tail_number"),
        "airport_code": raw.get("airport_code"),
        "subtotal": totals.get("subtotal"),
        "tax": totals.get("tax") if totals.get("tax") is not None else totals.get("sales_tax"),
        "total": total,
        "total_amount": total_amount,
        "line_items": line_items,
        "raw_extracted": raw,
        "raw_json": raw,
        "validation_pass": bool(validation.get("validation_pass")),
        "review_required": bool(validation.get("validation_pass") is False),
        "recon_mode": validation.get("recon_mode"),
        "delta": validation.get("delta"),
        "extraction_model": model,
        "extraction_version": os.getenv("EXTRACTION_VERSION"),
        "source_invoice_id": src_id,
        "invoice_key": src_id,
        "dedupe_key": src_id,
        "is_latest": True,
    }

    li_rows: List[Dict[str, Any]] = []
    if isinstance(line_items, list):
        for li in line_items:
            if not isinstance(li, dict):
                continue
            li_rows.append({
                "parsed_invoice_id": None,
                "category": li.get("category"),
                "description_raw": li.get("description") or "",
                "quantity": li.get("quantity"),
                "unit": li.get("uom") if li.get("uom") is not None else li.get("unit"),
                "unit_price": li.get("unit_price"),
                "amount": li.get("total"),
            })

    return inv_row, li_rows

# ---------------------------
# Core processing
# ---------------------------

def _clear_latest_for_logical_invoice(supa: Supa, *, document_id: str, source_invoice_id: str) -> None:
    # Clear "latest" for this logical invoice before setting it true again.
    try:
        supa._rest(
            "PATCH",
            "parsed_invoices",
            params={
                "document_id": f"eq.{document_id}",
                "source_invoice_id": f"eq.{source_invoice_id}",
                "is_latest": "eq.true",
            },
            json_body={"is_latest": False},
            prefer="return=minimal",
        )
    except Exception:
        pass


def process_one_pdf(
    supa: Supa,
    pdf_path: Path,
    out_dir: Path,
    *,
    schema: str,
    model: str,
    rescue: bool,
    gcs_bucket: str,
    gcs_path: str,
    source_system: str,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    text = read_pdf_text(str(pdf_path))
    invoice_ids = detect_invoice_ids(text)
    maybe_statement, page_count = maybe_statement_gate(text, invoice_ids)

    parser_version = os.getenv("PARSER_VERSION") or os.getenv("EXTRACTION_VERSION") or "0.1.0"

    doc_row = {
        "source_system": source_system,
        "gcs_bucket": gcs_bucket,
        "gcs_path": gcs_path,
        "document_hash": sha256_file(pdf_path),
        "status": "processing",
        "processing_started_at": utc_now_iso(),
        "mode": "unknown",
        "page_count": page_count,
        "detected_invoice_ids": invoice_ids,
    }
    doc_row = scrub_obj(doc_row)
    doc = supa.upsert_documents(doc_row)
    document_id = doc["id"]

    outputs: List[Dict[str, Any]] = []
    mode = "single"

    split_dir = out_dir / f"split_{pdf_path.stem}"
    split_manifest = out_dir / f"{pdf_path.stem}.split_manifest.json"

    did_split = False
    part_pdfs: List[Path] = []

    if maybe_statement:
        split_dir.mkdir(parents=True, exist_ok=True)
        try:
            run([
                "python3", "split_statement.py",
                "--pdf", str(pdf_path),
                "--out_dir", str(split_dir),
                "--manifest", str(split_manifest),
            ])
            part_pdfs = sorted(split_dir.glob("*.pdf"))
            did_split = len(part_pdfs) >= 2
        except Exception as e:
            supa.insert_invoice_error({
                "document_id": document_id,
                "parsed_invoice_id": None,
                "stage": "split",
                "error_code": "SPLIT_FAILED",
                "message": str(e),
                "details": {"pdf": str(pdf_path)},
            })
            did_split = False

    # Avfuel activity invoice splitting (highest priority for tabular format):
    # handles tabular multi-invoice PDFs where each receipt is a row in a table
    # (not a separate section with headers). Must run BEFORE generic text-based
    # splitting, which would incorrectly split on "Invoice" / "Ref Number"
    # keywords in the header, producing garbage sections.
    text_sections: List[Tuple[str, str]] = []
    if not did_split:
        avfuel_sections = split_avfuel_activity_invoice(text)
        if avfuel_sections:
            text_sections = avfuel_sections

    # Text-based splitting fallback: when PDF page-split fails but multiple
    # invoice IDs are detected, split by text boundaries instead.
    if not did_split and not text_sections and len(invoice_ids) >= 2:
        text_sections = split_text_into_sections(text)

    try:
        if did_split:
            mode = "statement"
            for part_pdf in part_pdfs:
                out_json = out_dir / f"{part_pdf.stem}.json"

                cmd = [
                    "python3", "extract_invoice.py",
                    "--pdf", str(part_pdf),
                    "--out", str(out_json),
                    "--schema", schema,
                    "--model", model,
                ]
                if rescue:
                    cmd.insert(2, "--rescue")
                run(cmd)

                raw = load_json_file(out_json)
                raw["invoice_date"] = normalize_date_to_iso(raw.get("invoice_date"))
                raw = scrub_obj(raw)
                out_json.write_text(json.dumps(raw, indent=2), encoding="utf-8")

                v = validate_json(out_json)
                v = scrub_obj(v)

                # Statement-safe stable logical invoice id
                source_invoice_id = part_pdf.stem

                inv_row, li_rows = normalize_rows(
                    raw,
                    document_id=document_id,
                    parser_version=parser_version,
                    model=model,
                    validation=v,
                    source_invoice_id=source_invoice_id,
                )

                inv_row = scrub_obj(inv_row)
                li_rows = scrub_obj(li_rows)

                # Clear latest for this logical invoice (prevents is_latest unique collisions)
                _clear_latest_for_logical_invoice(
                    supa,
                    document_id=document_id,
                    source_invoice_id=str(inv_row.get("source_invoice_id") or source_invoice_id),
                )

                parsed_invoice_id: Optional[str] = None
                soft_dupes: List[Dict[str, Any]] = []
                dup_of: Optional[str] = None

                try:
                    inv = supa.upsert_parsed_invoice(inv_row)
                    parsed_invoice_id = inv["id"]

                    for r in li_rows:
                        r["parsed_invoice_id"] = parsed_invoice_id
                    supa.replace_line_items(parsed_invoice_id, li_rows)

                except DuplicateInvoiceError:
                    # Business duplicate: fetch the existing invoice and record it; do NOT fail the statement
                    existing = None
                    try:
                        existing = supa.find_existing_business_unique(
                            vendor_name=str(inv_row.get("vendor_name") or ""),
                            invoice_number=str(inv_row.get("invoice_number") or ""),
                            total_amount=float(inv_row.get("total_amount") or inv_row.get("total") or 0),
                        )
                    except Exception:
                        existing = None

                    if existing:
                        parsed_invoice_id = existing.get("id")
                        dup_of = parsed_invoice_id

                # Soft duplicate detection (best-effort) – skip if vendor is junk
                try:
                    soft_dupes = supa.find_soft_duplicate(
                        vendor_name=inv_row.get("vendor_name"),
                        invoice_date=inv_row.get("invoice_date"),
                        invoice_number=inv_row.get("invoice_number"),
                        total=float(inv_row.get("total") or 0) if inv_row.get("total") is not None else None,
                    )
                    if parsed_invoice_id:
                        soft_dupes = [d for d in soft_dupes if d.get("id") != parsed_invoice_id]
                except Exception:
                    soft_dupes = []

                outputs.append({
                    "invoice_id": part_pdf.stem,
                    "json": str(out_json),
                    "pdf": str(part_pdf),
                    "validation": v,
                    "parsed_invoice_id": parsed_invoice_id,
                    "source_invoice_id": source_invoice_id,
                    "business_duplicate_of": dup_of,
                    "soft_duplicates": soft_dupes[:3],
                })

                if parsed_invoice_id and (not v.get("validation_pass")):
                    supa.insert_invoice_error({
                        "document_id": document_id,
                        "parsed_invoice_id": parsed_invoice_id,
                        "stage": "validate",
                        "error_code": "VALIDATION_FAILED",
                        "message": "Invoice failed validation",
                        "details": v,
                    })

        elif len(text_sections) >= 2:
            # ----------------------------------------------------------
            # Text-based statement splitting: extract each invoice section
            # independently using the pre-extracted text. This handles
            # multi-invoice-per-page PDFs (e.g. World Fuel consolidated
            # statements) that page-level splitting cannot split.
            # ----------------------------------------------------------
            mode = "statement"
            for inv_id, section_text in text_sections:
                safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", inv_id or "UNKNOWN")
                text_file = out_dir / f"section_{safe_id}.txt"
                text_file.write_text(section_text, encoding="utf-8")
                out_json = out_dir / f"{safe_id}.json"

                cmd = [
                    "python3", "extract_invoice.py",
                    "--text_file", str(text_file),
                    "--out", str(out_json),
                    "--schema", schema,
                    "--model", model,
                ]
                if rescue:
                    cmd.insert(2, "--rescue")
                run(cmd)

                raw = load_json_file(out_json)
                raw["invoice_date"] = normalize_date_to_iso(raw.get("invoice_date"))
                raw = scrub_obj(raw)
                out_json.write_text(json.dumps(raw, indent=2), encoding="utf-8")

                v = validate_json(out_json)
                v = scrub_obj(v)

                source_invoice_id = inv_id

                inv_row, li_rows = normalize_rows(
                    raw,
                    document_id=document_id,
                    parser_version=parser_version,
                    model=model,
                    validation=v,
                    source_invoice_id=source_invoice_id,
                )

                inv_row = scrub_obj(inv_row)
                li_rows = scrub_obj(li_rows)

                _clear_latest_for_logical_invoice(
                    supa,
                    document_id=document_id,
                    source_invoice_id=str(inv_row.get("source_invoice_id") or source_invoice_id),
                )

                parsed_invoice_id: Optional[str] = None
                soft_dupes: List[Dict[str, Any]] = []
                dup_of: Optional[str] = None

                try:
                    inv = supa.upsert_parsed_invoice(inv_row)
                    parsed_invoice_id = inv["id"]

                    for r in li_rows:
                        r["parsed_invoice_id"] = parsed_invoice_id
                    supa.replace_line_items(parsed_invoice_id, li_rows)

                except DuplicateInvoiceError:
                    existing = None
                    try:
                        existing = supa.find_existing_business_unique(
                            vendor_name=str(inv_row.get("vendor_name") or ""),
                            invoice_number=str(inv_row.get("invoice_number") or ""),
                            total_amount=float(inv_row.get("total_amount") or inv_row.get("total") or 0),
                        )
                    except Exception:
                        existing = None

                    if existing:
                        parsed_invoice_id = existing.get("id")
                        dup_of = parsed_invoice_id

                try:
                    soft_dupes = supa.find_soft_duplicate(
                        vendor_name=inv_row.get("vendor_name"),
                        invoice_date=inv_row.get("invoice_date"),
                        invoice_number=inv_row.get("invoice_number"),
                        total=float(inv_row.get("total") or 0) if inv_row.get("total") is not None else None,
                    )
                    if parsed_invoice_id:
                        soft_dupes = [d for d in soft_dupes if d.get("id") != parsed_invoice_id]
                except Exception:
                    soft_dupes = []

                outputs.append({
                    "invoice_id": inv_id,
                    "json": str(out_json),
                    "source_text": str(text_file),
                    "validation": v,
                    "parsed_invoice_id": parsed_invoice_id,
                    "source_invoice_id": source_invoice_id,
                    "business_duplicate_of": dup_of,
                    "soft_duplicates": soft_dupes[:3],
                })

                if parsed_invoice_id and (not v.get("validation_pass")):
                    supa.insert_invoice_error({
                        "document_id": document_id,
                        "parsed_invoice_id": parsed_invoice_id,
                        "stage": "validate",
                        "error_code": "VALIDATION_FAILED",
                        "message": "Invoice failed validation",
                        "details": v,
                    })

        else:
            out_json = out_dir / f"{pdf_path.stem}.json"
            cmd = [
                "python3", "extract_invoice.py",
                "--pdf", str(pdf_path),
                "--out", str(out_json),
                "--schema", schema,
                "--model", model,
            ]
            if rescue:
                cmd.insert(2, "--rescue")
            run(cmd)

            raw = load_json_file(out_json)
            raw["invoice_date"] = normalize_date_to_iso(raw.get("invoice_date"))
            raw = scrub_obj(raw)
            out_json.write_text(json.dumps(raw, indent=2), encoding="utf-8")

            v = validate_json(out_json)
            v = scrub_obj(v)

            source_invoice_id = compute_source_invoice_id(raw, fallback=pdf_path.stem)

            inv_row, li_rows = normalize_rows(
                raw,
                document_id=document_id,
                parser_version=parser_version,
                model=model,
                validation=v,
                source_invoice_id=source_invoice_id,
            )

            inv_row = scrub_obj(inv_row)
            li_rows = scrub_obj(li_rows)

            _clear_latest_for_logical_invoice(
                supa,
                document_id=document_id,
                source_invoice_id=str(inv_row.get("source_invoice_id") or source_invoice_id),
            )

            parsed_invoice_id: Optional[str] = None
            soft_dupes: List[Dict[str, Any]] = []
            dup_of: Optional[str] = None

            try:
                inv = supa.upsert_parsed_invoice(inv_row)
                parsed_invoice_id = inv["id"]

                for r in li_rows:
                    r["parsed_invoice_id"] = parsed_invoice_id
                supa.replace_line_items(parsed_invoice_id, li_rows)

            except DuplicateInvoiceError:
                # Business duplicate: treat as success and link to existing record (best-effort)
                existing = None
                try:
                    existing = supa.find_existing_business_unique(
                        vendor_name=str(inv_row.get("vendor_name") or ""),
                        invoice_number=str(inv_row.get("invoice_number") or ""),
                        total_amount=float(inv_row.get("total_amount") or inv_row.get("total") or 0),
                    )
                except Exception:
                    existing = None

                if existing:
                    parsed_invoice_id = existing.get("id")
                    dup_of = parsed_invoice_id

            # Soft duplicate detection (best-effort)
            try:
                soft_dupes = supa.find_soft_duplicate(
                    vendor_name=inv_row.get("vendor_name"),
                    invoice_date=inv_row.get("invoice_date"),
                    invoice_number=inv_row.get("invoice_number"),
                    total=float(inv_row.get("total") or 0) if inv_row.get("total") is not None else None,
                )
                if parsed_invoice_id:
                    soft_dupes = [d for d in soft_dupes if d.get("id") != parsed_invoice_id]
            except Exception:
                soft_dupes = []

            outputs.append({
                "invoice_id": pdf_path.stem,
                "json": str(out_json),
                "pdf": str(pdf_path),
                "validation": v,
                "parsed_invoice_id": parsed_invoice_id,
                "source_invoice_id": source_invoice_id,
                "business_duplicate_of": dup_of,
                "soft_duplicates": soft_dupes[:3],
            })

            if parsed_invoice_id and (not v.get("validation_pass")):
                supa.insert_invoice_error({
                    "document_id": document_id,
                    "parsed_invoice_id": parsed_invoice_id,
                    "stage": "validate",
                    "error_code": "VALIDATION_FAILED",
                    "message": "Invoice failed validation",
                    "details": v,
                })

        manifest_payload = {
            "input_pdf": str(pdf_path),
            "mode": mode,
            "page_count": page_count,
            "detected_invoice_ids": invoice_ids[:50],
            "outputs": outputs,
        }
        write_manifest(out_dir, scrub_obj(manifest_payload))

        needs_review = any(o.get("validation", {}).get("validation_pass") is False for o in outputs)

        # If any output is a business-duplicate, store the first one as a hint (optional column)
        dup_hint = None
        for o in outputs:
            if o.get("business_duplicate_of"):
                dup_hint = o.get("business_duplicate_of")
                break

        supa.update_document(document_id, {
            "status": "done",
            "mode": mode,
            "parsed_at": utc_now_iso(),
            "manifest": scrub_obj(manifest_payload),
            "needs_review": needs_review,
            "parse_error": None,
            # safe even if column doesn't exist? (If it doesn't, Supabase will 400.)
            # If you haven't added the column, remove the next line.
            "duplicate_of_parsed_invoice_id": dup_hint,
        })

    except Exception as e:
        supa.insert_invoice_error({
            "document_id": document_id,
            "parsed_invoice_id": None,
            "stage": "process",
            "error_code": "PROCESS_FAILED",
            "message": str(e),
            "details": {"pdf": str(pdf_path)},
        })
        supa.update_document(document_id, {
            "status": "error",
            "parsed_at": utc_now_iso(),
            "parse_error": str(e),
        })
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="Path to PDF")
    ap.add_argument("--out_dir", required=True, help="Output folder for JSON + manifests")
    ap.add_argument("--schema", default="schemas/invoice.schema.json")
    ap.add_argument("--model", default="gpt-4o-mini")
    ap.add_argument("--no_rescue", action="store_true", help="Disable rescue pass")
    ap.add_argument("--gcs_bucket", default="unknown")
    ap.add_argument("--gcs_path", default="")
    ap.add_argument("--source_system", default="gcs")
    args = ap.parse_args()

    supa_url = os.getenv("SUPABASE_URL")
    supa_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supa_url or not supa_key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")

    supa = Supa(supa_url, supa_key)

    pdf_path = Path(args.pdf)
    out_dir = Path(args.out_dir)

    gcs_path = args.gcs_path or pdf_path.name

    process_one_pdf(
        supa,
        pdf_path,
        out_dir,
        schema=args.schema,
        model=args.model,
        rescue=not args.no_rescue,
        gcs_bucket=args.gcs_bucket,
        gcs_path=gcs_path,
        source_system=args.source_system,
    )


if __name__ == "__main__":
    main()