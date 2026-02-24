# job-parse/supa.py
import os
import random
import time
from typing import Any, Dict, List, Optional

from supabase import Client, create_client

_SUPA: Optional[Client] = None


def _require(name: str, value: str) -> str:
    if not value or not str(value).strip():
        raise RuntimeError(f"Missing {name} env var")
    return value.strip()


def _client() -> Client:
    """
    Lazily create and cache the Supabase client.
    IMPORTANT: Do NOT raise at import time (Cloud Run must start).
    """
    global _SUPA
    if _SUPA is not None:
        return _SUPA

    url = _require("SUPABASE_URL", os.getenv("SUPABASE_URL", ""))
    key = _require("SUPABASE_SERVICE_ROLE_KEY", os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))
    _SUPA = create_client(url, key)
    return _SUPA


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
    sb = _client()
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
    sb = _client()
    q = sb.table(table).select(columns)

    if eq:
        for k, v in eq.items():
            q = q.eq(k, v)

    if order:
        q = q.order(order, desc=desc)

    res = _execute_with_retry(q.limit(int(limit)))
    data = getattr(res, "data", None) or []
    return list(data)