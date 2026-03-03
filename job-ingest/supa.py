# supa.py
import os
from supabase import create_client, Client

_supabase: Client | None = None

def sb() -> Client:
    """
    Return a cached Supabase client.
    Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
    """
    global _supabase
    if _supabase is None:
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        _supabase = create_client(url, key)
    return _supabase


def log_pipeline_run(
    pipeline: str,
    *,
    status: str = "ok",
    message: str = "",
    items: int = 0,
    duration_ms: int | None = None,
):
    """Log a row to pipeline_runs for health monitoring. Fire-and-forget."""
    try:
        sb().table("pipeline_runs").insert({
            "pipeline": pipeline,
            "status": status,
            "message": message,
            "items": items,
            "duration_ms": duration_ms,
        }).execute()
    except Exception as e:
        print(f"[log_pipeline_run] {pipeline}: {e}", flush=True)