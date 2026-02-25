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

# ---------------------------------------------------
# Query helpers
# ---------------------------------------------------

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


def safe_select_in(
    table: str,
    columns: str,
    in_column: str,
    values: List[Any],
) -> List[Dict[str, Any]]:
    """Fetch rows where in_column is in values — single query, no N+1."""
    if not values:
        return []
    q = sb.table(table).select(columns).in_(in_column, list(values))
    res = _execute_with_retry(q)
    data = getattr(res, "data", None) or []
    return list(data)


def safe_insert(
    table: str,
    row: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
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

# ---------------------------------------------------
# Atomic WHERE update (used for Slack claim lock)
# ---------------------------------------------------

def safe_update_where(
    table: str,
    patch: Dict[str, Any],
    *,
    eq: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None,
) -> int:
    """
    Update rows with WHERE filters and return number of rows updated.

    Used for atomic "claim" operations like:
        pending -> sending

    Returns:
        int = number of rows updated
    """
    q = sb.table(table).update(patch)

    if eq:
        for k, v in eq.items():
            q = q.eq(k, v)

    if limit is not None:
        q = q.limit(int(limit))

    res = _execute_with_retry(q)
    data = getattr(res, "data", None) or []
    return len(data)


def safe_update_where_returning(
    table: str,
    patch: Dict[str, Any],
    *,
    eq: Optional[Dict[str, Any]] = None,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """
    Same as safe_update_where but returns updated rows.
    Useful for debugging.
    """
    q = sb.table(table).update(patch)

    if eq:
        for k, v in eq.items():
            q = q.eq(k, v)

    if limit is not None:
        q = q.limit(int(limit))

    res = _execute_with_retry(q)
    data = getattr(res, "data", None) or []
    return list(data)