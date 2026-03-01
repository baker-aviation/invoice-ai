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

from supa import safe_insert, safe_select_many, safe_select_one

log = logging.getLogger(__name__)

FUEL_PRICES_TABLE = "fuel_prices"
PARSED_TABLE = "parsed_invoices"

# Minimum gallons to count as a real fuel purchase
MIN_GALLONS = 10.0

# Price increase threshold
PRICE_INCREASE_PCT = 0.04  # 4%

# ── Helpers ──────────────────────────────────────────────────────────────────

_FUEL_RE = re.compile(
    r"\bjet\s*a\b|\bjet\s*fuel\b|\bjet\s*a[-\u2011]1\b|\bavgas\b|\b100\s*ll\b",
    re.IGNORECASE,
)


def _is_fuel_line(desc: str) -> bool:
    return bool(_FUEL_RE.search(desc or ""))


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
    fuel_line = None
    for li in line_items:
        desc = str(li.get("description") or li.get("name") or "")
        if _is_fuel_line(desc):
            qty = _to_float(li.get("quantity"))
            unit_price = _to_float(li.get("unit_price"))
            if qty and qty >= MIN_GALLONS and unit_price and unit_price > 0:
                fuel_line = li
                break

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
            "price_change_pct": round(pct_change * 100, 2),
            "price_change_amount": round(effective_price - prev_price, 5),
        }

    return None


# ── Storage ──────────────────────────────────────────────────────────────────


def store_fuel_price(
    data: Dict[str, Any],
    increase: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Insert a fuel price record. Returns inserted row, or None on duplicate."""
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
        "alert_sent": bool(increase),
    }

    try:
        return safe_insert(FUEL_PRICES_TABLE, row)
    except Exception as e:
        if "23505" in repr(e) or "duplicate" in repr(e).lower():
            log.info("fuel_prices duplicate for document_id=%s", data.get("document_id"))
            return None
        raise


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
