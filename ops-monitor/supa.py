import os
from supabase import create_client, Client


def sb() -> Client:
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var")
    return create_client(url, key)


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
