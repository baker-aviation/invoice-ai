#!/usr/bin/env python3
"""
extract_invoice.py

Normal mode:
  python extract_invoice.py --pdf path/to.pdf --out /tmp/invoice.json

Rescue mode:
  python extract_invoice.py --rescue --pdf path/to.pdf --out /tmp/invoice.json

Repair mode (uses previous JSON + validation errors; NO PDF needed):
  python extract_invoice.py --repair_from_json /tmp/invoice.bad.json \
    --validation_json /tmp/bad.validation.json \
    --out /tmp/invoice.repaired.json

Statement mode (auto-split multi-invoice PDFs):
  python extract_invoice.py --rescue --pdf statement.pdf --out_dir /tmp/out_jsons
  # optional:
  python extract_invoice.py --rescue --pdf statement.pdf --out_dir /tmp/out_jsons --manifest /tmp/split_manifest.json
"""

import argparse
import json
import os
import re
from collections import Counter
from dataclasses import dataclass
from decimal import Decimal
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional

from dotenv import load_dotenv
load_dotenv(".env")  # explicit path avoids python-dotenv find_dotenv() issues in some shells

from openai import OpenAI

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:
    PdfReader = None  # type: ignore
    PdfWriter = None  # type: ignore


# ============================================================
# Money "unglue" fix
# ============================================================

# Fuel-style glue: 5-decimal unit price + 2-decimal tax + 2-decimal total
_MONEY3 = re.compile(r"(\d+\.\d{5})(\d+\.\d{2})(\d+\.\d{2})")
# Generic glue: two adjacent 2-decimal amounts, e.g. 15.91205.91
_MONEY2 = re.compile(r"(\d+\.\d{2})(\d+\.\d{2})")


def unglue_money_columns(text: str) -> str:
    text = _MONEY3.sub(r"\1 \2 \3", text)
    text = _MONEY2.sub(r"\1 \2", text)
    return text


# ============================================================
# PDF Extraction
# ============================================================

def read_pdf_text(path: str) -> str:
    """
    Prefer pdfplumber for table-heavy invoices.
    Falls back to pypdf.
    Applies money-column unglue cleanup.
    """
    # Try pdfplumber first (best for columns/tables)
    try:
        import pdfplumber  # type: ignore

        parts = []
        with pdfplumber.open(path) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text(layout=True) or ""
                parts.append(f"\n\n--- PAGE {i+1} ---\n{text}")

        text = "\n".join(parts).strip()
        return unglue_money_columns(text)

    except Exception:
        # Fallback to pypdf
        if PdfReader is None:
            raise RuntimeError("No PDF extraction backend available (install pdfplumber or pypdf).")

        reader = PdfReader(path)
        parts = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            parts.append(f"\n\n--- PAGE {i+1} ---\n{text}")

        text = "\n".join(parts).strip()
        return unglue_money_columns(text)


def pdf_to_images(path: str, dpi: int = 200) -> List[str]:
    """Convert PDF pages to base64-encoded PNGs for Vision API."""
    from pdf2image import convert_from_path
    import base64, io
    images = convert_from_path(path, dpi=dpi)
    result = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        result.append(base64.b64encode(buf.getvalue()).decode())
    return result


def read_pdf_pages_text(path: str) -> List[str]:
    """
    Returns a list of per-page extracted text (unglued), without the --- PAGE --- headers.
    Uses pdfplumber if available; otherwise pypdf.
    """
    try:
        import pdfplumber  # type: ignore
        out: List[str] = []
        with pdfplumber.open(path) as pdf:
            for page in pdf.pages:
                out.append(unglue_money_columns(page.extract_text(layout=True) or ""))
        return out
    except Exception:
        if PdfReader is None:
            raise RuntimeError("No PDF extraction backend available (install pdfplumber or pypdf).")
        r = PdfReader(path)
        return [unglue_money_columns((pg.extract_text() or "")) for pg in r.pages]


# ============================================================
# JSON Helpers
# ============================================================

def load_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, data: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ============================================================
# OpenAI Structured Output Compatibility Layer
# ============================================================

def _schema_format_new(schema_bundle: Dict[str, Any]) -> Dict[str, Any]:
    """
    Newer SDK shape: response_format={"type":"json_schema","json_schema":{...}}
    Note: your installed SDK may not support response_format, so we fall back below.
    """
    return {
        "type": "json_schema",
        "json_schema": {
            "name": schema_bundle["name"],
            "schema": schema_bundle["schema"],
            "strict": True,  # enforce schema types (prevents raw_name list, etc.)
        },
    }


def _schema_format_legacy(schema_bundle: Dict[str, Any]) -> Dict[str, Any]:
    """
    Legacy SDK shape used by many environments: text={"format":{...}}
    """
    return {
        "type": "json_schema",
        "name": schema_bundle["name"],
        "schema": schema_bundle["schema"],
        "strict": True,
    }


def _extract_text_from_response(resp: Any) -> str:
    """
    Robustly get a text JSON blob from various SDK response shapes.
    """
    ot = getattr(resp, "output_text", None)
    if isinstance(ot, str) and ot.strip():
        return ot

    try:
        # Some SDKs nest output differently
        return resp.output[0].content[0].text
    except Exception:
        return str(resp)


def llm_extract_json(client: OpenAI, model: str, messages: List[dict], schema_bundle: Dict[str, Any]) -> Dict[str, Any]:
    """
    Try new SDK signature first; if not supported, fall back to legacy.
    Returns parsed dict.
    """
    # New style
    try:
        resp = client.responses.create(
            model=model,
            input=messages,
            response_format=_schema_format_new(schema_bundle),
        )
        parsed = getattr(resp, "output_parsed", None)
        if isinstance(parsed, dict):
            return parsed
        return json.loads(_extract_text_from_response(resp))
    except TypeError:
        # Legacy style
        resp = client.responses.create(
            model=model,
            input=messages,
            text={"format": _schema_format_legacy(schema_bundle)},
        )
        return json.loads(_extract_text_from_response(resp))


def llm_extract_json_vision(
    client: OpenAI, model: str, messages: List[dict], schema_bundle: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Vision-capable extraction using chat completions API with structured output.
    Used for scanned/image-only PDFs where text extraction yields nothing.
    """
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": schema_bundle["name"],
                "schema": schema_bundle["schema"],
                "strict": True,
            },
        },
        max_tokens=4096,
    )
    return json.loads(resp.choices[0].message.content)


# ============================================================
# Deterministic invoice number extraction (post-LLM override)
# ============================================================

# Prefer INV... when present; fall back to Invoice No/Number; then Ref Number.
_INV_NO_STRONG = re.compile(r"\bINV\d{6,}\b", re.IGNORECASE)
_INV_NO_LABEL = re.compile(r"\bInvoice\s+(?:No\.?|#|Number)\s*[:#]?\s*([A-Z0-9-]{6,})\b", re.IGNORECASE)
_REF_NO_LABEL = re.compile(r"\bRef Number\s+([A-Z0-9-]{6,})\b", re.IGNORECASE)
_ORDER_NO_LABEL = re.compile(r"\bOrder\s+[Nn]o\.?\s*:?\s*([A-Z0-9-]{4,})\b", re.IGNORECASE)

_GENERIC_INV_LABELS = {"INVOICE", "INVOICE #", "INVOICE NUMBER", "INVOICE NO", "INVOICE NO."}


def best_invoice_number_from_text(pdf_text: str) -> Optional[str]:
    t = pdf_text or ""

    m = _INV_NO_STRONG.search(t)
    if m:
        return m.group(0).upper()

    m = _INV_NO_LABEL.search(t)
    if m:
        return (m.group(1) or "").strip().upper()

    m = _REF_NO_LABEL.search(t)
    if m:
        return (m.group(1) or "").strip().upper()

    m = _ORDER_NO_LABEL.search(t)
    if m:
        return (m.group(1) or "").strip().upper()

    return None


def apply_invoice_number_override(data: Dict[str, Any], pdf_text: str) -> Dict[str, Any]:
    cand = best_invoice_number_from_text(pdf_text)
    if not cand:
        return data

    cur = data.get("invoice_number")
    cur_s = (str(cur).strip().upper() if cur else "")

    if cur_s in _GENERIC_INV_LABELS:
        cur_s = ""

    # If we found INV... and model gave Ref/other, prefer INV...
    if cand.startswith("INV") and (not cur_s or not cur_s.startswith("INV")):
        data["invoice_number"] = cand
        return data

    # If model left blank, fill from deterministic parse
    if not cur_s:
        data["invoice_number"] = cand
        return data

    return data


# ============================================================
# Numeric helpers
# ============================================================

def D(x: Any) -> Decimal:
    if x is None:
        return Decimal("0")
    return Decimal(str(x))


def sum_line_totals(data: Dict[str, Any]) -> Decimal:
    s = Decimal("0")
    for li in (data.get("line_items") or []):
        if isinstance(li, dict):
            s += D(li.get("total"))
    return s


# ============================================================
# Multi-section TOTAL detection (World Fuel / multi-stop docs)
# ============================================================

_TOTAL_RE = re.compile(
    r"\bTOTAL\b\s+([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2})\b",
    re.IGNORECASE,
)


def extract_total_lines(text: str) -> List[Decimal]:
    vals: List[Decimal] = []
    for m in _TOTAL_RE.finditer(text):
        amt = m.group(1).replace(",", "")
        try:
            vals.append(Decimal(amt))
        except Exception:
            continue
    return vals


def is_multi_section_doc(text: str) -> bool:
    totals = extract_total_lines(text)
    return len(totals) >= 2


def split_grand_and_section_totals(text: str) -> Tuple[Optional[Decimal], List[Decimal]]:
    totals = extract_total_lines(text)
    if not totals:
        return None, []

    c = Counter(totals)
    repeated = [amt for amt, n in c.items() if n >= 2]
    if repeated:
        grand = max(repeated)
    else:
        grand = max(c.keys())

    sections_set = {amt for amt in c.keys() if amt != grand}

    seen = set()
    ordered_sections: List[Decimal] = []
    for amt in totals:
        if amt == grand:
            continue
        if amt in sections_set and amt not in seen:
            ordered_sections.append(amt)
            seen.add(amt)

    return grand, ordered_sections


def override_with_section_totals_if_valid(data: Dict[str, Any], pdf_text: str) -> Dict[str, Any]:
    grand, section_totals = split_grand_and_section_totals(pdf_text)
    if grand is None or not section_totals:
        return data

    section_sum = sum(section_totals, Decimal("0"))
    if abs(section_sum - grand) > Decimal("0.01"):
        return data

    data["line_items"] = [
        {
            "description": f"Section Total {i+1}",
            "quantity": None,
            "unit_price": None,
            "tax": None,
            "total": float(amt),
        }
        for i, amt in enumerate(section_totals)
    ]

    totals = data.get("totals") or {}
    totals["total_amount"] = float(grand)
    totals["subtotal"] = None
    data["totals"] = totals
    return data


# ============================================================
# Rescue decision
# ============================================================

def should_rescue(extracted: Dict[str, Any], pdf_text: str) -> Tuple[bool, str]:
    totals = extracted.get("totals") or {}
    total_amount = totals.get("total_amount")
    items = extracted.get("line_items") or []
    n_items = len(items) if isinstance(items, list) else 0

    if total_amount is None:
        return (True, "missing_total_amount")

    line_sum = sum_line_totals(extracted)
    inv_total = D(total_amount)
    delta = abs(line_sum - inv_total)

    if is_multi_section_doc(pdf_text) and delta > Decimal("0.01"):
        return (True, "multi_section_total_mismatch")

    if inv_total >= Decimal("500") and n_items <= 3:
        return (True, "too_few_items_for_large_total")

    if delta >= Decimal("50"):
        return (True, "large_delta")

    if delta in {Decimal("100"), Decimal("200"), Decimal("300"), Decimal("400"), Decimal("500")}:
        return (True, "exact_increment_delta")

    return (False, "ok")


# ============================================================
# Post-processing: fix section subtotal captured as total_amount
# ============================================================

def fix_section_subtotal_totals(data: Dict[str, Any]) -> Dict[str, Any]:
    totals = data.get("totals") or {}
    subtotal = totals.get("subtotal")
    total_amount = totals.get("total_amount")
    if total_amount is None:
        return data

    s = sum_line_totals(data)
    t = D(total_amount)
    sub = D(subtotal) if subtotal is not None else None

    if sub is not None and abs(t - sub) <= Decimal("0.01") and s > t + Decimal("50"):
        totals["total_amount"] = float(s)
        totals["subtotal"] = None
        data["totals"] = totals

    return data

_AMOUNT_ON_CONTRACT_RE = re.compile(r"Amount\s+On\s+Contract:\s*<\$(\d+\.\d{2})>", re.IGNORECASE)

_AMOUNT_ON_CONTRACT_RE = re.compile(
    r"Amount\s+On\s+Contract:\s*<\$(\d+\.\d{2})>",
    re.IGNORECASE,
)

def apply_amount_on_contract_total(
    data: Dict[str, Any],
    pdf_text: str
) -> Dict[str, Any]:
    """
    If invoice contains 'Amount On Contract: <$X>', set totals.total_amount
    and add ON_CONTRACT_PRICING warning.
    """

    m = _AMOUNT_ON_CONTRACT_RE.search(pdf_text or "")
    if not m:
        return data

    amt = float(m.group(1))

    totals = data.get("totals") or {}
    totals["total_amount"] = amt
    if totals.get("subtotal") is None:
        totals["subtotal"] = amt
    data["totals"] = totals

    # Add warning
    warnings = data.get("warnings") or []
    if "ON_CONTRACT_PRICING" not in warnings:
        warnings.append("ON_CONTRACT_PRICING")
    data["warnings"] = warnings

    return data

    amt = float(m.group(1))
    totals = data.get("totals") or {}
    totals["total_amount"] = amt
    # If subtotal is "On Contract" style, keep it aligned
    totals["subtotal"] = amt if totals.get("subtotal") is None else totals.get("subtotal")
    data["totals"] = totals

    return data

def null_prices_for_on_contract_rows(data: Dict[str, Any], pdf_text: str) -> Dict[str, Any]:
    """
    If the document shows 'On Contract' pricing, don't hallucinate unit_price/total.
    Keep totals at the invoice level from Amount On Contract / similar fields.
    """
    if "On Contract" not in (pdf_text or ""):
        return data

    items = data.get("line_items") or []
    if not isinstance(items, list):
        return data

    for li in items:
        if not isinstance(li, dict):
            continue
        # If model set a huge unit_price that matches invoice totals, wipe it
        try:
            up = float(li.get("unit_price")) if li.get("unit_price") is not None else None
        except Exception:
            up = None
        if up is not None and up > 20:  # not a realistic per-gallon price
            li["unit_price"] = None

    data["line_items"] = items
    return data
def add_detected_keywords_warnings(
    data: Dict[str, Any],
    pdf_text: str
) -> Dict[str, Any]:
    """
    Deterministically detect important aviation keywords
    directly from raw PDF text (no LLM needed).
    """

    text = (pdf_text or "").lower()
    keywords = [
        "fsii",
        "prist",
        "deice",
        "de-ice",
        "hangar",
        "handling",
        "ramp",
        "lav",
        "gpu",
    ]

    warnings = data.get("warnings") or []

    for kw in keywords:
        if kw in text:
            tag = f"KW:{kw.upper()}"
            if tag not in warnings:
                warnings.append(tag)

    data["warnings"] = warnings
    return data

# ============================================================
# Date normalization (for Supabase date columns)
# ============================================================

def normalize_to_iso_date(s: Any) -> Optional[str]:
    """
    Converts common invoice date formats to YYYY-MM-DD (Postgres date).
    Returns None if empty. If unknown format, returns original string as a last resort.
    """
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None

    # Common invoice formats we see
    for fmt in ("%m/%d/%Y %H:%M", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue

    # ISO-ish timestamps (e.g. 2026-02-17T09:34:00Z / 2026-02-17T09:34:00)
    try:
        s2 = s.replace("Z", "")
        return datetime.fromisoformat(s2).date().isoformat()
    except Exception:
        # Last resort: try to salvage leading date
        m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
        if m:
            return m.group(1)
        return s  # will likely fail DB insert; better than silently changing


def normalize_extraction(data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Enforce a few invariants after any LLM pass.
    """
    # line_items must always be an array
    if not isinstance(data.get("line_items"), list):
        data["line_items"] = []

    # invoice_number should never be generic label
    inv = (str(data.get("invoice_number") or "").strip().upper())
    if inv in _GENERIC_INV_LABELS:
        data["invoice_number"] = None

    # normalize dates to ISO date-only (for Supabase date columns)
    data["invoice_date"] = normalize_to_iso_date(data.get("invoice_date"))
    data["due_date"] = normalize_to_iso_date(data.get("due_date"))

    return data


# ============================================================
# Airport code inference (deterministic post-processing)
# ============================================================

# Pattern: "Vendor Name - EGE" or "Vendor Name – KVNY"
_VENDOR_AIRPORT_RE = re.compile(r"(?:-|–|—)\s*([A-Z0-9]{3,4})\s*$")

# Known FBO / vendor name fragments → airport codes
_KNOWN_VENDOR_AIRPORTS: Dict[str, str] = {
    "fontainebleau aviation": "KOPF",
    "banyan air service": "KFXE",
    "sheltair fll": "KFLL",
    "sheltair fxe": "KFXE",
    "million air yip": "KYIP",
    "wilson air center": "KMEM",
}

# Common airport codes to validate against (US GA airports)
_VALID_AIRPORT_CODES = {
    "EGE", "VNY", "KVNY", "KOPF", "KBCT", "BCT", "TEB", "KTEB",
    "SDL", "KSDL", "FXE", "KFXE", "OPF", "KOPF", "FLL", "KFLL",
    "MIA", "KMIA", "LAS", "KLAS", "LAX", "KLAX", "SFO", "KSFO",
    "DEN", "KDEN", "DAL", "KDAL", "ADS", "KADS", "FTW", "KFTW",
    "AFW", "KAFW", "HOU", "KHOU", "IAH", "KIAH", "AUS", "KAUS",
    "SAT", "KSAT", "ASE", "KASE", "PBI", "KPBI", "SUA", "KSUA",
    "TMB", "KTMB", "BED", "KBED", "HPN", "KHPN", "MMU", "KMMU",
    "SNA", "KSNA", "CRQ", "KCRQ", "MKC", "KMKC", "OJC", "KOJC",
    "PDK", "KPDK", "FTY", "KFTY", "APA", "KAPA", "BJC", "KBJC",
    "DVT", "KDVT", "IWA", "KIWA", "CHD", "KCHD", "FFZ", "KFFZ",
    "LNK", "KLNK", "OMA", "KOMA", "MSP", "KMSP", "ORD", "KORD",
    "MDW", "KMDW", "PWK", "KPWK", "DPA", "KDPA", "JFK", "KJFK",
    "LGA", "KLGA", "ISP", "KISP", "HWD", "KHWD", "SQL", "KSQL",
    "RHV", "KRHV", "SMO", "KSMO", "BUR", "KBUR", "ONT", "KONT",
    "SBD", "KSBD", "RIV", "KRIV", "PSP", "KPSP", "SEA", "KSEA",
    "BFI", "KBFI", "PAE", "KPAE", "RNO", "KRNO", "LBB", "KLBB",
    "ATL", "KATL", "BNA", "KBNA", "MEM", "KMEM", "JAN", "KJAN",
    "SJC", "KSJC", "OAK", "KOAK",
}


def infer_airport_code(data: Dict[str, Any], pdf_text: str) -> Dict[str, Any]:
    """
    If airport_code is missing, try to infer it from vendor name or PDF text.
    """
    existing = (data.get("airport_code") or "").strip()
    if existing:
        return data

    # 1. Check vendor name for "Vendor - XXX" pattern
    vendor = data.get("vendor", {})
    vendor_name = ""
    if isinstance(vendor, dict):
        vendor_name = (vendor.get("name") or "").strip()
    elif isinstance(vendor, str):
        vendor_name = vendor.strip()

    if vendor_name:
        m = _VENDOR_AIRPORT_RE.search(vendor_name.upper())
        if m:
            code = m.group(1)
            if code in _VALID_AIRPORT_CODES or len(code) in (3, 4):
                data["airport_code"] = code
                return data

    # 2. Check known vendor name → airport mapping
    vn_lower = vendor_name.lower()
    for pattern, code in _KNOWN_VENDOR_AIRPORTS.items():
        if pattern in vn_lower:
            data["airport_code"] = code
            return data

    # 3. Scan PDF text for airport codes near location keywords
    text_upper = (pdf_text or "").upper()
    for label in ["AIRPORT:", "LOCATION:", "BASE:", "FBO:", "STATION:", "ORDER NO", "ORDER NO."]:
        idx = text_upper.find(label)
        if idx >= 0:
            # Look in the 40 chars after the label
            snippet = text_upper[idx:idx + 60]
            codes = re.findall(r"\b([A-Z]{3,4})\b", snippet)
            for c in codes:
                if c in _VALID_AIRPORT_CODES:
                    data["airport_code"] = c
                    return data

    # 4. Look for "K + 3-letter code" pattern anywhere (ICAO format)
    icao_matches = re.findall(r"\b(K[A-Z]{3})\b", text_upper)
    for c in icao_matches:
        if c in _VALID_AIRPORT_CODES:
            data["airport_code"] = c
            return data

    return data


# ============================================================
# Prompt Builders
# ============================================================

def build_normal_messages(pdf_text: str) -> List[dict]:
    system = (
        "You extract structured invoice data from text.\n"
        "Return ONLY JSON matching the provided schema.\n"
        "Do not invent values.\n"
        "Use null where allowed when the document does not explicitly provide a field.\n"
        "\n"
        "CRITICAL GUARDS:\n"
        "- invoice_number must NOT be generic words like 'INVOICE'. If not clear, set null.\n"
        "- line_items MUST ALWAYS be an array; use [] if none.\n"
        "\n"
        "LINE ITEM RULES:\n"
        "- Extract ALL BILLABLE line items you can find (rows with real amounts).\n"
        "- EXCLUDE headers, section titles, notes, payment terms, and summary lines.\n"
        "- INCLUDE discount, credit, and waiver lines (e.g. 'Fee Waived', 'Cust Discount', 'Credit') — extract them with NEGATIVE amounts. Parenthesized amounts like ($1,902.00) are negative.\n"
        "- EXCLUDE lines that are purely percentage tax breakdowns (e.g., 'SALES TAX 2.9%') unless explicitly charged as a dollar amount.\n"
        "- Only fill quantity/unit_price/tax if explicitly shown on the SAME row.\n"
        "- If not explicitly shown, set those fields to null.\n"
        "- 'total' must be the line's FINAL extended amount AFTER any inline discounts on that row. If a row shows both a List Price and a Total Price (or Net Price), use the TOTAL/NET as 'total', NOT the list/gross price. Example: List Price $2,390, Discount ($2,390), Total $0.00 → total should be 0.\n"
        "\n"
        "Fuel rows:\n"
        "- Use the extended TOTAL amount shown for the fuel row.\n"
        "- Do not truncate large totals.\n"
        "- For fuel lines (Jet A, Avgas, etc.), ALWAYS extract both quantity (gallons) AND unit_price (per-gallon rate) when shown ANYWHERE on the document.\n"
        "- On consolidated fuel statements (World Fuel, Avfuel), the per-gallon price may appear in a 'Price', 'Rate', 'Contract Price', or 'Unit Cost' column — extract it as unit_price.\n"
        "- If a fuel line shows gallons and a dollar total but no explicit per-gallon rate, set unit_price to null (do NOT compute it).\n"
        "- IMPORTANT: Some FBOs (e.g. Jet Aviation) show a summary/header line like 'Jet A Fuel Uplift' with a per-gallon rate, "
        "followed by indented sub-lines ('Jet A Price', 'Airport Flowage Fee', 'FSII', etc.) that break down the components. "
        "In this case, the header line is NOT a separate charge — it is just a label. "
        "Only extract the sub-lines as line items. If the header line has no Total column value on the document, SKIP it entirely.\n"
        "\n"
        "Airport code:\n"
        "- Extract the ICAO or FAA airport identifier (3-4 uppercase letters/digits, e.g. KVNY, KBCT, TEB, EGE).\n"
        "- Look for it in the header, 'Location', 'Base', 'FBO', 'Airport', 'Aéroport', or address fields.\n"
        "- FBO invoices often show the airport in the vendor address or near the vendor name.\n"
        "- If the vendor name contains a dash followed by a 3-4 letter code (e.g. 'Signature Flight Support - EGE'), that IS the airport code.\n"
        "- If not explicitly labeled, look for 3-4 character codes near city/state references.\n"
        "- Common examples: Eagle/Vail = EGE, Van Nuys = VNY/KVNY, Boca Raton = BCT/KBCT, Teterboro = TEB.\n"
        "- ALWAYS set this field when ANY airport reference is visible. Do NOT leave it null if you can determine the airport.\n"
        "\n"
        "Vendor name:\n"
        "- Use the primary vendor/company name, not a parent company or billing entity.\n"
        "- For FBO invoices (Jet Aviation, Signature, Atlantic Aviation, etc.), the VENDOR is the FBO/service provider — NOT the customer/operator (e.g. 'Baker Aviation' is the customer, not the vendor).\n"
        "- If 'Baker Aviation' appears as 'Operator' or billing recipient, the vendor is the OTHER company on the invoice.\n"
        "- For subscription services (Starlink, ForeFlight, etc.), use the service name as vendor.\n"
        "- For bilingual documents (French/English, etc.), use the English company name.\n"
        "- For government agencies (Transport Canada, FAA, etc.), use the standard English agency name.\n"
        "- If the document is NOT an invoice (e.g. a notice, letter, violation report), still extract whatever vendor/sender name is present and set total_amount to null.\n"
        "- NEVER use placeholder strings like ':vendor_name_placeholder:'. Use null if you cannot determine the vendor.\n"
        "\n"
        "FBO invoice fields:\n"
        "- 'Order no' or 'Order Number' = invoice_number.\n"
        "- 'Registration No' or 'Registration Number' = tail_number (aircraft registration).\n"
        "- 'Arrival' / 'Departure' dates — use 'Arrival' as invoice_date if no explicit 'Invoice Date' is shown.\n"
        "- Airport codes often appear in the order number (e.g. 'KBED-86387' means airport = BED).\n"
        "\n"
        "Multi-stop documents:\n"
        "- Some invoices contain multiple date/location sections.\n"
        "- Extract billable rows across ALL sections, not just the first.\n"
        "- Do not stop at the first 'TOTAL' line.\n"
        "\n"
        "Avfuel activity invoice receipts:\n"
        "- If the text contains 'ACTIVITY INVOICE' and a 'Receipt Number', this is a SINGLE receipt extracted from an Avfuel activity statement.\n"
        "- The vendor is ALWAYS 'Avfuel Corporation' (NOT the customer/account holder like 'Baker Aviation').\n"
        "- Use the INVOICE NO. from the receipt row as invoice_number (e.g. 24161943), NOT the Receipt Number.\n"
        "- The receipt row has: RECEIPT NO., LOCATION (with ICAO airport code in parentheses like '(KYIP)'), TAIL NO., INVOICE NO., TYPE.\n"
        "- Extract airport_code from the LOCATION field — the ICAO code in parentheses (e.g. 'AVFLIGHT WILLOW RUN (KYIP)' means airport_code = YIP, stripping the K prefix).\n"
        "- Extract tail_number from the TAIL NO. field.\n"
        "- Extract the fuel line item with proper quantity (gallons), unit_price (per gallon), and total (amount).\n"
        "- The TOTAL line at the end of each receipt section is the receipt total — use it as total_amount.\n"
        "\n"
        "World Fuel / FUEL TICKET invoices:\n"
        "- If the text contains 'FUEL TICKET' followed by a number, use that fuel ticket number as invoice_number (not the consolidated invoice number).\n"
        "- Each fuel ticket has its own tail_number and airport_code — extract them per-ticket.\n"
        "- Extract the fuel line item with quantity (gallons), unit_price (per gallon), and total for that specific ticket.\n"
    )
    user = f"Extract the invoice fields from this document text:\n\nDOCUMENT TEXT:\n{pdf_text}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_vision_messages(image_b64_list: List[str]) -> List[dict]:
    """Build messages for vision-based extraction of scanned PDFs."""
    system = build_normal_messages("")  # grab the system prompt
    system_text = system[0]["content"]

    content: List[dict] = [{"type": "text", "text": "Extract the invoice fields from this scanned document:"}]
    for b64 in image_b64_list:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/png;base64,{b64}", "detail": "high"},
        })

    return [
        {"role": "system", "content": system_text},
        {"role": "user", "content": content},
    ]


def build_rescue_messages(pdf_text: str, first_pass: Dict[str, Any], reason: str) -> List[dict]:
    totals_in_doc = extract_total_lines(pdf_text)
    final_total_hint = str(totals_in_doc[-1]) if totals_in_doc else None
    grand, _sections = split_grand_and_section_totals(pdf_text)
    grand_hint = str(grand) if grand is not None else None

    system = (
        "You are correcting an invoice extraction that failed reconciliation.\n"
        "Return ONLY JSON matching the schema.\n"
        "Do not invent values.\n"
        "\n"
        "CRITICAL GUARDS:\n"
        "- invoice_number must NOT be 'INVOICE' or other generic labels; use null if unclear.\n"
        "- line_items MUST ALWAYS be an array; use [] if none.\n"
        "\n"
        "CRITICAL:\n"
        "- Re-extract ALL billable line items across the ENTIRE document.\n"
        "- Many fuel invoices have MULTIPLE sections, each ending with a 'TOTAL' line.\n"
        "- Do NOT stop after the first section.\n"
        "- Ensure the sum of line_items.total equals totals.total_amount.\n"
        "- If quantity/unit_price/tax are not explicitly supported, set them to null.\n"
        "\n"
        "Common miss patterns:\n"
        "- Do not miss rows that are off to the right (amount column).\n"
        "- Do not treat a section subtotal as the grand total.\n"
        "- Do not drop discount/credit/waiver lines (e.g. 'Fee Waived', 'Cust Discount'). Extract them with NEGATIVE amounts. Parenthesized amounts like ($1,902.00) are negative.\n"
        "- 'total' must be the FINAL amount for that row AFTER any inline discounts. If List Price = $2,390, Discount = ($2,390), Total = $0.00 → use 0 as total, NOT 2390.\n"
        "- If the document shows both an Invoice Number and a Ref Number, treat the Invoice Number as invoice_number.\n"
    )

    if grand_hint:
        system += f"\nLikely GRAND TOTAL (repeated TOTAL in doc): {grand_hint}\n"
    elif final_total_hint:
        system += f"\nFINAL TOTAL line in doc appears to be: {final_total_hint}\n"

    totals = first_pass.get("totals") or {}
    t = totals.get("total_amount")
    delta_hint = None
    if t is not None:
        delta_hint = str(abs(sum_line_totals(first_pass) - D(t)))

    if reason == "exact_increment_delta" and delta_hint:
        system += (
            f"\nYou are missing charges totaling exactly: {delta_hint}.\n"
            "Find the missing billable row(s) and include them.\n"
        )

    user_payload = {
        "rescue_reason": reason,
        "first_pass_extraction": first_pass,
        "instruction": "Re-extract from the document text and fix missing/incorrect line items.",
        "document_text": pdf_text,
    }

    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user_payload)}]


def build_repair_messages(prev: Dict[str, Any], validation: Dict[str, Any]) -> List[dict]:
    system = (
        "You are repairing an invoice JSON extraction.\n"
        "Output MUST match the provided JSON schema.\n"
        "Only change fields necessary to fix validation errors.\n"
        "Do not invent new line items.\n"
        "If quantity/unit_price/tax are not clearly supported, set them to null.\n"
        "Ensure totals reconcile when possible.\n"
    )
    payload = {"previous_extraction": prev, "validation_result": validation}
    user = f"Repair the JSON to pass validation:\n{json.dumps(payload)}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# ============================================================
# Statement splitting
# ============================================================

@dataclass
class SplitChunk:
    invoice_id: str
    page_start: int  # 1-based inclusive
    page_end: int    # 1-based inclusive

    @property
    def num_pages(self) -> int:
        return self.page_end - self.page_start + 1


_INVOICE_ID_PATTERNS: List[re.Pattern] = [
    re.compile(r"\bRef Number\s+([A-Z0-9\-]+)\b", re.IGNORECASE),
    re.compile(r"\bInvoice\s+([A-Z0-9\-]+)\b", re.IGNORECASE),
    re.compile(r"\bInvoice\s*No\.?:?\s*([A-Z0-9\-]+)\b", re.IGNORECASE),
    re.compile(r"\bCREDIT MEMO NUMBER:\s*([A-Z0-9\-]+)\b", re.IGNORECASE),
    re.compile(r"\bCredit Memo No\.?:?\s*([A-Z0-9\-]+)\b", re.IGNORECASE),
]

_BAD_ID = re.compile(r"^(?:PAGE|DATE|CUSTOMER|TOTAL|USD|NUMBER|NUMBERS|INVOICE|PERIOD|DETAIL|SUMMARY|REPORT|BALANCE|STATEMENT)$", re.IGNORECASE)


def extract_invoice_id_from_page(page_text: str) -> Optional[str]:
    t = page_text or ""
    for pat in _INVOICE_ID_PATTERNS:
        m = pat.search(t)
        if m:
            cand = (m.group(1) or "").strip()
            cand = cand.replace("–", "-").replace("—", "-")
            cand = re.sub(r"[^\w\-]", "", cand)
            if not cand:
                continue
            if _BAD_ID.match(cand):
                continue
            return cand
    return None


def split_statement_into_chunks(pages_text: List[str]) -> List[SplitChunk]:
    """
    Strategy:
    - For each page, try to extract an invoice id.
    - If a page has no id, inherit the prior page's id (common in multi-page invoices).
    - Create chunks whenever the id changes.
    """
    page_ids: List[Optional[str]] = [extract_invoice_id_from_page(t) for t in pages_text]

    last: Optional[str] = None
    for i in range(len(page_ids)):
        if page_ids[i] is None and last is not None:
            page_ids[i] = last
        elif page_ids[i] is not None:
            last = page_ids[i]

    if all(pid is None for pid in page_ids):
        return []

    uniq = {pid for pid in page_ids if pid is not None}
    if len(uniq) <= 1:
        return []

    chunks: List[SplitChunk] = []
    cur_id: Optional[str] = None
    start = 1

    for idx, pid in enumerate(page_ids, start=1):
        if pid is None:
            return []
        if cur_id is None:
            cur_id = pid
            start = idx
            continue
        if pid != cur_id:
            chunks.append(SplitChunk(invoice_id=cur_id, page_start=start, page_end=idx - 1))
            cur_id = pid
            start = idx

    if cur_id is not None:
        chunks.append(SplitChunk(invoice_id=cur_id, page_start=start, page_end=len(page_ids)))

    return chunks


def write_split_pdf(in_pdf: str, chunk: SplitChunk, out_pdf: str) -> None:
    if PdfReader is None or PdfWriter is None:
        raise RuntimeError("Splitting requires pypdf (pip install pypdf).")
    r = PdfReader(in_pdf)
    w = PdfWriter()
    for p in range(chunk.page_start - 1, chunk.page_end):
        w.add_page(r.pages[p])
    os.makedirs(os.path.dirname(out_pdf), exist_ok=True)
    with open(out_pdf, "wb") as f:
        w.write(f)


# ============================================================
# Core extraction pipeline (single PDF)
# ============================================================

def extract_one_pdf(
    client: OpenAI,
    schema_bundle: Dict[str, Any],
    pdf_path: str,
    model: str,
    rescue: bool,
    pdf_text: Optional[str] = None,
) -> Dict[str, Any]:
    if pdf_text is None:
        pdf_text = read_pdf_text(pdf_path)

    # Detect scanned/image-only PDF: very little extractable text
    stripped = re.sub(r"---\s*PAGE\s+\d+\s*---", "", pdf_text).strip()
    is_scan = len(stripped) < 50

    if is_scan:
        # Vision path: convert PDF to images, send to GPT-4o
        images = pdf_to_images(pdf_path)
        if not images:
            return normalize_extraction({
                "vendor": None, "invoice_number": None, "invoice_date": None,
                "due_date": None, "airport_code": None, "tail_number": None,
                "totals": {"subtotal": None, "tax": None, "total_amount": None},
                "line_items": [], "warnings": ["SCAN_EMPTY_IMAGES"],
            })
        messages = build_vision_messages(images)
        data = llm_extract_json_vision(
            client=client, model="gpt-4o", messages=messages, schema_bundle=schema_bundle,
        )
        data = normalize_extraction(data)
        # Deterministic post-processing still runs (gracefully handles empty pdf_text)
        data = apply_invoice_number_override(data, pdf_text)
        data = fix_section_subtotal_totals(data)
        data = apply_amount_on_contract_total(data, pdf_text)
        data = null_prices_for_on_contract_rows(data, pdf_text)
        data = normalize_extraction(data)
        data = add_detected_keywords_warnings(data, pdf_text)
        data = infer_airport_code(data, pdf_text)
    else:
        # Standard text-based path
        # 1) First pass extraction
        data1 = llm_extract_json(
            client=client,
            model=model,
            messages=build_normal_messages(pdf_text),
            schema_bundle=schema_bundle,
        )
        data1 = normalize_extraction(data1)
        data1 = apply_invoice_number_override(data1, pdf_text)
        data1 = fix_section_subtotal_totals(data1)

        # 1b) Deterministic post-fixes from PDF text (safe + improves "On Contract" cases)
        data1 = apply_amount_on_contract_total(data1, pdf_text)
        data1 = null_prices_for_on_contract_rows(data1, pdf_text)
        data1 = normalize_extraction(data1)

        # 2) Optional rescue pass
        if rescue:
            do_rescue, reason = should_rescue(data1, pdf_text)
            if do_rescue:
                data2 = llm_extract_json(
                    client=client,
                    model=model,
                    messages=build_rescue_messages(pdf_text, data1, reason),
                    schema_bundle=schema_bundle,
                )
                data2 = normalize_extraction(data2)
                data2 = apply_invoice_number_override(data2, pdf_text)
                data2 = fix_section_subtotal_totals(data2)

                # Apply same deterministic post-fixes to rescue output
                data2 = apply_amount_on_contract_total(data2, pdf_text)
                data2 = null_prices_for_on_contract_rows(data2, pdf_text)
                data2 = normalize_extraction(data2)

                def score(d: Dict[str, Any]) -> Decimal:
                    totals = d.get("totals") or {}
                    t = totals.get("total_amount")
                    if t is None:
                        return Decimal("999999999")
                    return abs(sum_line_totals(d) - D(t))

                data = data2 if score(data2) <= score(data1) else data1
            else:
                data = data1
        else:
            data = data1

        # 3) Multi-section override (World Fuel statements etc.)
        data = override_with_section_totals_if_valid(data, pdf_text)

        # 3b) Re-apply deterministic post-fixes after overrides (cheap + safe)
        data = apply_amount_on_contract_total(data, pdf_text)
        data = null_prices_for_on_contract_rows(data, pdf_text)

        # Final normalization (dates, arrays, invoice_number guards)
        data = normalize_extraction(data)
        data = add_detected_keywords_warnings(data, pdf_text)

        # 4) Infer airport code if LLM missed it
        data = infer_airport_code(data, pdf_text)

    # 5) Normalize ICAO K-prefix → FAA 3-letter (KBOS → BOS)
    ac = (data.get("airport_code") or "").strip().upper()
    if len(ac) == 4 and ac.startswith("K") and ac[1:].isalpha():
        data["airport_code"] = ac[1:]

    return data


# ============================================================
# Main
# ============================================================

def main() -> None:
    ap = argparse.ArgumentParser()

    ap.add_argument("--pdf", default=None, help="Path to PDF (normal mode)")
    ap.add_argument("--rescue", action="store_true", help="Enable rescue pass for bad extractions")

    ap.add_argument("--repair_from_json", default=None, help="Path to previous extracted JSON to repair")
    ap.add_argument("--validation_json", default=None, help="Path to validator output JSON")

    ap.add_argument("--out_dir", default=None, help="If set and PDF contains multiple invoices, write one JSON per invoice here")
    ap.add_argument("--manifest", default=None, help="Optional path to write split manifest JSON (statement mode)")

    ap.add_argument("--text_file", default=None, help="Pre-extracted text file (alternative to --pdf)")

    ap.add_argument("--schema", default="schemas/invoice.schema.json")
    ap.add_argument("--out", default="/tmp/invoice.json")
    ap.add_argument("--model", default="gpt-4o-mini")

    args = ap.parse_args()

    k = os.getenv("OPENAI_API_KEY", "")
    if not k or k.strip() in {"***", "REPLACE_ME"}:
        raise RuntimeError(
            "OPENAI_API_KEY is missing or is a placeholder. "
            "Set a real key via .env or environment variable."
        )

    schema_bundle = load_json(args.schema)
    client = OpenAI()

    repair_mode = args.repair_from_json is not None or args.validation_json is not None
    if repair_mode:
        if not args.repair_from_json or not args.validation_json:
            raise SystemExit("Repair mode requires BOTH --repair_from_json and --validation_json")
        prev = load_json(args.repair_from_json)
        validation = load_json(args.validation_json)

        data = llm_extract_json(
            client=client,
            model=args.model,
            messages=build_repair_messages(prev, validation),
            schema_bundle=schema_bundle,
        )
        data = normalize_extraction(data)
        data = fix_section_subtotal_totals(data)

        write_json(args.out, data)
        print(f"Wrote {args.out}")
        return

    # Text file mode: pre-extracted text (used by text-based statement splitting)
    if args.text_file:
        text_content = Path(args.text_file).read_text(encoding="utf-8")
        data = extract_one_pdf(client, schema_bundle, args.text_file, args.model, args.rescue, pdf_text=text_content)
        write_json(args.out, data)
        print(f"Wrote {args.out}")
        return

    if not args.pdf:
        raise SystemExit("Normal mode requires --pdf, --text_file, or repair mode flags")

    if args.out_dir:
        pages_text = read_pdf_pages_text(args.pdf)
        chunks = split_statement_into_chunks(pages_text)

        if not chunks:
            data = extract_one_pdf(client, schema_bundle, args.pdf, args.model, args.rescue)
            os.makedirs(args.out_dir, exist_ok=True)
            out_path = os.path.join(args.out_dir, "invoice.json")
            write_json(out_path, data)
            print(f"Wrote {out_path}")
            return

        os.makedirs(args.out_dir, exist_ok=True)
        split_dir = os.path.join(args.out_dir, "split_pdfs")
        os.makedirs(split_dir, exist_ok=True)

        manifest_rows: List[Dict[str, Any]] = []
        for ch in chunks:
            out_pdf = os.path.join(split_dir, f"{ch.invoice_id}.pdf")
            write_split_pdf(args.pdf, ch, out_pdf)

            data = extract_one_pdf(client, schema_bundle, out_pdf, args.model, args.rescue)

            out_json = os.path.join(args.out_dir, f"{ch.invoice_id}.json")
            write_json(out_json, data)

            manifest_rows.append(
                {
                    "invoice_id": ch.invoice_id,
                    "out_pdf": out_pdf,
                    "out_json": out_json,
                    "page_start": ch.page_start,
                    "page_end": ch.page_end,
                    "num_pages": ch.num_pages,
                }
            )

        if args.manifest:
            write_json(args.manifest, {"splits": manifest_rows})
            print(f"Wrote {args.manifest}")

        print(f"Wrote {len(manifest_rows)} invoice JSON files to {args.out_dir}")
        return

    data = extract_one_pdf(client, schema_bundle, args.pdf, args.model, args.rescue)
    write_json(args.out, data)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()