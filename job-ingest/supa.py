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