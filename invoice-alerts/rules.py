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
    v = rule.get("is_enabled")
    if v is None:
        v = rule.get("enabled")
    return bool(v)


def _line_item_is_charged(li: Dict[str, Any]) -> bool:
    """
    A charged line item must have a positive total.
    Ignores:
      - zero (waived)
      - negative (credits)
    """
    total = _to_float(li.get("total")) or 0.0
    return total > 0.01


def _keyword_match(
    keywords: List[str],
    invoice: Dict[str, Any],
    *,
    require_charged_line_items: bool = False,
) -> Tuple[Set[str], List[Dict[str, Any]]]:

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
        li_hit = False

        for kw in kws:
            if kw in desc or kw in invoice_text:
                matched_kws.add(kw)
                if kw in desc:
                    li_hit = True

        if li_hit:
            if require_charged_line_items and not _line_item_is_charged(li):
                continue
            matched_items.append(li)

    # invoice-level keyword only
    if not matched_kws:
        for kw in kws:
            if kw in invoice_text:
                matched_kws.add(kw)

    return matched_kws, matched_items


def rule_matches(rule: Dict[str, Any], invoice: Dict[str, Any]) -> RuleMatchResult:

    if not _is_rule_enabled(rule):
        return RuleMatchResult(False, "rule disabled", [], [])

    # --- Filters ---
    vendor_allowed = _listify(rule.get("vendor_normalized_in"))
    doc_type_allowed = _listify(rule.get("doc_type_in"))
    airport_allowed = _listify(rule.get("airport_code_in"))
    require_review_required = rule.get("require_review_required")

    inv_vendor_norm = _norm(invoice.get("vendor_normalized") or invoice.get("vendor_name"))
    inv_doc_type = _norm(invoice.get("doc_type"))
    inv_airport = _norm(invoice.get("airport_code"))

    if vendor_allowed:
        allowed = {_norm(x) for x in vendor_allowed if _norm(x)}
        if inv_vendor_norm not in allowed:
            return RuleMatchResult(False, "vendor filter mismatch", [], [])

    if doc_type_allowed:
        allowed = {_norm(x) for x in doc_type_allowed if _norm(x)}
        if inv_doc_type not in allowed:
            return RuleMatchResult(False, "doc_type filter mismatch", [], [])

    if airport_allowed:
        allowed = {_norm(x) for x in airport_allowed if _norm(x)}
        if inv_airport not in allowed:
            return RuleMatchResult(False, "airport filter mismatch", [], [])

    if require_review_required is True:
        if not bool(invoice.get("review_required")):
            return RuleMatchResult(False, "invoice not review_required", [], [])

    # --- Invoice-level thresholds ---
    inv_total = _to_float(invoice.get("total"))
    min_total = _to_float(rule.get("min_total"))

    if min_total is not None and inv_total is not None:
        if inv_total < min_total:
            return RuleMatchResult(False, "total below min_total", [], [])

    # --- Keywords ---
    keywords = [str(k) for k in _listify(rule.get("keywords")) if k]

    require_charged_line_items = bool(rule.get("require_charged_line_items"))

    matched_kws, matched_items = _keyword_match(
        keywords,
        invoice,
        require_charged_line_items=require_charged_line_items,
    )

    if keywords and not matched_kws:
        return RuleMatchResult(False, "no keyword match", [], [])

    if require_charged_line_items and not matched_items:
        return RuleMatchResult(False, "no charged line item matches", [], sorted(matched_kws))

    # --- NEW: Per-line-item minimum threshold ---
    min_line_item_amount = _to_float(rule.get("min_line_item_amount"))

    if min_line_item_amount is not None:
        qualifying = []
        for li in matched_items:
            amt = _to_float(li.get("total")) or 0.0
            if amt >= min_line_item_amount:
                qualifying.append(li)

        if not qualifying:
            return RuleMatchResult(
                False,
                f"no line items >= {min_line_item_amount}",
                matched_items,
                sorted(matched_kws),
            )

        matched_items = qualifying

    reason = "matched"
    if matched_kws:
        reason = f"keyword match: {', '.join(sorted(matched_kws))}"

    return RuleMatchResult(True, reason, matched_items, sorted(matched_kws))