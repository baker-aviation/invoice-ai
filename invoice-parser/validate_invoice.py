import argparse
import json
import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

BAD_INVOICE_NUMBERS = {"invoice", "invoice #", "invoice number", "inv", "statement"}

def D(x) -> Decimal:
    if x is None:
        return Decimal("0")
    return Decimal(str(x))

def money(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def is_valid_date(s: Optional[str]) -> bool:
    if not s:
        return False
    # allow ISO-ish dates; normalization happens upstream
    return bool(re.search(r"\d{4}-\d{2}-\d{2}", s) or re.search(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}", s))

def validate(data: dict) -> dict:
    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []

    score = 0

    vendor = (data.get("vendor") or {}).get("name")
    if vendor:
        score += 30
    else:
        errors.append({"code": "MISSING_VENDOR", "field": "vendor.name"})

    inv_no = data.get("invoice_number")
    if inv_no and str(inv_no).strip().lower() in BAD_INVOICE_NUMBERS:
        warnings.append({"code": "BAD_INVOICE_NUMBER_LABEL", "value": inv_no})
        inv_no = None

    if inv_no:
        score += 10
    else:
        warnings.append({"code": "MISSING_INVOICE_NUMBER", "field": "invoice_number"})

    invoice_date = data.get("invoice_date")
    if is_valid_date(invoice_date):
        score += 20
    else:
        warnings.append({"code": "MISSING_OR_UNPARSEABLE_INVOICE_DATE", "field": "invoice_date"})

    # These should not block passing:
    if not data.get("tail_number"):
        warnings.append({"code": "MISSING_TAIL_NUMBER", "field": "tail_number"})
    if not data.get("currency"):
        warnings.append({"code": "MISSING_CURRENCY", "field": "currency"})

    totals = data.get("totals") or {}

    total_amount = totals.get("total_amount")
    subtotal = totals.get("subtotal")
    sales_tax = totals.get("sales_tax")
    fuel_tax = totals.get("fuel_tax")

    have_any_total = any(x is not None for x in [total_amount, subtotal, sales_tax, fuel_tax])
    if have_any_total:
        score += 30
    else:
        warnings.append({"code": "MISSING_TOTALS_BLOCK", "field": "totals"})

    # Line items are helpful but should not be required to pass
    line_items = data.get("line_items") or []
    if isinstance(line_items, list) and len(line_items) > 0:
        score += 10
    else:
        warnings.append({"code": "MISSING_LINE_ITEMS", "field": "line_items"})

    # If we do have line totals + invoice total, attempt a soft reconciliation
    line_items_sum = Decimal("0")
    for i, li in enumerate(line_items):
        desc = li.get("description")
        if not desc:
            warnings.append({"code": "LINE_ITEM_MISSING_DESCRIPTION", "line_item_index": i})

        t = li.get("total")
        if t is None:
            continue
        try:
            line_items_sum += money(D(t))
        except Exception:
            warnings.append({"code": "LINE_ITEM_BAD_TOTAL", "line_item_index": i, "value": t})

    line_items_sum = money(line_items_sum)

    invoice_total = money(D(total_amount)) if total_amount is not None else None
    delta = None
    recon_mode = None

    if invoice_total is not None and line_items_sum != Decimal("0.00"):
        delta = money(line_items_sum - invoice_total)
        if abs(delta) <= Decimal("0.05"):
            recon_mode = "LINES_EQ_TOTAL_SOFT"
        else:
            # invoice-level tax is common
            if subtotal is not None:
                sub = money(D(subtotal))
                d2 = money(line_items_sum - sub)
                if abs(d2) <= Decimal("0.05"):
                    recon_mode = "LINES_EQ_SUBTOTAL_SOFT"
                else:
                    warnings.append({
                        "code": "TOTAL_RECONCILIATION_WARN",
                        "line_items_sum": float(line_items_sum),
                        "invoice_total": float(invoice_total),
                        "delta": float(delta)
                    })

    # PASS RULE:
    # - Must have vendor
    # - Must have (date OR totals) so we can anchor the invoice
    validation_pass = (vendor is not None) and (is_valid_date(invoice_date) or have_any_total) and score >= 60

    return {
        "validation_pass": validation_pass,
        "validation_score": score,
        "errors": errors,
        "warnings": warnings,
        "line_items_sum": float(line_items_sum),
        "invoice_total": float(invoice_total) if invoice_total is not None else None,
        "delta": float(delta) if delta is not None else None,
        "recon_mode": recon_mode
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--infile", required=True)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    with open(args.infile, "r", encoding="utf-8") as f:
        data = json.load(f)

    res = validate(data)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2)

    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    main()