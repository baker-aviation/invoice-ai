from typing import Any, Dict, List, Optional

def _safe_lower(s: Any) -> str:
    return str(s or "").lower()

def _line_item_texts(line_items: Any) -> List[str]:
    if not isinstance(line_items, list):
        return []
    out: List[str] = []
    for li in line_items:
        if isinstance(li, dict):
            out.append(_safe_lower(li.get("description")))
            out.append(_safe_lower(li.get("item")))
            out.append(_safe_lower(li.get("name")))
            out.append(_safe_lower(li.get("category")))
        else:
            out.append(_safe_lower(li))
    return [t for t in out if t]

def _warning_texts(warnings: Any) -> List[str]:
    """
    warnings may include:
      - 'ON_CONTRACT_PRICING'
      - 'KW:DE-ICE'
    We normalize these into searchable tokens.
    """
    if not isinstance(warnings, list):
        return []
    out: List[str] = []
    for w in warnings:
        wl = _safe_lower(w)
        if not wl:
            continue
        out.append(wl)
        # Also add simplified token for KW: tags, e.g. "kw:fsii" -> "fsii"
        if wl.startswith("kw:") and len(wl) > 3:
            out.append(wl[3:])
    return [t for t in out if t]

def _get_handling_fee(invoice: Dict[str, Any]) -> Optional[float]:
    """
    Support both shapes:
      invoice['handling_fee']
      invoice['totals']['handling_fee']
    """
    hf = invoice.get("handling_fee")
    if hf is None:
        hf = (invoice.get("totals") or {}).get("handling_fee")
    try:
        return float(hf) if hf is not None else None
    except Exception:
        return None

def rule_matches(rule: Dict[str, Any], invoice: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Returns a payload dict describing what matched, or None if no match.
    """
    texts: List[str] = []
    texts += _line_item_texts(invoice.get("line_items"))
    texts += _warning_texts(invoice.get("warnings"))

    # keyword match
    keywords = rule.get("keywords") or []
    if isinstance(keywords, str):
        keywords = [keywords]

    kw_hits: List[str] = []
    for kw in keywords:
        kwl = _safe_lower(kw)
        if not kwl:
            continue
        if any(kwl in t for t in texts):
            kw_hits.append(kw)

    if kw_hits:
        return {"type": "keywords", "hits": kw_hits}

    # handling fee threshold
    min_fee = rule.get("min_handling_fee")
    try:
        min_fee_val = float(min_fee) if min_fee is not None else None
    except Exception:
        min_fee_val = None

    handling_fee = _get_handling_fee(invoice)

    if min_fee_val is not None and handling_fee is not None and handling_fee >= min_fee_val:
        return {"type": "min_handling_fee", "min": min_fee_val, "value": handling_fee}

    return None