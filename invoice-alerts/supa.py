# supa.py
import os
import random
import time
from typing import Any, Dict, List, Optional

from supabase import Client, create_client

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var")

sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# -----------------------------
# Retry helpers
# -----------------------------

def _is_transient_error(e: Exception) -> bool:
    msg = repr(e).lower()
    # httpx/httpcore transient read/network issues
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
    # exponential backoff + jitter
    base = 0.25 * (2 ** attempt)  # 0.25, 0.5, 1.0, 2.0
    jitter = random.uniform(0, 0.15)
    time.sleep(min(2.5, base + jitter))


def _execute_with_retry(q, *, tries: int = 4):
    last: Optional[Exception] = None
    for attempt in range(tries):
        try:
            return q.execute()
        except Exception as e:
            last = e
            if attempt < tries - 1 and _is_transient_error(e):
                _sleep_backoff(attempt)
                continue
            raise
    if last:
        raise last
    raise RuntimeError("execute failed without exception?")

# -----------------------------
# Query helpers
# -----------------------------

def safe_select_one(
    table: str,
    columns: str = "*",
    *,
    eq: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    q = sb.table(table).select(columns)
    if eq:
        for k, v in eq.items():
            q = q.eq(k, v)

    res = _execute_with_retry(q.limit(1))
    data = getattr(res, "data", None) or []
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
    q = sb.table(table).select(columns)
    if eq:
        for k, v in eq.items():
            q = q.eq(k, v)

    if order:
        q = q.order(order, desc=desc)

    res = _execute_with_retry(q.limit(int(limit)))
    data = getattr(res, "data", None) or []
    return list(data)


def safe_insert(
    table: str,
    row: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    # postgrest returns inserted rows in .data
    q = sb.table(table).insert(row)
    res = _execute_with_retry(q)
    data = getattr(res, "data", None) or []
    if not data:
        return None
    return data[0]


def safe_update(
    table: str,
    row_id: str,
    patch: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    q = sb.table(table).update(patch).eq("id", row_id)
    res = _execute_with_retry(q)
    data = getattr(res, "data", None) or []
    if not data:
        return None
    return data[0]