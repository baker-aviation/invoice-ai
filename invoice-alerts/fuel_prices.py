# fuel_prices.py — Fuel price extraction, storage, and increase detection.
#
# Extracts JET A / JET FUEL line items from parsed invoices, computes
# the effective per-gallon price (including per-gallon taxes/fees), and
# detects price increases (>=4%) at the same airport.
#
# Heuristic: a line item is "per-gallon" if its quantity matches the fuel
# line's gallon count (±1% tolerance). Flat fees (qty=1, UOM=EACH) are
# excluded from the effective price.

import json
import logging
import re
from typing import Any, Dict, List, Optional

from supa import safe_insert, safe_select_many, safe_select_one, safe_upsert

log = logging.getLogger(__name__)

FUEL_PRICES_TABLE = "fuel_prices"
PARSED_TABLE = "parsed_invoices"

# Minimum gallons to count as a real fuel purchase
MIN_GALLONS = 10.0

# Price increase threshold
PRICE_INCREASE_PCT = 0.04  # 4%

# ── Helpers ──────────────────────────────────────────────────────────────────

_FUEL_RE = re.compile(
    r"\bjet\s*a\b|\bjet\s*fuel\b|\bjet\s*a[-\u2011]1\b|\bavgas\b|\b100\s*ll\b"
    r"|\baviation\s+fuel\b|\bavtur\b|\bjet\s*a[-\u2011]?1\b"
    r"|\bfuel\s+release\b|\bfuel\s+purchase\b|\bfuel\s+uplift\b",
    re.IGNORECASE,
)

# Lines that match the fuel regex but are taxes/fees/surcharges, not the
# primary fuel purchase.  These have small per-gallon unit prices ($0.02–$0.50)
# which should NOT be treated as the base fuel price.
_FUEL_TAX_RE = re.compile(
    r"\btax\b|\bexcise\b|\bsurcharg|\bfee\b|\bflowage\b"
    r"|\binto[\s-]?plane\b|\bfacility\b|\bthroughput\b"
    r"|\bsegment\b|\bassessment\b|\bstate\b|\bfederal\b|\bcounty\b",
    re.IGNORECASE,
)

# Minimum realistic fuel unit price — jet fuel never costs less than $1/gal
MIN_FUEL_PRICE = 1.0

# Sanity range for inferred prices (total/qty fallback)
MIN_INFERRED_PRICE = 3.0   # below $3/gal is almost certainly a fee, not fuel
MAX_INFERRED_PRICE = 12.0  # above $12/gal is unrealistic for Jet A


def _is_fuel_line(desc: str) -> bool:
    return bool(_FUEL_RE.search(desc or ""))


def _is_fuel_tax_or_fee(desc: str) -> bool:
    """Return True if the line looks like a per-gallon tax/fee, not the fuel itself."""
    return bool(_FUEL_TAX_RE.search(desc or ""))


def _to_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").replace("$", "").strip())
    except (ValueError, TypeError):
        return None


def _parse_line_items(raw: Any) -> List[Dict[str, Any]]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
    return []


# ── Extraction ───────────────────────────────────────────────────────────────


def extract_fuel_price(invoice: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Extract fuel price data from a parsed invoice.

    Returns dict with base_price_per_gallon, effective_price_per_gallon,
    gallons, fuel_total, associated_line_items, etc.
    Returns None if no fuel line item found.
    """
    line_items = _parse_line_items(invoice.get("line_items"))
    if not line_items:
        return None

    # Step 1: find the primary fuel line
    # Prefer lines that are NOT taxes/fees and have a realistic unit price (>=$1/gal).
    # Fall back to any fuel line with unit_price > 0 if no good candidate found.
    # Final fallback: infer unit_price from total/qty if result is in $3-$12/gal range.
    fuel_line = None
    fallback_fuel_line = None
    inferred_fuel_line = None  # fuel line where we can compute price from total/qty
    for li in line_items:
        desc = str(li.get("description") or li.get("name") or "")
        if not _is_fuel_line(desc):
            continue
        qty = _to_float(li.get("quantity"))
        if not qty or qty < MIN_GALLONS:
            continue

        # Skip tax/fee/surcharge lines for the primary fuel line
        if _is_fuel_tax_or_fee(desc):
            continue

        unit_price = _to_float(li.get("unit_price"))

        if unit_price and unit_price > 0:
            # Has explicit unit_price
            if unit_price >= MIN_FUEL_PRICE:
                fuel_line = li
                break
            elif not fallback_fuel_line:
                fallback_fuel_line = li
        elif not inferred_fuel_line:
            # No unit_price — try to infer from total/qty
            total = _to_float(li.get("total"))
            if total and total > 0:
                computed = total / qty
                if MIN_INFERRED_PRICE <= computed <= MAX_INFERRED_PRICE:
                    # Realistic fuel price — use it
                    li = {**li, "unit_price": round(computed, 5)}
                    inferred_fuel_line = li

    if not fuel_line:
        fuel_line = fallback_fuel_line
    if not fuel_line:
        fuel_line = inferred_fuel_line

    if not fuel_line:
        return None

    fuel_qty = _to_float(fuel_line.get("quantity"))
    base_price = _to_float(fuel_line.get("unit_price"))
    if not fuel_qty or not base_price:
        return None

    # Step 2: collect all per-gallon line items (quantity matches fuel ±1%)
    associated: List[Dict[str, Any]] = []
    fuel_total = 0.0

    for li in line_items:
        li_qty = _to_float(li.get("quantity"))
        li_total = _to_float(li.get("total"))

        if li_qty and abs(li_qty - fuel_qty) / fuel_qty < 0.01:
            associated.append(li)
            if li_total:
                fuel_total += li_total

    if not associated:
        fuel_total = _to_float(fuel_line.get("total")) or (fuel_qty * base_price)
        associated = [fuel_line]

    effective_price = fuel_total / fuel_qty if fuel_qty > 0 else base_price

    return {
        "document_id": invoice.get("document_id"),
        "parsed_invoice_id": str(invoice.get("id") or ""),
        "airport_code": (invoice.get("airport_code") or "").strip().upper() or None,
        "vendor_name": invoice.get("vendor_name") or invoice.get("vendor_normalized") or None,
        "tail_number": invoice.get("tail_number"),
        "invoice_date": invoice.get("invoice_date"),
        "currency": invoice.get("currency") or "USD",
        "base_price_per_gallon": round(base_price, 5),
        "effective_price_per_gallon": round(effective_price, 5),
        "gallons": round(fuel_qty, 2),
        "fuel_total": round(fuel_total, 2),
        "associated_line_items": associated,
    }


# ── Price comparison ─────────────────────────────────────────────────────────


def check_price_increase(
    airport_code: str,
    effective_price: float,
    document_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Compare against the most recent fuel price at the same airport.
    Returns increase details if >= PRICE_INCREASE_PCT, else None.
    """
    if not airport_code:
        return None

    rows = safe_select_many(
        FUEL_PRICES_TABLE,
        "effective_price_per_gallon, invoice_date, vendor_name, document_id",
        eq={"airport_code": airport_code.upper()},
        order="invoice_date",
        desc=True,
        limit=5,
    )

    # Filter out the current document if it was already stored
    rows = [r for r in rows if str(r.get("document_id")) != str(document_id)]

    if not rows:
        return None

    prev = rows[0]
    prev_price = _to_float(prev.get("effective_price_per_gallon"))
    if not prev_price or prev_price <= 0:
        return None

    pct_change = (effective_price - prev_price) / prev_price

    if pct_change >= PRICE_INCREASE_PCT:
        return {
            "previous_price": round(prev_price, 5),
            "previous_date": prev.get("invoice_date"),
            "previous_vendor": prev.get("vendor_name"),
            "previous_document_id": prev.get("document_id"),
            "price_change_pct": round(pct_change * 100, 2),
            "price_change_amount": round(effective_price - prev_price, 5),
        }

    return None


# ── Storage ──────────────────────────────────────────────────────────────────


def store_fuel_price(
    data: Dict[str, Any],
    increase: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Upsert a fuel price record.

    Uses ON CONFLICT (document_id) DO UPDATE so re-parsed invoices refresh
    the fuel_prices row instead of being silently skipped.
    Returns the upserted row, or None on unexpected failure.
    """
    row = {
        "document_id": data["document_id"],
        "parsed_invoice_id": data.get("parsed_invoice_id"),
        "airport_code": data.get("airport_code"),
        "vendor_name": data.get("vendor_name"),
        "base_price_per_gallon": data["base_price_per_gallon"],
        "effective_price_per_gallon": data["effective_price_per_gallon"],
        "gallons": data.get("gallons"),
        "fuel_total": data.get("fuel_total"),
        "invoice_date": data.get("invoice_date"),
        "tail_number": data.get("tail_number"),
        "currency": data.get("currency", "USD"),
        "associated_line_items": json.dumps(data.get("associated_line_items", [])),
        "price_change_pct": increase["price_change_pct"] if increase else None,
        "previous_price": increase["previous_price"] if increase else None,
        "previous_document_id": increase.get("previous_document_id") if increase else None,
        "alert_sent": bool(increase),
    }

    return safe_upsert(FUEL_PRICES_TABLE, row, on_conflict="document_id")


# ── Audit / diagnostics ──────────────────────────────────────────────────────


def audit_fuel_extraction(invoice: Dict[str, Any]) -> Dict[str, Any]:
    """
    Diagnose why an invoice does or doesn't yield a fuel price.

    Returns a dict with:
      - document_id, vendor_name, doc_type
      - reason: why it was rejected (or "ok" if extraction succeeded)
      - fuel_candidates: list of lines that matched the fuel regex
      - sample_lines: first 5 line item descriptions for context
    """
    doc_id = invoice.get("document_id")
    vendor = invoice.get("vendor_name") or invoice.get("vendor_normalized")
    doc_type = invoice.get("doc_type")
    line_items = _parse_line_items(invoice.get("line_items"))

    base: Dict[str, Any] = {
        "document_id": doc_id,
        "vendor_name": vendor,
        "doc_type": doc_type,
        "line_count": len(line_items),
    }

    if not line_items:
        base["reason"] = "no_line_items"
        base["sample_lines"] = []
        return base

    # Show first 5 line descriptions for context
    base["sample_lines"] = [
        str(li.get("description") or li.get("name") or "")[:80]
        for li in line_items[:5]
    ]

    # Find all fuel-matching lines with diagnostic info
    candidates: List[Dict[str, Any]] = []
    for li in line_items:
        desc = str(li.get("description") or li.get("name") or "")
        if not _is_fuel_line(desc):
            continue
        qty = _to_float(li.get("quantity"))
        unit_price = _to_float(li.get("unit_price"))
        is_tax = _is_fuel_tax_or_fee(desc)
        candidates.append({
            "description": desc[:100],
            "qty": qty,
            "unit_price": unit_price,
            "total": _to_float(li.get("total")),
            "is_tax_fee": is_tax,
            "reject_reason": (
                "tax_fee" if is_tax else
                "no_qty" if not qty else
                "low_qty" if qty < MIN_GALLONS else
                "no_unit_price" if not unit_price or unit_price <= 0 else
                "low_price" if unit_price < MIN_FUEL_PRICE else
                None
            ),
            "inferred_price": (
                round(total / qty, 4)
                if (not unit_price or unit_price <= 0)
                and qty and qty >= MIN_GALLONS
                and total and total > 0
                else None
            ),
        })

    base["fuel_candidates"] = candidates

    if not candidates:
        base["reason"] = "no_fuel_match"
        return base

    # Check if all candidates were rejected
    usable = [c for c in candidates if c["reject_reason"] is None]
    if not usable:
        # Summarise the most common rejection
        reasons = [c["reject_reason"] for c in candidates]
        if all(r == "tax_fee" for r in reasons):
            base["reason"] = "tax_only"
        elif any(r in ("no_qty", "low_qty") for r in reasons):
            base["reason"] = "qty_issue"
        elif any(r == "no_unit_price" for r in reasons):
            # Distinguish: has qty but no price at all = fuel release
            no_price_cands = [c for c in candidates if c["reject_reason"] == "no_unit_price"]
            has_any_total = any(c.get("inferred_price") is not None for c in no_price_cands)
            if has_any_total:
                base["reason"] = "price_issue"  # has total, just outside sanity range
            else:
                base["reason"] = "fuel_release_no_price"  # qty only, no $ at all
        elif any(r == "low_price" for r in reasons):
            base["reason"] = "price_issue"
        else:
            base["reason"] = "all_rejected"
        return base

    # Extraction would succeed
    base["reason"] = "ok"
    return base


# ── Slack payload ────────────────────────────────────────────────────────────


def build_fuel_price_slack_payload(
    *,
    airport_code: str,
    vendor_name: Optional[str],
    new_price: float,
    previous_price: float,
    pct_change: float,
    base_price: float,
    gallons: float,
    invoice_date: Optional[str],
    tail_number: Optional[str],
    document_id: str,
    signed_pdf_url: Optional[str] = None,
) -> Dict[str, Any]:
    """Build Slack Block Kit payload for a fuel price increase alert."""
    dash = "\u2014"
    tail = (tail_number or dash).strip() or dash
    vendor = (vendor_name or dash).strip() or dash
    change_amount = new_price - previous_price
    sign = "+" if change_amount >= 0 else ""
    inv_date = invoice_date or dash

    top_line = f"\u26fd Fuel Price Increase | {airport_code} | {sign}{pct_change:.1f}%"

    pdf_line = dash
    if signed_pdf_url:
        pdf_line = f"<{signed_pdf_url}|Open PDF>"

    return {
        "text": top_line,
        "blocks": [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": f"\u26fd Fuel Price Increase {dash} {airport_code}"},
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*Airport:*\n{airport_code}"},
                    {"type": "mrkdwn", "text": f"*Vendor:*\n{vendor}"},
                    {"type": "mrkdwn", "text": f"*New Effective:*\n${new_price:.4f}/gal"},
                    {"type": "mrkdwn", "text": f"*Previous:*\n${previous_price:.4f}/gal"},
                    {"type": "mrkdwn", "text": f"*Change:*\n{sign}${abs(change_amount):.4f}/gal ({sign}{pct_change:.1f}%)"},
                    {"type": "mrkdwn", "text": f"*Base Fuel:*\n${base_price:.4f}/gal"},
                    {"type": "mrkdwn", "text": f"*Gallons:*\n{gallons:.0f}"},
                    {"type": "mrkdwn", "text": f"*Tail:*\n{tail}"},
                ],
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*Invoice Date:* {inv_date}  \u2022  *PDF:* {pdf_line}"},
            },
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": f"document_id: `{document_id}`"}],
            },
        ],
    }
