# supa.py
import json
import os
import random
import time
from typing import Any, Dict, List, Optional, Tuple

import requests

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var")

REST_BASE = f"{SUPABASE_URL}/rest/v1"

_DEFAULT_HEADERS = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
}


# ---------------------------------------------------
# Retry helpers
# ---------------------------------------------------

def _is_transient_error(e: Exception) -> bool:
    msg = repr(e).lower()
    return any(
        s in msg
        for s in (
            "readerror",
            "resource temporarily unavailable",
            "timeout",
            "timed out",
            "connection reset",
            "connection aborted",
            "server disconnected",
            "broken pipe",
            "temporary failure",
            "502",
            "503",
            "504",
        )
    )


def _sleep_backoff(attempt: int) -> None:
    base = 0.25 * (2 ** attempt)  # 0.25, 0.5, 1.0, 2.0
    jitter = random.uniform(0, 0.15)
    time.sleep(min(2.5, base + jitter))


def _request_with_retry(
    method: str,
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    params: Optional[Dict[str, str]] = None,
    json_body: Any = None,
    tries: int = 4,
    timeout: int = 15,
) -> requests.Response:
    last: Optional[Exception] = None
    for attempt in range(tries):
        try:
            r = requests.request(
                method,
                url,
                headers=headers,
                params=params,
                json=json_body,
                timeout=timeout,
            )
            return r
        except Exception as e:
            last = e
            if attempt < tries - 1 and _is_transient_error(e):
                _sleep_backoff(attempt)
                continue
            raise
    if last:
        raise last
    raise RuntimeError("request failed without exception?")


def _raise_for_status(r: requests.Response) -> None:
    if 200 <= r.status_code < 300:
        return
    # Include a trimmed body for debugging
    body = (r.text or "")[:1200]
    raise RuntimeError(f"Supabase REST error {r.status_code}: {body}")


def _build_eq_params(eq: Optional[Dict[str, Any]]) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not eq:
        return out
    for k, v in eq.items():
        if v is None:
            out[k] = "is.null"
        else:
            out[k] = f"eq.{v}"
    return out


# ---------------------------------------------------
# Query helpers (PostgREST)
# ---------------------------------------------------

def safe_select_one(
    table: str,
    columns: str = "*",
    *,
    eq: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    url = f"{REST_BASE}/{table}"
    params = {"select": columns, "limit": "1"}
    params.update(_build_eq_params(eq))

    r = _request_with_retry("GET", url, headers=_DEFAULT_HEADERS, params=params)
    _raise_for_status(r)
    data = r.json() or []
    if not data:
        return None
    return data[0]


def safe_select_many(
    table: str,
    columns: str = "*",
    *,
    eq: Optional[Dict[str, Any]] = None,
    limit: int = 100,
    order: Optional[str] = None,
    desc: bool = False,
) -> List[Dict[str, Any]]:
    url = f"{REST_BASE}/{table}"
    params: Dict[str, str] = {"select": columns, "limit": str(int(limit))}
    params.update(_build_eq_params(eq))

    if order:
        direction = "desc" if desc else "asc"
        params["order"] = f"{order}.{direction}"

    r = _request_with_retry("GET", url, headers=_DEFAULT_HEADERS, params=params)
    _raise_for_status(r)
    data = r.json() or []
    return list(data)


def safe_insert(
    table: str,
    row: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    url = f"{REST_BASE}/{table}"
    headers = dict(_DEFAULT_HEADERS)
    headers["Prefer"] = "return=representation"

    r = _request_with_retry("POST", url, headers=headers, json_body=row)
    _raise_for_status(r)
    data = r.json() or []
    if not data:
        return None
    return data[0]


def safe_update(
    table: str,
    row_id: str,
    patch: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    url = f"{REST_BASE}/{table}"
    params = {"id": f"eq.{row_id}", "select": "*"}
    headers = dict(_DEFAULT_HEADERS)
    headers["Prefer"] = "return=representation"

    r = _request_with_retry("PATCH", url, headers=headers, params=params, json_body=patch)
    _raise_for_status(r)
    data = r.json() or []
    if not data:
        return None
    return data[0]


def safe_update_where(
    table: str,
    patch: Dict[str, Any],
    *,
    eq: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None,
) -> int:
    """
    Atomic-ish update using WHERE filters.
    Returns number of rows updated (based on returned representation).
    This is what we use for the Slack CLAIM lock.
    """
    url = f"{REST_BASE}/{table}"
    params: Dict[str, str] = {"select": "id"}
    params.update(_build_eq_params(eq))

    if limit is not None:
        params["limit"] = str(int(limit))

    headers = dict(_DEFAULT_HEADERS)
    headers["Prefer"] = "return=representation"

    r = _request_with_retry("PATCH", url, headers=headers, params=params, json_body=patch)
    _raise_for_status(r)
    data = r.json() or []
    return len(data)


def safe_update_where_returning(
    table: str,
    patch: Dict[str, Any],
    *,
    eq: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None,
    columns: str = "*",
) -> List[Dict[str, Any]]:
    url = f"{REST_BASE}/{table}"
    params: Dict[str, str] = {"select": columns}
    params.update(_build_eq_params(eq))

    if limit is not None:
        params["limit"] = str(int(limit))

    headers = dict(_DEFAULT_HEADERS)
    headers["Prefer"] = "return=representation"

    r = _request_with_retry("PATCH", url, headers=headers, params=params, json_body=patch)
    _raise_for_status(r)
    data = r.json() or []
    return list(data)