# rules.py
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple


@dataclass
class RuleMatchResult:
    matched: bool
    reason: str
    matched_line_items: List[Dict[str, Any]]
    matched_keywords: List[str]


def _norm(s: Any) -> str:
    if s is None:
        return ""
    if not isinstance(s, str):
        s = str(s)
    return s.strip().lower()


def _listify(v: Any) -> List[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    # PostgREST sometimes returns arrays as Python lists already.
    # If it comes as a string, we treat as single value.
    return [v]


def _to_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace("$", "").replace(",", "")
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None
    return None


def _is_rule_enabled(rule: Dict[str, Any]) -> bool:
    # Your table has both `is_enabled` and `enabled` (both boolean)
    v = rule.get("is_enabled")
    if v is None:
        v = rule.get("enabled")
    return bool(v)


def _is_waived_line_item(li: Dict[str, Any]) -> bool:
    """
    Best-effort waiver detection using your current line item schema:
      - total == 0 (or near-zero)
      - but unit_price > 0 and quantity > 0

    This catches your Signature example:
      unit_price: 1660, qty: 1, total: 0  => waived
    """
    qty = _to_float(li.get("quantity")) or 0.0
    unit = _to_float(li.get("unit_price")) or 0.0
    total = _to_float(li.get("total")) or 0.0
    return qty > 0 and unit > 0 and abs(total) < 0.01


def _line_item_is_charged(li: Dict[str, Any]) -> bool:
    """
    A "charged" line item is one that actually contributes to amount charged.
    For now: total > 0 (with a tiny epsilon).
    """
    total = _to_float(li.get("total")) or 0.0
    return total > 0.01


def _keyword_match(
    keywords: List[str],
    invoice: Dict[str, Any],
    *,
    require_charged_line_items: bool = False,
) -> Tuple[Set[str], List[Dict[str, Any]]]:
    """
    Match keywords against:
      - each line_item description/name/desc
      - plus a coarse "invoice text" (vendor_name, invoice_number, airport_code, etc.)

    If require_charged_line_items=True:
      - we ONLY return matched_line_items whose total > 0
      - invoice_text-only matches are still tracked in matched_keywords,
        but rule_matches() can decide whether that counts as a match.
    """
    kws = [k for k in (_norm(k) for k in keywords) if k]
    if not kws:
        return set(), []

    line_items = invoice.get("line_items") or []
    matched_items: List[Dict[str, Any]] = []
    matched_kws: Set[str] = set()

    invoice_text = " ".join(
        [
            _norm(invoice.get("vendor_name")),
            _norm(invoice.get("vendor_normalized")),
            _norm(invoice.get("invoice_number")),
            _norm(invoice.get("airport_code")),
            _norm(invoice.get("tail_number")),
            _norm(invoice.get("doc_type")),
        ]
    )

    for li in line_items:
        desc = _norm(li.get("description") or li.get("name") or li.get("desc"))
        hay = desc or ""
        li_hit = False

        for kw in kws:
            if kw and (kw in hay or kw in invoice_text):
                matched_kws.add(kw)
                li_hit = li_hit or (kw in hay)

        if li_hit:
            # If this rule wants only "charged" matches, filter here.
            if require_charged_line_items and not _line_item_is_charged(li):
                continue
            matched_items.append(li)

    # If keywords matched invoice_text but not specific line items,
    # we still record that a keyword matched. (matched_items may be empty.)
    if not matched_kws:
        for kw in kws:
            if kw and kw in invoice_text:
                matched_kws.add(kw)

    return matched_kws, matched_items


def rule_matches(rule: Dict[str, Any], invoice: Dict[str, Any]) -> RuleMatchResult:
    if not _is_rule_enabled(rule):
        return RuleMatchResult(False, "rule disabled", [], [])

    # Filters
    vendor_allowed = _listify(rule.get("vendor_normalized_in"))
    doc_type_allowed = _listify(rule.get("doc_type_in"))
    airport_allowed = _listify(rule.get("airport_code_in"))
    require_review_required = rule.get("require_review_required")

    inv_vendor_norm = _norm(invoice.get("vendor_normalized") or invoice.get("vendor_name"))
    inv_doc_type = _norm(invoice.get("doc_type"))
    inv_airport = _norm(invoice.get("airport_code"))

    if vendor_allowed:
        allowed_norm = {_norm(x) for x in vendor_allowed if _norm(x)}
        if inv_vendor_norm not in allowed_norm:
            return RuleMatchResult(False, "vendor not in vendor_normalized_in", [], [])

    if doc_type_allowed:
        allowed_norm = {_norm(x) for x in doc_type_allowed if _norm(x)}
        if inv_doc_type not in allowed_norm:
            return RuleMatchResult(False, "doc_type not in doc_type_in", [], [])

    if airport_allowed:
        allowed_norm = {_norm(x) for x in airport_allowed if _norm(x)}
        if inv_airport not in allowed_norm:
            return RuleMatchResult(False, "airport_code not in airport_code_in", [], [])

    if require_review_required is True:
        if not bool(invoice.get("review_required")):
            return RuleMatchResult(False, "invoice not review_required", [], [])

    # Thresholds (only enforce if present)
    inv_total = _to_float(invoice.get("total"))
    inv_handling_fee = _to_float(invoice.get("handling_fee"))
    inv_service_fee = _to_float(invoice.get("service_fee"))
    inv_surcharge = _to_float(invoice.get("surcharge"))
    inv_risk_score = invoice.get("risk_score")

    min_total = _to_float(rule.get("min_total"))
    min_handling_fee = _to_float(rule.get("min_handling_fee"))
    min_service_fee = _to_float(rule.get("min_service_fee"))
    min_surcharge = _to_float(rule.get("min_surcharge"))
    min_risk_score = rule.get("min_risk_score")

    if min_total is not None and inv_total is not None and inv_total < min_total:
        return RuleMatchResult(False, "total below min_total", [], [])
    if min_handling_fee is not None and inv_handling_fee is not None and inv_handling_fee < min_handling_fee:
        return RuleMatchResult(False, "handling_fee below min_handling_fee", [], [])
    if min_service_fee is not None and inv_service_fee is not None and inv_service_fee < min_service_fee:
        return RuleMatchResult(False, "service_fee below min_service_fee", [], [])
    if min_surcharge is not None and inv_surcharge is not None and inv_surcharge < min_surcharge:
        return RuleMatchResult(False, "surcharge below min_surcharge", [], [])
    if min_risk_score is not None and inv_risk_score is not None:
        try:
            if int(inv_risk_score) < int(min_risk_score):
                return RuleMatchResult(False, "risk_score below min_risk_score", [], [])
        except Exception:
            pass

    # Keywords (Postgres ARRAY comes through as a Python list)
    keywords = _listify(rule.get("keywords"))
    keywords = [str(k) for k in keywords if k is not None]

    # NEW: allow per-rule behavior to require "charged" matches only.
    # This prevents waived $0 line items (like waived Handling Fee) from triggering alerts.
    #
    # Add a boolean column in your rules table when you're ready, e.g.:
    #   require_charged_line_items boolean default false
    #
    # Then set it TRUE for rules like "Handling fee" / "Service fee" etc.
    require_charged_line_items = bool(rule.get("require_charged_line_items"))

    matched_kws, matched_items = _keyword_match(
        keywords,
        invoice,
        require_charged_line_items=require_charged_line_items,
    )

    # Match behavior:
    # - If a rule has keywords, it must match at least one keyword.
    # - If rule has no keywords, it's still a match if it passed filters/thresholds.
    if keywords and not matched_kws:
        return RuleMatchResult(False, "no keyword match", [], [])

    # NEW: if this rule requires charged line items, invoice_text-only matches do NOT count.
    # We need at least one matched line item that is charged (total > 0).
    if require_charged_line_items and not matched_items:
        return RuleMatchResult(False, "no charged line item matches", [], sorted(matched_kws))

    reason = "matched"
    if matched_kws:
        reason = f"keyword match: {', '.join(sorted(matched_kws))}"

    return RuleMatchResult(True, reason, matched_items, sorted(matched_kws))