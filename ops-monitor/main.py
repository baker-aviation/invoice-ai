# ops-monitor/main.py
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, HTTPException, Query
from icalendar import Calendar
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from supa import sb, log_pipeline_run
from auth_middleware import add_auth_middleware

app = FastAPI()
add_auth_middleware(app)
limiter = Limiter(key_func=get_remote_address, default_limits=["60/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ─── Config ───────────────────────────────────────────────────────────────────

# ICS URLs: prefer database (ics_sources table), fall back to env vars.
_raw_ics = os.getenv("JETINSIGHT_ICS_URLS") or os.getenv("JETINSIGHT_ICS_URL") or ""
_ENV_ICS_URLS: list[str] = [u.strip() for u in _raw_ics.splitlines() if u.strip()]
# Legacy global kept for debug endpoints that reference it at module level.
ICS_URLS: list[str] = list(_ENV_ICS_URLS)


def _load_ics_urls() -> list[str]:
    """Load enabled ICS URLs from the ics_sources table, falling back to env."""
    try:
        supa = sb()
        rows = supa.table("ics_sources").select("id,url").eq("enabled", True).execute()
        db_urls = [r["url"] for r in (rows.data or []) if r.get("url")]
        if db_urls:
            return db_urls
    except Exception as e:
        print(f"[_load_ics_urls] DB read failed, using env fallback: {e}", flush=True)
    return list(_ENV_ICS_URLS)


def _seed_ics_sources_from_env() -> Dict[str, Any]:
    """Insert env-var ICS URLs into ics_sources table (skips duplicates)."""
    if not _ENV_ICS_URLS:
        return {"seeded": 0, "skipped": 0, "message": "No env var URLs to seed"}
    supa = sb()
    existing = supa.table("ics_sources").select("url").execute()
    existing_urls = {r["url"] for r in (existing.data or [])}
    seeded = 0
    skipped = 0
    for i, url in enumerate(_ENV_ICS_URLS):
        if url in existing_urls:
            skipped += 1
            continue
        supa.table("ics_sources").insert({
            "label": f"Aircraft {i + 1}",
            "url": url,
            "enabled": True,
        }).execute()
        seeded += 1
    return {"seeded": seeded, "skipped": skipped, "total_env": len(_ENV_ICS_URLS)}


def _update_ics_sync_status(supa, url: str, ok: bool) -> None:
    """Update last_sync_at/last_sync_ok for an ICS source by URL."""
    try:
        supa.table("ics_sources").update({
            "last_sync_at": datetime.now(timezone.utc).isoformat(),
            "last_sync_ok": ok,
        }).eq("url", url).execute()
    except Exception:
        pass  # non-critical
SAMSARA_API_KEY = os.getenv("SAMSARA_API_KEY")
FAA_CLIENT_ID = os.getenv("FAA_CLIENT_ID")
FAA_CLIENT_SECRET = os.getenv("FAA_CLIENT_SECRET")

# JetInsight ICS events with these flight types are scheduling/admin notes,
# not actual aircraft movements.  Skip them during sync.
_SKIP_FLIGHT_TYPES = {
    "Aircraft away from home base",
    "Aircraft needs repositioning",
}
# SUMMARY keywords that indicate a non-flight entry regardless of flight_type.
_SKIP_SUMMARY_KEYWORDS = {"NOT FLYING"}

# FAA NMS API (production)
NMS_AUTH_URL = "https://api-nms.aim.faa.gov/v1/auth/token"
NMS_API_BASE = "https://api-nms.aim.faa.gov/nmsapi"

FOREFLIGHT_MAILBOX = os.getenv("FOREFLIGHT_MAILBOX", "ForeFlight@baker-aviation.com")
MS_TENANT_ID = os.getenv("MS_TENANT_ID")
MS_CLIENT_ID = os.getenv("MS_CLIENT_ID")
MS_CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")

FLIGHTS_TABLE = "flights"
OPS_ALERTS_TABLE = "ops_alerts"


def _extract_notam_dates(raw_data) -> Optional[Dict[str, Optional[str]]]:
    """Pull effective start/end/issued dates from raw_data.

    Handles three formats:
    1. **Compact** (new): ``{"notam_dates": {...}}`` — already extracted.
    2. **Full GeoJSON**: ``{properties: {coreNOTAMData: {notam: {...}}}}``
    3. **GeoJSON variant**: dates at ``coreNOTAMData`` level, not inside ``notam``

    Returns a small dict with just the date strings, or None if parsing fails.
    """
    try:
        feature = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
        # New compact format — stored by check_notams after 2025-02-27
        if "notam_dates" in feature:
            return feature["notam_dates"]
        # GeoJSON: check both coreNOTAMData.notam and coreNOTAMData itself
        core = feature.get("properties", {}).get("coreNOTAMData", {})
        notam = core.get("notam") or {}
        return _pick_dates(notam, core)
    except Exception:
        return None


def _pick_dates(*sources: dict) -> Optional[Dict[str, Optional[str]]]:
    """Extract NOTAM date fields from one or more dicts (first non-None wins).

    Checks camelCase (NMS/legacy) and snake_case field name variants."""
    def _first(*keys):
        for src in sources:
            for k in keys:
                v = src.get(k)
                if v:
                    return v
        return None

    result = {
        "effective_start": _first("effectiveStart", "effective_start"),
        "effective_end": _first("effectiveEnd", "effective_end"),
        "issued": _first("issued", "issue_date", "issueDate"),
        "status": _first("status"),
        "start_date_utc": _first("startDate", "start_date_utc", "startDateTime"),
        "end_date_utc": _first("endDate", "end_date_utc", "endDateTime"),
        "issue_date_utc": _first("issueDate", "issue_date_utc", "issuedDateTime"),
    }
    # Return None only if every value is None (no dates found at all)
    if all(v is None for v in result.values()):
        return None
    return result


# ─── NMS bearer token cache (module-level, refreshed when expired) ────────────

import time as _time

_nms_token_cache: Dict[str, Any] = {"token": None, "expires_at": 0.0}
_nms_token_lock = threading.Lock()


def _get_nms_token() -> str:
    """Fetch (or return cached) NMS bearer token using client_credentials flow.
    Thread-safe: only one thread fetches a new token at a time."""
    now = _time.time()
    if _nms_token_cache["token"] and now < _nms_token_cache["expires_at"] - 60:
        return _nms_token_cache["token"]
    with _nms_token_lock:
        # Re-check inside lock — another thread may have refreshed already
        now = _time.time()
        if _nms_token_cache["token"] and now < _nms_token_cache["expires_at"] - 60:
            return _nms_token_cache["token"]
        if not FAA_CLIENT_ID or not FAA_CLIENT_SECRET:
            raise RuntimeError("FAA_CLIENT_ID / FAA_CLIENT_SECRET not configured")
        r = requests.post(
            NMS_AUTH_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": FAA_CLIENT_ID,
                "client_secret": FAA_CLIENT_SECRET,
            },
            timeout=(5, 10),  # (connect, read) — prevents indefinite hang
        )
        r.raise_for_status()
        data = r.json()
        token = data["access_token"]
        expires_in = int(data.get("expires_in", 1799))
        _nms_token_cache["token"] = token
        _nms_token_cache["expires_at"] = now + expires_in
        print(f"NMS token refreshed, expires in {expires_in}s", flush=True)
        return token


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_graph_token() -> str:
    url = f"https://login.microsoftonline.com/{MS_TENANT_ID}/oauth2/v2.0/token"
    r = requests.post(url, data={
        "client_id": MS_CLIENT_ID,
        "client_secret": MS_CLIENT_SECRET,
        "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }, timeout=20)
    r.raise_for_status()
    return r.json()["access_token"]


def _graph_get(url: str, token: str, params: Dict = None) -> Dict:
    r = requests.get(
        url,
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _to_aware(dt) -> Optional[datetime]:
    """Normalize an icalendar dt value to a timezone-aware datetime."""
    if dt is None:
        return None
    if hasattr(dt, "hour"):  # datetime
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    # date-only — treat as UTC midnight
    return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)


def _faa_to_icao(code: str) -> str:
    """
    Convert a 3-letter FAA airport code to a 4-letter ICAO code.
    Most US airports are K + FAA code. Canadian airports start with C.
    If the code is already 4 letters, return as-is.
    """
    code = code.upper().strip()
    if len(code) == 4:
        return code
    if len(code) == 3:
        # Canadian airports typically already come as 4-letter (CYYZ etc.)
        # US domestic: prepend K
        return "K" + code
    return code


def _parse_flight_fields(component) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    """
    Extract (departure_icao, arrival_icao, tail_number, flight_type) from a JetInsight VEVENT.

    JetInsight SUMMARY format:
        [N998CX] The Early Way (SDM - SNA) - Positioning flight
    LOCATION field contains the departure airport (3-letter FAA code).
    Times are always UTC (Z suffix).
    """
    summary = str(component.get("SUMMARY", ""))
    description = str(component.get("DESCRIPTION", ""))
    location = str(component.get("LOCATION", "")).strip().upper()

    # ── Tail number: prefer [NXXXXX] bracket format ──────────────────────────
    tail = None
    bracket_m = re.search(r"\[([A-Z0-9]{3,8})\]", summary)
    if bracket_m:
        tail = bracket_m.group(1).upper()
    else:
        # Fallback: bare N-number anywhere in summary/description
        bare_m = re.search(r"\b(N\d{1,5}[A-Z]{0,2})\b", f"{summary} {description}")
        if bare_m:
            tail = bare_m.group(1).upper()

    # ── Airport pair: (SDM - SNA) or (KSDM - KSNA) in summary ───────────────
    dep_icao = arr_icao = None
    paren_m = re.search(r"\(([A-Z]{3,4})\s*[-–]\s*([A-Z]{3,4})\)", summary)
    if paren_m:
        dep_icao = _faa_to_icao(paren_m.group(1))
        arr_icao = _faa_to_icao(paren_m.group(2))

    # ── Fallback: LOCATION field → departure ─────────────────────────────────
    if not dep_icao and location and re.match(r"^[A-Z]{3,4}$", location):
        dep_icao = _faa_to_icao(location)

    # ── Flight type: extract from CATEGORIES property or SUMMARY suffix ──────
    flight_type = None
    # Try CATEGORIES ICS property first (icalendar vCategory is list-like)
    categories = component.get("CATEGORIES")
    if categories is not None:
        try:
            # vCategory.to_ical() returns bytes like b"Revenue" — most reliable
            if hasattr(categories, "to_ical"):
                raw_cat = categories.to_ical()
                cat_str = raw_cat.decode("utf-8", errors="replace") if isinstance(raw_cat, bytes) else str(raw_cat)
            elif isinstance(categories, (list, tuple)) and len(categories) > 0:
                cat_str = str(categories[0])
            else:
                cat_str = str(categories)
            # Take first category if comma-separated (e.g. "Revenue,Business")
            cat_str = cat_str.split(",")[0].strip()
            if cat_str:
                flight_type = cat_str
        except Exception:
            pass

    # Fallback 1: text after the airport pair — "(SDM - SNA) - Positioning flight"
    if not flight_type:
        type_m = re.search(r"\([A-Z]{3,4}\s*[-–]\s*[A-Z]{3,4}\)\s*[-–]\s*(.+)$", summary)
        if type_m:
            raw = type_m.group(1).strip()
            flight_type = re.sub(r"\s+flights?\s*$", "", raw, flags=re.IGNORECASE).strip() or None

    # Fallback 2: text before the bracket — "Revenue - [N123] ..." or "Revenue [N123] ..."
    if not flight_type:
        pre_m = re.match(r"^([A-Za-z][A-Za-z /]+?)\s*[-–]?\s*\[", summary)
        if pre_m:
            raw = pre_m.group(1).strip().rstrip("-–").strip()
            flight_type = re.sub(r"\s+flights?\s*$", "", raw, flags=re.IGNORECASE).strip() or None

    # Fallback 3: check SUMMARY + DESCRIPTION for common flight type keywords
    if not flight_type:
        combined = f"{summary} {description}"
        for keyword in ("Revenue", "Owner", "Positioning", "Maintenance", "Training", "Ferry", "Cargo",
                        "Needs pos", "Crew conflict", "Time off", "Assignment", "Transient"):
            if re.search(rf"\b{re.escape(keyword)}\b", combined, re.IGNORECASE):
                flight_type = keyword
                break

    return dep_icao, arr_icao, tail, flight_type


# ─── Health ───────────────────────────────────────────────────────────────────


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "ops-monitor", "ts": _utc_now()}


# ─── GET /api/vans  (Samsara live vehicle locations) ──────────────────────────

@app.get("/api/vans")
def get_vans():
    if not SAMSARA_API_KEY:
        raise HTTPException(status_code=503, detail="SAMSARA_API_KEY not configured")

    headers = {"Authorization": f"Bearer {SAMSARA_API_KEY}"}

    # Primary: GPS stats (always works)
    try:
        r = requests.get(
            "https://api.samsara.com/fleet/vehicles/stats",
            headers=headers,
            params={"types": "gps"},
            timeout=10,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"Samsara API error (stats): {e}", flush=True)
        raise HTTPException(status_code=502, detail="Samsara API error")

    # Supplementary: vehicle locations for reliable reverse-geocoded addresses
    addr_by_id: Dict[str, str] = {}
    try:
        r2 = requests.get(
            "https://api.samsara.com/fleet/vehicles/locations",
            headers=headers,
            timeout=10,
        )
        r2.raise_for_status()
        for v2 in r2.json().get("data") or []:
            loc = v2.get("location") or {}
            addr = (loc.get("reverseGeo") or {}).get("formattedLocation")
            if addr and v2.get("id"):
                addr_by_id[v2["id"]] = addr
    except Exception as e:
        print(f"Samsara locations supplement failed (non-fatal): {e}", flush=True)

    raw = r.json().get("data") or []
    vans: List[Dict[str, Any]] = []
    for v in raw:
        gps = v.get("gps") or {}
        vid = v.get("id")
        # Prefer address from locations endpoint; fall back to stats reverseGeo
        address = addr_by_id.get(vid) or (gps.get("reverseGeo") or {}).get("formattedLocation")
        vans.append({
            "id": vid,
            "name": v.get("name"),
            "lat": gps.get("latitude"),
            "lon": gps.get("longitude"),
            "speed_mph": gps.get("speedMilesPerHour"),
            "heading": gps.get("headingDegrees"),
            "address": address,
            "gps_time": gps.get("time"),
        })

    return {"ok": True, "vans": vans, "count": len(vans)}


# ─── GET /api/vans/diagnostics  (Samsara odometer + check engine light) ───────


@app.get("/api/vans/diagnostics")
def get_vans_diagnostics():
    if not SAMSARA_API_KEY:
        raise HTTPException(status_code=503, detail="SAMSARA_API_KEY not configured")

    try:
        r = requests.get(
            "https://api.samsara.com/fleet/vehicles/stats",
            headers={"Authorization": f"Bearer {SAMSARA_API_KEY}"},
            params={"types": "obdOdometerMeters,faultCodes"},
            timeout=10,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        print(f"Samsara API error (diagnostics): {e}", flush=True)
        raise HTTPException(status_code=502, detail="Samsara API error")

    raw = r.json().get("data") or []
    vehicles: List[Dict[str, Any]] = []
    for v in raw:
        odo = v.get("obdOdometerMeters") or {}
        fc  = v.get("faultCodes") or {}

        odo_meters = odo.get("value")

        # faultCodes.value structure varies by gateway — handle both dict and list
        fc_val = fc.get("value") or {}
        if isinstance(fc_val, dict):
            active = fc_val.get("activeCodes") or fc_val.get("activeDtcIds") or []
        elif isinstance(fc_val, list):
            active = fc_val
        else:
            active = []

        vehicles.append({
            "id":              v.get("id"),
            "name":            v.get("name"),
            "odometer_miles":  round(odo_meters / 1609.344) if odo_meters is not None else None,
            "check_engine_on": bool(active),
            "fault_codes":     active,
            "diag_time":       odo.get("time") or fc.get("time"),
        })

    return {"ok": True, "vehicles": vehicles, "count": len(vehicles)}


# ─── GET /api/flights  (called by dashboard) ──────────────────────────────────


@app.get("/api/flights")
def get_flights(
    lookahead_hours: int = Query(720, ge=1, le=744),
    include_alerts: bool = Query(True),
):
    """
    Return upcoming flights and their ops alerts for the dashboard.
    """
    try:
        supa = sb()
    except Exception as e:
        print(f"get_flights: Supabase connection failed: {repr(e)}", flush=True)
        return {"ok": False, "flights": [], "count": 0, "error": f"Supabase connection failed: {e}"}

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    # Look back 12 hours so flights that departed earlier today (but haven't
    # landed yet) still appear in the arrivals schedule.
    lookback = now - timedelta(hours=12)
    try:
        res = (
            supa.table(FLIGHTS_TABLE)
            .select("*")
            .gte("scheduled_departure", lookback.isoformat())
            .lte("scheduled_departure", cutoff.isoformat())
            .order("scheduled_departure", desc=False)
            .limit(10000)
            .execute()
        )
        flights = res.data or []
    except Exception as e:
        print(f"get_flights: flights query failed: {repr(e)}", flush=True)
        return {"ok": False, "flights": [], "count": 0, "error": f"flights query failed: {e}"}

    if include_alerts and flights:
        flight_ids = [f["id"] for f in flights]
        alerts_by_flight: Dict[str, List] = {}
        try:
            # Fetch alerts in parallel batches of 200 to keep URL lengths
            # reasonable while minimising round-trips for large windows.
            BATCH = 200
            batches = [flight_ids[i : i + BATCH] for i in range(0, len(flight_ids), BATCH)]

            def _fetch_alert_batch(batch_ids: List[str]) -> List:
                client = sb()
                return (
                    client.table(OPS_ALERTS_TABLE)
                    .select("id,flight_id,alert_type,severity,airport_icao,departure_icao,arrival_icao,tail_number,subject,body,edct_time,original_departure_time,acknowledged_at,created_at,raw_data")
                    .in_("flight_id", batch_ids)
                    .is_("acknowledged_at", "null")
                    .order("created_at", desc=False)
                    .execute()
                ).data or []

            all_alerts: List = []
            if len(batches) <= 1:
                # Single batch — no thread overhead
                for b in batches:
                    all_alerts.extend(_fetch_alert_batch(b))
            else:
                pool = ThreadPoolExecutor(max_workers=min(len(batches), 8))
                futures = {pool.submit(_fetch_alert_batch, b): b for b in batches}
                try:
                    for future in as_completed(futures, timeout=30):
                        all_alerts.extend(future.result())
                except FuturesTimeoutError:
                    print("get_flights: alert batch 30s budget exceeded", flush=True)
                finally:
                    pool.shutdown(wait=False)

            for a in all_alerts:
                # Filter out legacy noise RWY NOTAMs already in the DB
                if a.get("alert_type") == "NOTAM_RUNWAY" and a.get("body"):
                    if _is_noise_notam(a["body"].upper()):
                        continue
                # Extract NOTAM effective dates from raw_data, then drop
                # the heavy blob to keep the response small.
                rd = a.pop("raw_data", None)
                if rd and a.get("alert_type", "").startswith("NOTAM"):
                    a["notam_dates"] = _extract_notam_dates(rd)
                fid = a.get("flight_id")
                if fid:
                    alerts_by_flight.setdefault(fid, []).append(a)
        except Exception as e:
            print(f"get_flights: ops_alerts query failed: {repr(e)}", flush=True)

        for f in flights:
            f["alerts"] = alerts_by_flight.get(f["id"], [])
    else:
        for f in flights:
            f["alerts"] = []

    return {"ok": True, "flights": flights, "count": len(flights)}


@app.post("/api/ops-alerts/{alert_id}/acknowledge")
def acknowledge_alert(alert_id: str):
    supa = sb()
    supa.table(OPS_ALERTS_TABLE).update(
        {"acknowledged_at": _utc_now()}
    ).eq("id", alert_id).execute()
    return {"ok": True}


@app.get("/api/notams")
def get_notams(airports: str = Query(..., description="Comma-separated ICAO codes")):
    """
    Return active NOTAM alerts from ops_alerts for the given airports.
    These are NOTAMs already fetched by check_notams (FAA NOTAM API).
    """
    icaos = [a.strip().upper() for a in airports.split(",") if a.strip()]
    if not icaos:
        return {"ok": True, "notams": []}
    supa = sb()
    res = (
        supa.table(OPS_ALERTS_TABLE)
        .select("*")
        .in_("airport_icao", icaos)
        .like("alert_type", "NOTAM%")
        .is_("acknowledged_at", "null")
        .order("created_at", desc=True)
        .limit(100)
        .execute()
    )
    return {"ok": True, "notams": res.data or [], "airports": icaos}


# ─── Job: sync_schedule ───────────────────────────────────────────────────────


def _fetch_ics_events(url: str, cutoff_past: datetime = None) -> list:
    """Fetch one ICS feed and return its VEVENT components.
    If cutoff_past is given, skip events that ended before that time."""
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    cal = Calendar.from_ical(r.content)
    events = [c for c in cal.walk() if c.name == "VEVENT"]
    if cutoff_past is None:
        return events
    # Pre-filter: skip events that ended before cutoff_past
    filtered = []
    for c in events:
        end = c.get("DTEND")
        start = c.get("DTSTART")
        dt = _to_aware((end or start).dt) if (end or start) else None
        if dt is None or dt >= cutoff_past:
            filtered.append(c)
    return filtered


@app.post("/jobs/sync_schedule")
def sync_schedule(lookahead_hours: int = Query(720, ge=1, le=720)):
    """
    Fetch all per-aircraft JetInsight ICS feeds in parallel and upsert
    upcoming flights into Supabase.
    """
    import time as _time
    t0 = _time.monotonic()

    # Load ICS URLs from database (with env var fallback)
    ics_urls = _load_ics_urls()
    if not ics_urls:
        raise HTTPException(400, "No ICS sources configured (check admin settings or JETINSIGHT_ICS_URLS env)")

    supa = sb()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    print(f"sync_schedule: starting, {len(ics_urls)} feeds, lookahead={lookahead_hours}h", flush=True)

    # Fetch all feeds in parallel, pre-filtering to only future events
    all_components: list = []
    feed_results: dict = {}
    pool = ThreadPoolExecutor(max_workers=min(len(ics_urls), 8))
    future_to_url = {pool.submit(_fetch_ics_events, url, now): url for url in ics_urls}
    try:
        for future in as_completed(future_to_url, timeout=60):
            url = future_to_url[future]
            try:
                events = future.result()
                all_components.extend(events)
                feed_results[url[-12:]] = len(events)
                _update_ics_sync_status(supa, url, True)
            except Exception as e:
                feed_results[url[-12:]] = f"ERR:{repr(e)[:60]}"
                print(f"ICS fetch error {url[:80]}: {repr(e)}", flush=True)
                _update_ics_sync_status(supa, url, False)
    except FuturesTimeoutError:
        print("ICS fetch 60s budget exceeded; some feeds may be missing", flush=True)
    finally:
        pool.shutdown(wait=False)

    t_fetch = _time.monotonic() - t0
    print(f"sync_schedule: fetch phase done in {t_fetch:.1f}s, {len(all_components)} future events from {len(feed_results)}/{len(ics_urls)} feeds", flush=True)

    upserted = skipped = errors = 0

    # Build batch of flights to upsert
    batch: List[Dict[str, Any]] = []
    for component in all_components:
        try:
            uid = str(component.get("UID", "")).strip()
            summary = str(component.get("SUMMARY", "")).strip()
            if not uid:
                skipped += 1
                continue

            dep_dt = _to_aware(component.get("DTSTART", {}).dt if component.get("DTSTART") else None)
            arr_dt = _to_aware(component.get("DTEND", {}).dt if component.get("DTEND") else None)

            if dep_dt is None:
                skipped += 1
                continue

            if dep_dt > cutoff:
                skipped += 1
                continue

            dep_icao, arr_icao, tail, flight_type = _parse_flight_fields(component)

            # Debug: log first 5 events and any with null flight_type despite
            # having a summary that should parse (helps diagnose extraction bugs)
            _event_count = upserted + skipped + errors
            if _event_count < 5 or (flight_type is None and _event_count < 50):
                raw_cat = component.get("CATEGORIES")
                print(f"sync_schedule DEBUG event #{_event_count}: summary={summary!r}, categories={raw_cat!r}, flight_type={flight_type!r}", flush=True)

            # ── Filter out non-flight scheduling entries ──────────────────
            # 1. Same departure/arrival = not an aircraft movement
            if dep_icao and arr_icao and dep_icao == arr_icao:
                skipped += 1
                continue
            # 2. Administrative flight types (home-base notes, repo requests)
            if flight_type in _SKIP_FLIGHT_TYPES:
                skipped += 1
                continue
            # 3. SUMMARY contains explicit non-flight keywords
            if any(kw in summary.upper() for kw in _SKIP_SUMMARY_KEYWORDS):
                skipped += 1
                continue

            flight: Dict[str, Any] = {
                "ics_uid": uid,
                "scheduled_departure": dep_dt.isoformat(),
                "summary": summary,
                "updated_at": _utc_now(),
                # Always include all columns so batch upserts don't
                # nullify existing values on rows with missing keys.
                "tail_number": tail,
                "departure_icao": dep_icao,
                "arrival_icao": arr_icao,
                "scheduled_arrival": arr_dt.isoformat() if arr_dt else None,
                "flight_type": flight_type,
            }

            batch.append(flight)
        except Exception as e:
            errors += 1
            print(f"sync_schedule parse error uid={component.get('UID','?')}: {repr(e)}", flush=True)

    # Deduplicate by ics_uid — same UID can appear in multiple feeds.
    # Keep the last occurrence (typically the most recently updated).
    seen_uids: Dict[str, int] = {}
    for idx, flight in enumerate(batch):
        seen_uids[flight["ics_uid"]] = idx
    batch = [batch[i] for i in sorted(seen_uids.values())]

    # Second dedup: same physical flight can appear across per-aircraft feeds
    # with DIFFERENT UIDs.  Dedup by (tail, dep_icao, arr_icao, dep_time).
    # Keep the first occurrence; the duplicate gets its ics_uid recorded for
    # later cleanup from the DB.
    pre_dedup = len(batch)
    flight_sigs: Dict[str, int] = {}
    dup_uids: List[str] = []
    for idx, flight in enumerate(batch):
        tail = flight.get("tail_number", "")
        dep = flight.get("departure_icao", "")
        arr = flight.get("arrival_icao", "")
        dep_t = flight.get("scheduled_departure", "")
        if tail and dep and arr and dep_t:
            sig = f"{tail}|{dep}|{arr}|{dep_t}"
            if sig in flight_sigs:
                dup_uids.append(flight["ics_uid"])
                continue
            flight_sigs[sig] = idx
        else:
            flight_sigs[flight["ics_uid"]] = idx  # can't dedup, keep it
    batch = [batch[i] for i in sorted(flight_sigs.values())]
    if pre_dedup != len(batch):
        print(f"sync_schedule: cross-feed dedup removed {pre_dedup - len(batch)} duplicate flights", flush=True)

    t_parse = _time.monotonic() - t0
    print(f"sync_schedule: parsed {len(batch)} flights to upsert, {skipped} skipped in {t_parse:.1f}s", flush=True)

    # Bulk upsert in chunks of 50, with row-level fallback on failure
    CHUNK = 50
    for i in range(0, len(batch), CHUNK):
        chunk = batch[i:i + CHUNK]
        try:
            supa.table(FLIGHTS_TABLE).upsert(chunk, on_conflict="ics_uid").execute()
            upserted += len(chunk)
        except Exception as e:
            print(f"sync_schedule bulk upsert error chunk {i}: {repr(e)}", flush=True)
            # Fallback: upsert row-by-row to salvage good rows
            for row in chunk:
                try:
                    supa.table(FLIGHTS_TABLE).upsert(row, on_conflict="ics_uid").execute()
                    upserted += 1
                except Exception as row_err:
                    errors += 1
                    print(f"sync_schedule row upsert error uid={row.get('ics_uid','?')}: {repr(row_err)}", flush=True)

    # ── Clean cross-feed dups from DB ────────────────────────────────────
    if dup_uids:
        try:
            for i in range(0, len(dup_uids), 50):
                chunk_uids = dup_uids[i:i + 50]
                supa.table(FLIGHTS_TABLE).delete().in_("ics_uid", chunk_uids).execute()
            print(f"sync_schedule: deleted {len(dup_uids)} cross-feed dup rows from DB", flush=True)
        except Exception as e:
            print(f"sync_schedule: cross-feed dup cleanup error: {repr(e)}", flush=True)

    # ── Cleanup: remove non-flight entries already in the DB ─────────────
    cleaned = 0
    try:
        # 0. Purge stale flights: delete DB rows whose ics_uid is no longer in
        #    the fresh ICS data.  This handles legs that JetInsight removed or
        #    replaced (new UID).  Scoped to flights departing between now and
        #    the lookahead cutoff so we don't touch historical rows.
        fresh_uids = {f["ics_uid"] for f in batch}
        if fresh_uids:
            # Fetch all ics_uids currently in the DB within the sync window
            window_start = now.isoformat()
            window_end = cutoff.isoformat()
            db_rows = (
                supa.table(FLIGHTS_TABLE)
                .select("id, ics_uid")
                .gte("scheduled_departure", window_start)
                .lte("scheduled_departure", window_end)
                .limit(10000)
                .execute()
            )
            stale_ids = [
                r["id"] for r in (db_rows.data or [])
                if r.get("ics_uid") and r["ics_uid"] not in fresh_uids
            ]
            for i in range(0, len(stale_ids), 50):
                chunk_ids = stale_ids[i:i + 50]
                supa.table(FLIGHTS_TABLE).delete().in_("id", chunk_ids).execute()
                cleaned += len(chunk_ids)
            if stale_ids:
                print(f"sync_schedule: purged {len(stale_ids)} stale flights from DB", flush=True)
        # 0b. Delete cross-feed duplicates already in the DB — same
        #     (tail, dep, arr, dep_time) but different ics_uid.
        if dup_uids:
            for i in range(0, len(dup_uids), 50):
                chunk = dup_uids[i:i + 50]
                supa.table(FLIGHTS_TABLE).delete().in_("ics_uid", chunk).execute()
                cleaned += len(chunk)
            print(f"sync_schedule: removed {len(dup_uids)} cross-feed dup flights from DB", flush=True)
        # Also scan for existing cross-feed dups (from before this fix)
        dup_scan = (
            supa.table(FLIGHTS_TABLE)
            .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure")
            .gte("scheduled_departure", now.isoformat())
            .lte("scheduled_departure", cutoff.isoformat())
            .limit(10000)
            .execute()
        )
        sig_first: Dict[str, str] = {}  # sig → first id
        dup_db_ids: List[str] = []
        for r in (dup_scan.data or []):
            t = r.get("tail_number") or ""
            d = r.get("departure_icao") or ""
            a = r.get("arrival_icao") or ""
            dt = r.get("scheduled_departure") or ""
            if t and d and a and dt:
                sig = f"{t}|{d}|{a}|{dt}"
                if sig in sig_first:
                    dup_db_ids.append(r["id"])
                else:
                    sig_first[sig] = r["id"]
        for i in range(0, len(dup_db_ids), 50):
            chunk_ids = dup_db_ids[i:i + 50]
            supa.table(FLIGHTS_TABLE).delete().in_("id", chunk_ids).execute()
            cleaned += len(chunk_ids)
        if dup_db_ids:
            print(f"sync_schedule: cleaned {len(dup_db_ids)} existing cross-feed dups from DB", flush=True)
        # 1. Delete by known non-flight types
        for skip_type in _SKIP_FLIGHT_TYPES:
            res = supa.table(FLIGHTS_TABLE).delete().eq("flight_type", skip_type).execute()
            cleaned += len(res.data or [])
        # 2. Delete same-departure/arrival rows (Supabase client can't compare
        #    two columns, so fetch then delete by ID)
        dup_res = supa.table(FLIGHTS_TABLE).select("id, departure_icao, arrival_icao").limit(10000).execute()
        dup_ids = [
            r["id"] for r in (dup_res.data or [])
            if r.get("departure_icao") and r.get("arrival_icao")
            and r["departure_icao"] == r["arrival_icao"]
        ]
        for i in range(0, len(dup_ids), 50):
            chunk_ids = dup_ids[i:i + 50]
            supa.table(FLIGHTS_TABLE).delete().in_("id", chunk_ids).execute()
            cleaned += len(chunk_ids)
        # 3. Delete rows whose summary contains non-flight keywords
        for kw in _SKIP_SUMMARY_KEYWORDS:
            kw_res = supa.table(FLIGHTS_TABLE).select("id, summary").ilike("summary", f"%{kw}%").execute()
            kw_ids = [r["id"] for r in (kw_res.data or [])]
            for i in range(0, len(kw_ids), 50):
                chunk_ids = kw_ids[i:i + 50]
                supa.table(FLIGHTS_TABLE).delete().in_("id", chunk_ids).execute()
                cleaned += len(chunk_ids)
    except Exception as e:
        print(f"sync_schedule cleanup error: {repr(e)}", flush=True)

    t_total = _time.monotonic() - t0
    print(f"sync_schedule: done in {t_total:.1f}s — upserted={upserted} skipped={skipped} errors={errors} cleaned={cleaned}", flush=True)
    log_pipeline_run("flight-sync", items=upserted, duration_ms=int(t_total * 1000), message=f"upserted={upserted} skipped={skipped}")
    return {"ok": True, "upserted": upserted, "skipped": skipped, "errors": errors, "cleaned": cleaned, "fetch_secs": round(t_fetch, 1), "total_secs": round(t_total, 1)}


# ─── Job: pull_edct ───────────────────────────────────────────────────────────


@app.post("/jobs/pull_edct")
def pull_edct(
    lookback_minutes: int = Query(60, ge=1, le=1440),
    max_messages: int = Query(50, ge=1, le=200),
):
    """
    Pull EDCT / ground delay emails from the ForeFlight mailbox and store alerts.
    """
    token = _get_graph_token()
    supa = sb()

    since = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
    since_iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")

    url = f"https://graph.microsoft.com/v1.0/users/{FOREFLIGHT_MAILBOX}/mailFolders/Inbox/messages"
    payload = _graph_get(url, token, params={
        "$top": str(max_messages),
        "$orderby": "receivedDateTime desc",
        "$filter": f"receivedDateTime ge {since_iso}",
        "$select": "id,subject,receivedDateTime,body",
    })

    ingested = skipped = errors = 0

    for msg in payload.get("value", []):
        subject = msg.get("subject", "") or ""
        msg_id = msg["id"]

        # Only process EDCT / ground stop / ground delay emails
        if not re.search(
            r"EDCT|Expected Departure Clearance|Ground (Stop|Delay|Hold)|CTOP|GDP|AFP",
            subject, re.I
        ):
            skipped += 1
            continue

        body_html = (msg.get("body") or {}).get("content", "")
        # Strip HTML tags
        body_text = re.sub(r"<[^>]+>", " ", body_html)
        body_text = re.sub(r"[ \t]+", " ", body_text).strip()

        try:
            alert = _parse_edct_email(subject, body_text, msg_id)
            alert["flight_id"] = _find_flight_for_alert(supa, alert)

            res = (
                supa.table(OPS_ALERTS_TABLE)
                .upsert(alert, on_conflict="source_message_id", ignore_duplicates=True)
                .execute()
            )
            if res.data:
                ingested += 1
            else:
                skipped += 1
        except Exception as e:
            errors += 1
            print(f"pull_edct error msg_id={msg_id}: {repr(e)}", flush=True)

    log_pipeline_run("edct-pull", items=ingested, message=f"ingested={ingested} skipped={skipped}")
    return {"ok": True, "ingested": ingested, "skipped": skipped, "errors": errors}


_TZ_OFFSETS = {
    "EST": "-0500", "EDT": "-0400", "CST": "-0600", "CDT": "-0500",
    "MST": "-0700", "MDT": "-0600", "PST": "-0800", "PDT": "-0700",
    "UTC": "+0000", "Z": "+0000", "GMT": "+0000",
}


def _normalize_edct_time(raw: str) -> str:
    """
    Normalize various EDCT time formats to ISO-8601 UTC string.
    Handles: "1845Z", "02/26/2026 1845Z", "2026-02-26T18:45",
             "Sun Mar 01 07:34 EST 2026" (ForeFlight format).
    Returns the original string if parsing fails.
    """
    # ForeFlight: "Sun Mar 01 07:34 EST 2026"
    m = re.match(
        r"[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s+([A-Z]{2,4})\s+(\d{4})",
        raw,
    )
    if m:
        mon, day, hour, minute, tz_name, year = m.groups()
        try:
            from datetime import datetime as _dt
            dt = _dt.strptime(f"{mon} {day} {year} {hour}:{minute}", "%b %d %Y %H:%M")
            tz_off = _TZ_OFFSETS.get(tz_name.upper())
            if tz_off:
                # Convert to UTC
                sign = 1 if tz_off[0] == "+" else -1
                off_h, off_m = int(tz_off[1:3]), int(tz_off[3:5])
                dt = dt - timedelta(hours=sign * off_h, minutes=sign * off_m)
            return dt.strftime("%Y-%m-%dT%H:%MZ")
        except Exception:
            return raw

    # Already in a usable format
    return raw


def _parse_edct_email(subject: str, body: str, msg_id: str) -> Dict[str, Any]:
    """
    Parse a ForeFlight EDCT / ground delay email.
    Extracts: airports, tail, EDCT time, original departure time.
    """
    combined = f"{subject} {body}"

    # Airport pair: "KVNY to CYYZ", "KVNY→CYYZ", "KVNY-CYYZ"
    dep_icao = arr_icao = None
    route_m = re.search(r"\b([A-Z]{3,4})\s*(?:to|→|-|/)\s*([A-Z]{3,4})\b", combined, re.I)
    if route_m:
        dep_icao = route_m.group(1).upper()
        arr_icao = route_m.group(2).upper()

    # Tail number
    tail = None
    tail_m = re.search(r"\b(N\d{1,5}[A-Z]{0,2})\b", combined)
    if tail_m:
        tail = tail_m.group(1).upper()

    # EDCT time  e.g. "EDCT: 1845Z" or "EDCT 02/26/2026 1845Z"
    #            or ForeFlight: "EDCT: Sun Mar 01 07:34 EST 2026"
    edct_time = None
    edct_m = re.search(
        r"EDCT\s*[:\-]?\s*("
        r"\d{2}/\d{2}/\d{4}\s+\d{4}Z"          # 02/26/2026 1845Z
        r"|\d{4}Z"                               # 1845Z
        r"|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}"   # 2026-02-26T18:45
        r"|[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}\s+[A-Z]{2,4}\s+\d{4}"  # Sun Mar 01 07:34 EST 2026
        r")",
        body, re.I,
    )
    if edct_m:
        raw_edct = edct_m.group(1).strip()
        edct_time = _normalize_edct_time(raw_edct)

    # Original / proposed departure
    orig_dep = None
    orig_m = re.search(
        r"(?:Original|Proposed|Filed|Scheduled)\s+(?:Departure|Dep)\s*[:\-]?\s*("
        r"\d{2}/\d{2}/\d{4}\s+\d{4}Z"
        r"|\d{4}Z"
        r"|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}"
        r"|[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}\s+[A-Z]{2,4}\s+\d{4}"
        r")",
        body, re.I,
    )
    if orig_m:
        orig_dep = _normalize_edct_time(orig_m.group(1).strip())

    # Severity: ground stop = critical, otherwise warning
    severity = "critical" if re.search(r"Ground Stop|STOP", subject, re.I) else "warning"

    return {
        "alert_type": "EDCT",
        "severity": severity,
        "departure_icao": dep_icao,
        "arrival_icao": arr_icao,
        "tail_number": tail,
        "subject": subject[:500],
        "body": body[:2000],
        "edct_time": edct_time,
        "original_departure_time": orig_dep,
        "source_message_id": msg_id,
        "raw_data": json.dumps({"subject": subject, "edct_time": edct_time}),
        "created_at": _utc_now(),
    }


def _find_flight_for_alert(supa, alert: Dict) -> Optional[str]:
    """Match an alert to a flight by airport pair within a ±12h window."""
    dep = alert.get("departure_icao")
    arr = alert.get("arrival_icao")
    if not dep or not arr:
        return None

    now = datetime.now(timezone.utc)
    res = (
        supa.table(FLIGHTS_TABLE)
        .select("id")
        .eq("departure_icao", dep)
        .eq("arrival_icao", arr)
        .gte("scheduled_departure", (now - timedelta(hours=2)).isoformat())
        .lte("scheduled_departure", (now + timedelta(hours=12)).isoformat())
        .limit(1)
        .execute()
    )
    rows = res.data or []
    return rows[0]["id"] if rows else None


# ─── Job: check_notams ────────────────────────────────────────────────────────


def _run_check_notams(lookahead_hours: int) -> dict:
    """Run NOTAM checks for all upcoming flights. Returns stats dict."""
    supa = sb()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    flights_res = (
        supa.table(FLIGHTS_TABLE)
        .select("*")
        .gte("scheduled_departure", now.isoformat())
        .lte("scheduled_departure", cutoff.isoformat())
        .limit(10000)
        .execute()
    )
    flights = flights_res.data or []
    if not flights:
        print("check_notams: no upcoming flights, nothing to check", flush=True)
        return {"flights_checked": 0, "airports_checked": 0, "alerts_created": 0}

    # Collect unique airports
    airports: set = set()
    for f in flights:
        if f.get("departure_icao"):
            airports.add(f["departure_icao"])
        if f.get("arrival_icao"):
            airports.add(f["arrival_icao"])

    # Fetch all airports in parallel — one request per ICAO (FAA API limitation).
    # Pre-fetch the token once so all workers share it rather than racing.
    token = _get_nms_token()
    # 60s wall-clock budget for all parallel NOTAM fetches.
    # IMPORTANT: do NOT use `with ThreadPoolExecutor() as pool` here — the context
    # manager calls shutdown(wait=True) on exit, which blocks indefinitely on any
    # stuck socket thread even after as_completed(timeout=60) raises. We call
    # shutdown(wait=False) ourselves so hung threads are abandoned, not awaited.
    notams_by_airport: Dict[str, List] = {}
    pool = ThreadPoolExecutor(max_workers=min(len(airports), 20))
    future_to_icao = {pool.submit(_fetch_notams, icao, token): icao for icao in airports}
    try:
        for future in as_completed(future_to_icao, timeout=60):
            icao = future_to_icao[future]
            try:
                notams_by_airport[icao] = future.result()
            except Exception as e:
                print(f"NOTAM fetch error {icao}: {repr(e)}", flush=True)
                notams_by_airport[icao] = []
    except FuturesTimeoutError:
        remaining = [icao for f, icao in future_to_icao.items() if icao not in notams_by_airport]
        print(f"NOTAM fetch 60s budget exceeded; skipped airports: {remaining}", flush=True)
        for icao in remaining:
            notams_by_airport.setdefault(icao, [])
    finally:
        pool.shutdown(wait=False)  # abandon any still-running socket threads

    alerts_to_insert = []
    for flight in flights:
        fid = flight["id"]
        for icao in [flight.get("departure_icao"), flight.get("arrival_icao")]:
            if not icao:
                continue
            for feature in notams_by_airport.get(icao, []):
                # NMS GeoJSON: feature.properties.coreNOTAMData.notam
                core_data = (
                    feature.get("properties", {})
                    .get("coreNOTAMData", {})
                )
                notam_data = core_data.get("notam", {})
                if not notam_data:
                    continue
                # NMS uses "text", legacy API uses "traditionalMessage"
                msg = notam_data.get("text") or notam_data.get("traditionalMessage") or ""
                if not _is_relevant_notam_msg(msg):
                    continue
                notam_id = notam_data.get("id", "") or notam_data.get("number", "")
                # Extract dates from notam_data AND coreNOTAMData (dates may
                # live at either level depending on the FAA API version).
                notam_dates = _pick_dates(notam_data, core_data)
                alerts_to_insert.append({
                    "flight_id": fid,
                    "alert_type": _classify_notam(msg),
                    "severity": _notam_severity(msg),
                    "airport_icao": notam_data.get("icaoLocation") or icao,
                    "subject": notam_data.get("number", "")[:500],
                    "body": msg[:2000],
                    "source_message_id": f"nms-{notam_id}-{fid}",
                    "raw_data": {"notam_dates": notam_dates} if notam_dates else None,
                    "created_at": _utc_now(),
                })

    alerts_created = 0
    if alerts_to_insert:
        print(f"check_notams: upserting {len(alerts_to_insert)} alerts in bulk", flush=True)
        try:
            # Supabase upsert accepts a list — one round-trip for all rows.
            # Do NOT use ignore_duplicates — we need to UPDATE raw_data on
            # existing rows so NOTAM dates are backfilled if they were
            # previously stored as null.
            res = (
                supa.table(OPS_ALERTS_TABLE)
                .upsert(alerts_to_insert, on_conflict="source_message_id")
                .execute()
            )
            alerts_created = len(res.data) if res.data else 0
        except Exception as e:
            print(f"NOTAM bulk upsert error: {repr(e)}", flush=True)

    print(
        f"check_notams complete: flights={len(flights)} airports={len(airports)} alerts_created={alerts_created}",
        flush=True,
    )
    return {"flights_checked": len(flights), "airports_checked": len(airports), "alerts_created": alerts_created}


@app.post("/jobs/check_notams")
def check_notams(lookahead_hours: int = Query(720, ge=1, le=720)):
    """
    For each upcoming flight, query the FAA NOTAM API for departure and arrival
    airports and store relevant NOTAMs as ops_alerts.
    """
    if not FAA_CLIENT_ID or not FAA_CLIENT_SECRET:
        raise HTTPException(400, "FAA_CLIENT_ID / FAA_CLIENT_SECRET not configured for NMS API")

    # Hard 90s wall-clock limit so Cloud Run's 300s request timeout is never hit.
    # _run_check_notams has its own internal 60s cap on FAA fetches; this outer
    # wrapper catches anything else that might stall (DNS hang, token fetch, etc.).
    executor = ThreadPoolExecutor(max_workers=1)
    future = executor.submit(_run_check_notams, lookahead_hours)
    executor.shutdown(wait=False)
    try:
        stats = future.result(timeout=90)
    except FuturesTimeoutError:
        print("check_notams: 90s hard deadline exceeded", flush=True)
        log_pipeline_run("notam-check", status="error", message="90s timeout")
        return {"ok": True, "timeout": True, "alerts_created": 0}
    except Exception as e:
        print(f"check_notams exception: {repr(e)}", flush=True)
        log_pipeline_run("notam-check", status="error", message=str(e)[:200])
        raise HTTPException(500, detail="check_notams failed")
    log_pipeline_run("notam-check", items=stats.get("alerts_created", 0), message=f"flights={stats.get('flights_checked', 0)} airports={stats.get('airports_checked', 0)}")
    return {"ok": True, **stats}


@app.post("/jobs/seed_ics_sources")
def seed_ics_sources():
    """Seed the ics_sources table from JETINSIGHT_ICS_URLS env var.
    Skips any URLs already in the table. Safe to call multiple times."""
    try:
        result = _seed_ics_sources_from_env()
        return {"ok": True, **result}
    except Exception as e:
        raise HTTPException(500, detail=f"Seed failed: {repr(e)}")


@app.get("/debug/ics_status")
def debug_ics_status():
    """Show how many ICS URLs are loaded and try fetching the first one."""
    result: Dict[str, Any] = {"urls_loaded": len(ICS_URLS)}
    if not ICS_URLS:
        result["error"] = "JETINSIGHT_ICS_URLS env var is empty or not set"
        return result
    # Show truncated URLs for debugging (hide query-string tokens)
    result["urls_preview"] = [u.split("?")[0] for u in ICS_URLS]
    # Try fetching the first feed as a smoke test
    try:
        r = requests.get(ICS_URLS[0], timeout=15)
        result["first_feed_status"] = r.status_code
        result["first_feed_bytes"] = len(r.content)
        if r.status_code == 200:
            cal = Calendar.from_ical(r.content)
            events = [c for c in cal.walk() if c.name == "VEVENT"]
            result["first_feed_events"] = len(events)
    except Exception as e:
        result["first_feed_error"] = repr(e)
    return result


@app.get("/debug/sync_test")
def debug_sync_test():
    """Fetch first 3 ICS feeds sequentially and report timing per feed."""
    import time as _time
    results = []
    for url in ICS_URLS[:3]:
        t0 = _time.monotonic()
        try:
            r = requests.get(url, timeout=15)
            elapsed = round(_time.monotonic() - t0, 2)
            cal = Calendar.from_ical(r.content)
            events = [c for c in cal.walk() if c.name == "VEVENT"]
            results.append({
                "url_tail": url[-12:],
                "status": r.status_code,
                "bytes": len(r.content),
                "events": len(events),
                "secs": elapsed,
            })
        except Exception as e:
            elapsed = round(_time.monotonic() - t0, 2)
            results.append({"url_tail": url[-12:], "error": repr(e)[:100], "secs": elapsed})

    # Also test Supabase connectivity
    supa_ok = False
    try:
        t0 = _time.monotonic()
        supa = sb()
        supa.table(FLIGHTS_TABLE).select("ics_uid").limit(1).execute()
        supa_secs = round(_time.monotonic() - t0, 2)
        supa_ok = True
    except Exception as e:
        supa_secs = round(_time.monotonic() - t0, 2)
        supa_ok = repr(e)[:100]

    return {"feeds": results, "supabase_ok": supa_ok, "supabase_secs": supa_secs}


@app.get("/debug/ics_fields")
def debug_ics_fields(count: int = Query(5, ge=1, le=20)):
    """Dump ALL raw ICS properties from the first N VEVENTs to see what JetInsight sends."""
    if not ICS_URLS:
        return {"error": "No ICS URLs configured"}
    try:
        r = requests.get(ICS_URLS[0], timeout=15)
        r.raise_for_status()
        cal = Calendar.from_ical(r.content)
        events = [c for c in cal.walk() if c.name == "VEVENT"]
        samples = []
        for ev in events[:count]:
            props = {}
            for key in ev:
                val = ev[key]
                if hasattr(val, "dt"):
                    props[key] = str(val.dt)
                elif isinstance(val, list):
                    props[key] = [str(v) for v in val]
                else:
                    props[key] = str(val)
            samples.append(props)
        return {"total_events": len(events), "samples": samples}
    except Exception as e:
        return {"error": repr(e)}


@app.get("/debug/connectivity")
def debug_connectivity():
    """Test DNS + TCP reachability for external hosts from inside Cloud Run."""
    import socket

    hosts = [
        ("api-nms.aim.faa.gov", 443),
        ("graph.microsoft.com", 443),
        ("login.microsoftonline.com", 443),
    ]

    def _probe(host: str, port: int) -> dict:
        try:
            # getaddrinfo is not covered by socket.settimeout — run in its own thread
            addrs = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
            ip = addrs[0][4][0]
        except Exception as e:
            return {"dns": False, "tcp": False, "error": repr(e)}
        try:
            sock = socket.create_connection((ip, port), timeout=5)
            sock.close()
            return {"dns": True, "tcp": True, "ip": ip}
        except Exception as e:
            return {"dns": True, "tcp": False, "ip": ip, "error": repr(e)}

    results = {}
    pool = ThreadPoolExecutor(max_workers=len(hosts))
    futures = {host: pool.submit(_probe, host, port) for host, port in hosts}
    for host, fut in futures.items():
        try:
            results[host] = fut.result(timeout=10)
        except FuturesTimeoutError:
            results[host] = {"dns": False, "tcp": False, "error": "probe timed out after 10s (likely DNS hang)"}
    pool.shutdown(wait=False)
    return results


@app.get("/debug/notam_token")
def debug_notam_token():
    """Test FAA NMS token fetch in isolation — returns token expiry or the exact error."""
    if not FAA_CLIENT_ID or not FAA_CLIENT_SECRET:
        return {"ok": False, "error": "FAA_CLIENT_ID or FAA_CLIENT_SECRET not set"}
    try:
        # Force a fresh fetch (bypass cache) so we always hit the network
        _nms_token_cache["token"] = None
        token = _get_nms_token()
        expires_in = int(_nms_token_cache["expires_at"] - _time.time())
        return {"ok": True, "token_prefix": token[:8] + "...", "expires_in_s": expires_in}
    except Exception as e:
        return {"ok": False, "error": repr(e)}


@app.get("/debug/notam_test")
def debug_notam_test(airport: str = Query("KJFK")):
    """End-to-end NOTAM test: NMS token → fetch NOTAMs for one airport → return raw results.
    Also tries the legacy FAA API as a comparison. Use this to diagnose NOTAM failures."""
    icao = airport.upper().strip()
    result: Dict[str, Any] = {"airport": icao}

    # --- NMS API test (direct, no fallback) ---
    nms_result: Dict[str, Any] = {"ok": False}
    try:
        _nms_token_cache["token"] = None  # force fresh token
        token = _get_nms_token()
        nms_result["token_ok"] = True
        nms_result["auth_url"] = NMS_AUTH_URL
        nms_result["api_url"] = f"{NMS_API_BASE}/v1/notams"
        r = requests.get(
            f"{NMS_API_BASE}/v1/notams",
            headers={"Authorization": f"Bearer {token}", "nmsResponseFormat": "GEOJSON"},
            params={"location": icao, "classification": "DOMESTIC"},
            timeout=(5, 10),
        )
        nms_result["status_code"] = r.status_code
        nms_result["response_preview"] = r.text[:500]
        if r.ok:
            features = r.json().get("data", {}).get("geojson", [])
            nms_result["ok"] = True
            nms_result["count"] = len(features)
            nms_result["sample"] = features[:2] if features else []
            # Show what _pick_dates extracts from the first feature
            if features:
                f0 = features[0]
                core = f0.get("properties", {}).get("coreNOTAMData", {})
                notam = core.get("notam", {})
                nms_result["date_keys_in_notam"] = [k for k in notam if "date" in k.lower() or "start" in k.lower() or "end" in k.lower() or "issued" in k.lower() or "effective" in k.lower() or "status" in k.lower()]
                nms_result["date_keys_in_coreNOTAMData"] = [k for k in core if "date" in k.lower() or "start" in k.lower() or "end" in k.lower() or "issued" in k.lower() or "effective" in k.lower() or "status" in k.lower()]
                nms_result["extracted_dates"] = _pick_dates(notam, core)
    except Exception as e:
        nms_result["error"] = repr(e)
    result["nms"] = nms_result

    # --- Legacy FAA API test (external-api.faa.gov) ---
    legacy_result: Dict[str, Any] = {"ok": False}
    try:
        notams = _fetch_notams_legacy(icao)
        legacy_result["ok"] = True
        legacy_result["count"] = len(notams)
        legacy_result["sample"] = notams[:2] if notams else []
    except Exception as e:
        legacy_result["error"] = repr(e)
    result["legacy"] = legacy_result

    return result


def _fetch_notams(icao: str, token: str) -> List[Dict]:
    """Return list of GeoJSON feature dicts from the NMS API for a given ICAO.
    Accepts a pre-fetched token so all workers share one auth call.
    Falls back to the legacy FAA API if NMS fails."""
    try:
        r = requests.get(
            f"{NMS_API_BASE}/v1/notams",
            headers={
                "Authorization": f"Bearer {token}",
                "nmsResponseFormat": "GEOJSON",
            },
            params={"location": icao, "classification": "DOMESTIC"},
            timeout=(5, 10),
        )
        print(f"NMS NOTAM {icao}: status={r.status_code} body={r.text[:200]!r}", flush=True)
        if r.status_code == 429:
            print(f"NMS rate limit {icao}, skipping", flush=True)
            return []
        r.raise_for_status()
        features = r.json().get("data", {}).get("geojson", [])
        if features:
            return features
        # NMS returned empty — try legacy as fallback
        print(f"NMS returned 0 features for {icao}, trying legacy API", flush=True)
    except Exception as e:
        print(f"NMS fetch failed for {icao}: {repr(e)}, trying legacy API", flush=True)

    # Fallback: legacy FAA API (external-api.faa.gov)
    try:
        legacy = _fetch_notams_legacy(icao)
        # Wrap legacy items in a structure compatible with the NMS GeoJSON
        # parser used by _run_check_notams: feature.properties.coreNOTAMData.notam
        return [
            {
                "properties": {
                    "coreNOTAMData": item.get("coreNOTAMData", {}),
                },
            }
            for item in legacy
        ]
    except Exception as e2:
        print(f"Legacy FAA fetch also failed for {icao}: {repr(e2)}", flush=True)
        return []


def _fetch_notams_legacy(icao: str) -> List[Dict]:
    """Fetch NOTAMs from the legacy FAA API (external-api.faa.gov).
    Uses client_id/client_secret as custom request headers per FAA docs."""
    r = requests.get(
        "https://external-api.faa.gov/notamapi/v1/notams",
        headers={
            "client_id": FAA_CLIENT_ID,
            "client_secret": FAA_CLIENT_SECRET,
            "Accept": "application/json",
        },
        params={"icaoLocation": icao, "pageSize": 50, "pageNum": 1},
        timeout=(5, 10),
    )
    print(f"Legacy NOTAM {icao}: status={r.status_code} body={r.text[:200]!r}", flush=True)
    r.raise_for_status()
    return r.json().get("items", [])


def _is_relevant_notam_msg(msg: str) -> bool:
    m = msg.upper()
    # Runway closures
    if re.search(r"(RWY|RUNWAY).{0,60}(CLSD|CLOSED)", m):
        # Exclude equipment / lighting NOTAMs that mention RWY but aren't
        # actual runway closures (ILS, PAPI, ALS, LGT, TWY, APRON, windcone).
        if _is_noise_notam(m):
            return False
        return True
    if re.search(r"(CLSD|CLOSED).{0,60}(RWY|RUNWAY)", m):
        if _is_noise_notam(m):
            return False
        return True
    # Airport/aerodrome closure
    if re.search(r"(\bAD\b|AERODROME|AIRPORT).{0,30}(CLSD|CLOSED)", m):
        return True
    if re.search(r"(CLSD|CLOSED).{0,30}(\bAD\b|AERODROME|AIRPORT)", m):
        return True
    # AD restricted (aerodrome/airport restrictions)
    if re.search(r"(\bAD\b|AERODROME|AIRPORT).{0,30}(RSTD|RESTRICTED)", m):
        return True
    if re.search(r"(RSTD|RESTRICTED).{0,30}(\bAD\b|AERODROME|AIRPORT)", m):
        return True
    # TFR
    if re.search(r"\bTFR\b|TEMPORARY FLIGHT RESTRICTION", m):
        return True
    # PPR
    if re.search(r"\bPPR\b|PRIOR PERMISSION REQUIRED", m):
        return True
    return False


# Terms that indicate a RWY NOTAM is about equipment / lighting, not an
# actual runway closure.  Checked against the upper-cased message text.
_NOISE_TERMS = re.compile(
    r"\bILS\b|\bPAPI\b|\bALS\b|\bLGT\b|\bLIGHT\b|\bTWY\b|\bTAXIWAY\b"
    r"|\bAPRON\b|\bWINDCONE\b|\bWIND\s*CONE\b"
)


def _is_noise_notam(msg_upper: str) -> bool:
    """Return True if the NOTAM is about equipment/lighting rather than an
    actual runway or airport closure worth alerting on."""
    return bool(_NOISE_TERMS.search(msg_upper))


def _classify_notam(msg: str) -> str:
    m = msg.upper()
    if re.search(r"\bPPR\b|PRIOR PERMISSION REQUIRED", m):
        return "NOTAM_PPR"
    if re.search(r"\bRWY\b|RUNWAY", m):
        return "NOTAM_RUNWAY"
    if re.search(r"TFR|TEMPORARY FLIGHT", m):
        return "NOTAM_TFR"
    if re.search(r"(\bAD\b|AERODROME|AIRPORT).{0,30}(RSTD|RESTRICTED)", m):
        return "NOTAM_AD_RESTRICTED"
    if re.search(r"\bAD\b|AERODROME|AIRPORT", m):
        return "NOTAM_AERODROME"
    return "NOTAM_OTHER"


def _notam_severity(msg: str) -> str:
    m = msg.upper()
    if re.search(r"CLSD|CLOSED|STOP", m):
        return "critical"
    if re.search(r"TFR", m):
        return "critical"
    if re.search(r"(\bAD\b|AERODROME|AIRPORT).{0,30}(RSTD|RESTRICTED)", m):
        return "critical"
    return "warning"
