# ops-monitor/main.py
import json
import math
import os
import re
import time
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


def _extract_mx_note(summary: str) -> str:
    """Extract the MX note from a JetInsight maintenance SUMMARY.
    e.g. '[N553FX] #3 TIRE CHANGE (BED - BED) - Maintenance' → '#3 TIRE CHANGE'
    """
    m = re.search(r"\]\s*(.+?)\s*\(", summary)
    if m:
        note = m.group(1).strip().rstrip("-–").strip()
        if note:
            return note
    return summary

# FAA NMS API (test environment — swap to production once onboarded)
NMS_AUTH_URL = "https://api-staging.cgifederal-aim.com/v1/auth/token"
NMS_API_BASE = "https://api-staging.cgifederal-aim.com/nmsapi"

FOREFLIGHT_MAILBOX = os.getenv("FOREFLIGHT_MAILBOX", "ForeFlight@baker-aviation.com")
MS_TENANT_ID = os.getenv("MS_TENANT_ID")
MS_CLIENT_ID = os.getenv("MS_CLIENT_ID")
MS_CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")

FLIGHTS_TABLE = "flights"
OPS_ALERTS_TABLE = "ops_alerts"

# ─── Airport coordinates for TFR proximity checks ────────────────────────────
# Baker's common airports + major nearby airports. (lat, lon) in decimal degrees.
AIRPORT_COORDS: Dict[str, Tuple[float, float]] = {
    # South Florida
    "KOPF": (25.9068, -80.2784),   # Opa-locka Executive
    "KMIA": (25.7959, -80.2870),   # Miami International
    "KFLL": (26.0726, -80.1527),   # Fort Lauderdale-Hollywood
    "KFXE": (26.1973, -80.1707),   # Fort Lauderdale Executive
    "KPBI": (26.6832, -80.0956),   # Palm Beach International
    "KBCT": (26.3785, -80.1077),   # Boca Raton
    "KHWO": (26.0012, -80.2407),   # North Perry
    "KTMB": (25.6479, -80.4328),   # Kendall-Tamiami Executive
    "KPMP": (26.2471, -80.1111),   # Pompano Beach Airpark
    # NYC area
    "KJFK": (40.6413, -73.7781),   # JFK
    "KLGA": (40.7769, -73.8740),   # LaGuardia
    "KEWR": (40.6895, -74.1745),   # Newark
    "KTEB": (40.8501, -74.0608),   # Teterboro
    "KHPN": (41.0670, -73.7076),   # Westchester County
    "KFRG": (40.7288, -73.4134),   # Republic (Farmingdale)
    "KISP": (40.7952, -73.1002),   # Long Island MacArthur
    "KCDW": (40.8752, -74.2814),   # Essex County
    "KMMU": (40.7994, -74.4149),   # Morristown Municipal
    "KSWF": (41.5041, -74.1048),   # Stewart/Newburgh
    # Washington DC area
    "KIAD": (38.9474, -77.4599),   # Dulles
    "KDCA": (38.8512, -77.0402),   # Reagan National
    "KBWI": (39.1754, -76.6683),   # Baltimore-Washington
    # Texas
    "KDAL": (32.8471, -96.8518),   # Dallas Love Field
    "KDFW": (32.8998, -97.0403),   # Dallas/Fort Worth
    "KHOU": (29.6454, -95.2789),   # Houston Hobby
    "KIAH": (29.9902, -95.3368),   # Houston Intercontinental
    "KAUS": (30.1945, -97.6699),   # Austin-Bergstrom
    "KSAT": (29.5337, -98.4698),   # San Antonio
    "KADS": (32.9686, -96.8364),   # Addison
    "KFTW": (32.8198, -97.3624),   # Fort Worth Meacham
    # Other major
    "KATL": (33.6407, -84.4277),   # Atlanta
    "KORD": (41.9742, -87.9073),   # Chicago O'Hare
    "KMDW": (41.7868, -87.7522),   # Chicago Midway
    "KLAX": (33.9416, -118.4085),  # Los Angeles
    "KVNY": (34.2098, -118.4898),  # Van Nuys
    "KSFO": (37.6213, -122.3790),  # San Francisco
    "KLAS": (36.0840, -115.1537),  # Las Vegas
    "KDEN": (39.8561, -104.6737),  # Denver
    "KBOS": (42.3656, -71.0096),   # Boston
    "KPHL": (39.8744, -75.2424),   # Philadelphia
    "KCLT": (35.2140, -80.9431),   # Charlotte
    "KMSP": (44.8820, -93.2218),   # Minneapolis
    "KDTW": (42.2124, -83.3534),   # Detroit
    "KSEA": (47.4502, -122.3088),  # Seattle
    "KMCO": (28.4312, -81.3081),   # Orlando
    "KTPA": (27.9755, -82.5332),   # Tampa
    "KRSW": (26.5362, -81.7552),   # Southwest Florida (Fort Myers)
    "KAPF": (26.1526, -81.7753),   # Naples Municipal
    "KFMY": (26.5866, -81.8633),   # Page Field (Fort Myers)
    "KJAX": (30.4941, -81.6879),   # Jacksonville
    "KPDK": (33.8756, -84.3020),   # DeKalb-Peachtree (Atlanta exec)
    "KASG": (27.7717, -81.5306),   # Springhill (FL)
    "KOBE": (30.0616, -87.8733),   # Southwest Alabama Regional
    "KNEW": (30.0424, -90.0283),   # Lakefront (New Orleans)
    "KMSY": (29.9934, -90.2580),   # Louis Armstrong (New Orleans)
    "KBNA": (36.1245, -86.6782),   # Nashville
    "KCHS": (32.8986, -80.0405),   # Charleston
    "KSAV": (32.1276, -81.2021),   # Savannah
    "KPNS": (30.4734, -87.1866),   # Pensacola
    "KVPS": (30.4832, -86.5254),   # Destin-Fort Walton Beach
}


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
            data={"grant_type": "client_credentials"},
            auth=(FAA_CLIENT_ID, FAA_CLIENT_SECRET),
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
    """Normalize an icalendar dt value to a timezone-aware datetime.

    Naive datetimes (no timezone info) are assumed to be in the timezone
    specified by ICS_NAIVE_TZ env var (default: America/Chicago for Baker
    Aviation / Fort Worth).  JetInsight ICS feeds often omit the Z suffix
    and send local times.
    """
    if dt is None:
        return None
    if hasattr(dt, "hour"):  # datetime
        if dt.tzinfo is None:
            # Naive datetime — apply configured local timezone, then convert to UTC
            import zoneinfo
            tz_name = os.getenv("ICS_NAIVE_TZ", "America/Chicago")
            try:
                local_tz = zoneinfo.ZoneInfo(tz_name)
            except Exception:
                local_tz = timezone.utc
            return dt.replace(tzinfo=local_tz).astimezone(timezone.utc)
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
        # FAA LIDs starting with a digit (e.g. 3T5) don't get a K prefix
        if code[0].isdigit():
            return code
        # Canadian airports typically already come as 4-letter (CYYZ etc.)
        # US domestic: prepend K
        return "K" + code
    return code


def _parse_flight_fields(component) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str], Optional[str], Optional[int], Optional[str]]:
    """
    Extract (departure_icao, arrival_icao, tail_number, flight_type, pic, sic, pax_count, jetinsight_url) from a JetInsight VEVENT.

    JetInsight SUMMARY format:
        [N998CX] The Early Way (SDM - SNA) - Positioning flight
    LOCATION field contains the departure airport (3-letter FAA code).
    Times are always UTC (Z suffix).
    """
    summary = str(component.get("SUMMARY", ""))
    description = str(component.get("DESCRIPTION", ""))
    location = str(component.get("LOCATION", "")).strip().upper()
    jetinsight_url = str(component.get("URL", "")).strip() or None

    # ── Crew info from DESCRIPTION: "PIC: Name\nSIC: Name\nPax: N" ────────
    pic = sic = None
    pax_count = None
    for line in description.splitlines():
        line = line.strip()
        if line.upper().startswith("PIC:"):
            pic = line[4:].strip() or None
        elif line.upper().startswith("SIC:"):
            sic = line[4:].strip() or None
        elif line.upper().startswith("PAX:"):
            try:
                pax_count = int(line[4:].strip())
            except ValueError:
                pass

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
    paren_m = re.search(r"\(([A-Z0-9]{3,4})\s*[-–]\s*([A-Z0-9]{3,4})\)", summary)
    if paren_m:
        dep_icao = _faa_to_icao(paren_m.group(1))
        arr_icao = _faa_to_icao(paren_m.group(2))

    # ── Fallback: LOCATION field → departure ─────────────────────────────────
    if not dep_icao and location and re.match(r"^[A-Z0-9]{3,4}$", location):
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

    return dep_icao, arr_icao, tail, flight_type, pic, sic, pax_count, jetinsight_url


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
                    body_upper = a["body"].upper()
                    if _is_noise_notam(body_upper) or _is_ignorable_runway(body_upper):
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


_prev_etags: Dict[str, str] = {}  # url → last seen ETag

def _fetch_ics_events(url: str, cutoff_past: datetime = None) -> list:
    """Fetch one ICS feed and return its VEVENT components.
    If cutoff_past is given, skip events that ended before that time."""
    r = requests.get(url, timeout=30, headers={"Cache-Control": "no-cache"})
    r.raise_for_status()
    # Log response headers + ETag change tracking
    etag = r.headers.get("ETag", "none")
    cache_ctrl = r.headers.get("Cache-Control", "none")
    url_short = url.split("?")[0][-40:]
    prev = _prev_etags.get(url)
    changed = "NEW" if prev is None else ("CHANGED" if prev != etag else "same")
    _prev_etags[url] = etag
    print(f"[ICS] {url_short}: etag={changed} size={len(r.content)} Cache-Control={cache_ctrl}", flush=True)
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
    mx_alerts_batch: List[Dict[str, Any]] = []
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

            dep_icao, arr_icao, tail, flight_type, pic, sic, pax_count, jetinsight_url = _parse_flight_fields(component)

            # Debug: log first 5 events and any with null flight_type despite
            # having a summary that should parse (helps diagnose extraction bugs)
            _event_count = upserted + skipped + errors
            if _event_count < 5 or (flight_type is None and _event_count < 50):
                raw_cat = component.get("CATEGORIES")
                print(f"sync_schedule DEBUG event #{_event_count}: summary={summary!r}, categories={raw_cat!r}, flight_type={flight_type!r}", flush=True)

            # ── Filter out non-flight scheduling entries ──────────────────
            # 1. Same departure/arrival = not an aircraft movement
            #    BUT capture maintenance events as MX_NOTE alerts
            if dep_icao and arr_icao and dep_icao == arr_icao:
                if flight_type and flight_type.lower() == "maintenance" and tail:
                    mx_note = _extract_mx_note(summary)
                    mx_alerts_batch.append({
                        "alert_type": "MX_NOTE",
                        "severity": "info",
                        "airport_icao": dep_icao,
                        "tail_number": tail,
                        "subject": f"[{tail}] {mx_note}" if mx_note else f"[{tail}] Maintenance",
                        "body": mx_note or summary,
                        "source_message_id": f"mx-{uid}",
                        "raw_data": {
                            "start_time": dep_dt.isoformat() if dep_dt else None,
                            "end_time": arr_dt.isoformat() if arr_dt else None,
                            "ics_uid": uid,
                            "summary": summary,
                        },
                    })
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

            # Always set ALL fields so stale data gets overwritten on re-sync
            flight: Dict[str, Any] = {
                "ics_uid": uid,
                "tail_number": tail,
                "departure_icao": dep_icao,
                "arrival_icao": arr_icao,
                "scheduled_departure": dep_dt.isoformat(),
                "scheduled_arrival": arr_dt.isoformat() if arr_dt else None,
                "summary": summary,
                "flight_type": flight_type,
                "pic": pic,
                "sic": sic,
                "pax_count": pax_count,
                "jetinsight_url": jetinsight_url,
                "updated_at": _utc_now(),
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

    # ── Upsert MX_NOTE alerts from maintenance events ───────────────────
    mx_created = 0
    if mx_alerts_batch:
        print(f"sync_schedule: upserting {len(mx_alerts_batch)} MX_NOTE alerts", flush=True)
        try:
            res = supa.table(OPS_ALERTS_TABLE).upsert(
                mx_alerts_batch, on_conflict="source_message_id"
            ).execute()
            mx_created = len(res.data) if res.data else 0
        except Exception as e:
            print(f"sync_schedule MX_NOTE upsert error: {repr(e)}", flush=True)

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

    # ── Cleanup: delete future flights that no longer appear in any ICS feed ──
    # Only run cleanup if we successfully fetched at least 1 feed (avoid
    # wiping everything if all feeds failed).
    deleted = 0
    live_uids = {f["ics_uid"] for f in batch}
    successful_feeds = sum(1 for v in feed_results.values() if isinstance(v, int))
    if successful_feeds > 0 and live_uids:
        try:
            # Find future flights in DB whose ics_uid is NOT in the current feed
            existing = supa.table(FLIGHTS_TABLE) \
                .select("id, ics_uid") \
                .gte("scheduled_departure", now.isoformat()) \
                .limit(10000) \
                .execute()
            stale_ids = [
                row["id"] for row in (existing.data or [])
                if row["ics_uid"] not in live_uids
            ]
            if stale_ids:
                # Delete in chunks of 50
                for i in range(0, len(stale_ids), CHUNK):
                    chunk_ids = stale_ids[i:i + CHUNK]
                    supa.table(FLIGHTS_TABLE).delete().in_("id", chunk_ids).execute()
                    deleted += len(chunk_ids)
                print(f"sync_schedule: deleted {deleted} stale future flights no longer in ICS feeds", flush=True)
        except Exception as e:
            print(f"sync_schedule cleanup error: {repr(e)}", flush=True)

    t_total = _time.monotonic() - t0
    print(f"sync_schedule: done in {t_total:.1f}s — upserted={upserted} skipped={skipped} errors={errors} cleaned={cleaned} deleted={deleted} mx_notes={mx_created}", flush=True)
    log_pipeline_run("flight-sync", items=upserted, duration_ms=int(t_total * 1000), message=f"upserted={upserted} skipped={skipped} mx_notes={mx_created}")
    return {"ok": True, "upserted": upserted, "skipped": skipped, "errors": errors, "cleaned": cleaned, "deleted": deleted, "mx_notes": mx_created, "fetch_secs": round(t_fetch, 1), "total_secs": round(t_total, 1)}


# ─── Job: pull_edct ───────────────────────────────────────────────────────────


@app.post("/jobs/pull_edct")
def pull_edct(
    lookback_minutes: int = Query(360, ge=1, le=1440),
    max_messages: int = Query(100, ge=1, le=200),
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
                .upsert(alert, on_conflict="source_message_id")
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
        r"(?:Original|Proposed|Filed|Scheduled)\s+(?:Departure|Dep)(?:\s+Time)?\s*[:\-]?\s*("
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
    """Match an alert to a flight by airport pair within a ±12h window.
    Also backfills tail_number on the alert from the matched flight."""
    dep = alert.get("departure_icao")
    arr = alert.get("arrival_icao")
    if not dep or not arr:
        return None

    now = datetime.now(timezone.utc)
    res = (
        supa.table(FLIGHTS_TABLE)
        .select("id, tail_number")
        .eq("departure_icao", dep)
        .eq("arrival_icao", arr)
        .gte("scheduled_departure", (now - timedelta(hours=2)).isoformat())
        .lte("scheduled_departure", (now + timedelta(hours=12)).isoformat())
        .limit(1)
        .execute()
    )
    rows = res.data or []
    if not rows:
        return None
    # Backfill tail_number from flight if not already parsed from email
    if not alert.get("tail_number") and rows[0].get("tail_number"):
        alert["tail_number"] = rows[0]["tail_number"]
    return rows[0]["id"]


# ─── TFR proximity checking (FAA GeoServer WFS API) ──────────────────────────

_TFR_WFS_URL = (
    "https://tfr.faa.gov/geoserver/TFR/ows"
    "?service=WFS&version=1.0.0&request=GetFeature"
    "&typeName=TFR:V_TFR_LOC&outputFormat=application/json&maxFeatures=500"
)


def _haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two points in nautical miles."""
    R_NM = 3440.065  # Earth radius in nautical miles
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2 * R_NM * math.asin(math.sqrt(a))


def _point_in_polygon(px: float, py: float, polygon: List[List[float]]) -> bool:
    """Ray-casting point-in-polygon test. polygon is [[lon,lat], ...]."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _polygon_centroid(ring: List[List[float]]) -> Tuple[float, float]:
    """Compute centroid (lon, lat) of a polygon ring [[lon,lat], ...]."""
    n = len(ring)
    if n == 0:
        return (0.0, 0.0)
    cx = sum(p[0] for p in ring) / n
    cy = sum(p[1] for p in ring) / n
    return (cx, cy)


def _max_vertex_dist_nm(center_lat: float, center_lon: float, ring: List[List[float]]) -> float:
    """Max distance from centroid to any polygon vertex, in NM."""
    max_d = 0.0
    for p in ring:
        d = _haversine_nm(center_lat, center_lon, p[1], p[0])
        if d > max_d:
            max_d = d
    return max_d


def _get_feature_ring(feature: Dict[str, Any]) -> Optional[List[List[float]]]:
    """Extract the first polygon ring from a GeoJSON feature."""
    geom = feature.get("geometry", {})
    geom_type = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if not coords:
        return None
    if geom_type == "Polygon":
        return coords[0] if coords else None
    elif geom_type == "MultiPolygon":
        return coords[0][0] if coords and coords[0] else None
    return None


def _filter_vip_inner_rings(features: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """For VIP TFRs with inner/outer rings, keep only the inner (smaller) ring.

    VIP TFRs (presidential movements etc.) have two concentric polygons — a
    large outer ring (~30nm) and a smaller inner ring (~10nm).  The FAA WFS
    returns them as separate features with nearly identical centroids.  We
    group features whose centroids are within 5nm of each other and, for
    groups with 2+ members, keep only the smallest polygon so we only alert
    when the airport is truly inside the restricted core.
    """
    # Compute centroid + effective radius per feature
    meta: List[Tuple[int, float, float, float]] = []  # (idx, lat, lon, radius)
    for i, f in enumerate(features):
        ring = _get_feature_ring(f)
        if ring and len(ring) >= 3:
            clon, clat = _polygon_centroid(ring)
            radius = _max_vertex_dist_nm(clat, clon, ring)
            meta.append((i, clat, clon, radius))
        else:
            meta.append((i, 0.0, 0.0, -1.0))  # no geometry → keep as-is

    # Group by centroid proximity (within 5nm = same TFR complex)
    used: set = set()
    keep_indices: set = set()

    for mi in range(len(meta)):
        if mi in used:
            continue
        idx_i, lat_i, lon_i, rad_i = meta[mi]
        if rad_i < 0:
            keep_indices.add(idx_i)
            used.add(mi)
            continue

        group = [mi]
        used.add(mi)
        for mj in range(mi + 1, len(meta)):
            if mj in used:
                continue
            _, lat_j, lon_j, rad_j = meta[mj]
            if rad_j < 0:
                continue
            if _haversine_nm(lat_i, lon_i, lat_j, lon_j) < 5.0:
                group.append(mj)
                used.add(mj)

        if len(group) == 1:
            keep_indices.add(meta[group[0]][0])
        else:
            # Multiple overlapping features → keep smallest (inner ring)
            smallest = min(group, key=lambda g: meta[g][3])
            kept_idx = meta[smallest][0]
            kept_radius = meta[smallest][3]
            dropped = [meta[g][0] for g in group if meta[g][0] != kept_idx]
            dropped_radii = [round(meta[g][3], 1) for g in group if meta[g][0] != kept_idx]
            kept_key = features[kept_idx].get("properties", {}).get("NOTAM_KEY", "?")
            print(
                f"TFR VIP filter: keeping inner ring {kept_key} "
                f"(r={kept_radius:.1f}nm), dropping {len(dropped)} outer ring(s) "
                f"(r={dropped_radii})",
                flush=True,
            )
            keep_indices.add(kept_idx)

    result = [features[i] for i in sorted(keep_indices)]
    if len(result) < len(features):
        print(
            f"TFR VIP filter: {len(features)} features → {len(result)} "
            f"(dropped {len(features) - len(result)} outer rings)",
            flush=True,
        )
    return result


def _fetch_tfr_geojson() -> List[Dict[str, Any]]:
    """Fetch all active TFRs as GeoJSON features from FAA GeoServer WFS.

    Returns list of GeoJSON feature dicts with properties and polygon geometry.
    Single HTTP request — no scraping or parallel detail fetches needed.
    """
    r = requests.get(_TFR_WFS_URL, timeout=(5, 20), headers={
        "User-Agent": "Baker-Aviation-OpsMonitor/1.0",
        "Accept": "application/json",
    })
    r.raise_for_status()
    data = r.json()
    features = data.get("features", [])
    print(f"TFR WFS: fetched {len(features)} active TFRs", flush=True)
    return features


def _check_airport_vs_tfr(
    airport_lat: float, airport_lon: float,
    feature: Dict[str, Any], buffer_nm: float = 0,
) -> Optional[Dict[str, Any]]:
    """Check if an airport is inside a TFR polygon.

    Returns proximity info dict if the airport is inside the polygon, None otherwise.
    """
    geom = feature.get("geometry", {})
    geom_type = geom.get("type", "")
    coords = geom.get("coordinates", [])
    if not coords:
        return None

    # Normalize to list of polygon rings
    rings: List[List[List[float]]] = []
    if geom_type == "Polygon":
        rings = [coords[0]] if coords else []
    elif geom_type == "MultiPolygon":
        rings = [poly[0] for poly in coords if poly]
    else:
        return None

    for ring in rings:
        if len(ring) < 3:
            continue
        if _point_in_polygon(airport_lon, airport_lat, ring):
            clon, clat = _polygon_centroid(ring)
            dist = _haversine_nm(airport_lat, airport_lon, clat, clon)
            return {"inside": True, "distance_nm": round(dist, 1)}

    return None


def _run_check_tfrs(flights: List[Dict]) -> Dict[str, Any]:
    """Fetch all active TFRs from FAA GeoServer, check proximity to flight airports.

    Returns stats dict with tfr_count, tfr_alerts_created.
    """
    # Collect unique airports from flights that we have coordinates for
    flight_airports: Dict[str, List[Dict]] = {}  # icao -> [flight, ...]
    for f in flights:
        for icao in [f.get("departure_icao"), f.get("arrival_icao")]:
            if icao and icao in AIRPORT_COORDS:
                flight_airports.setdefault(icao, []).append(f)

    if not flight_airports:
        print("TFR check: no flight airports with known coordinates", flush=True)
        return {"tfr_count": 0, "tfr_alerts_created": 0}

    # Single WFS request gets all active TFRs with polygon geometry
    features = _fetch_tfr_geojson()
    if not features:
        return {"tfr_count": 0, "tfr_alerts_created": 0}

    # VIP TFRs have inner + outer ring as separate features — keep only inner
    features = _filter_vip_inner_rings(features)

    print(f"TFR check: {len(features)} TFRs, checking {len(flight_airports)} airports", flush=True)

    TFR_BUFFER_NM = 3
    alerts_to_insert = []
    for feature in features:
        props = feature.get("properties", {})
        notam_key = props.get("NOTAM_KEY", "unknown")
        title = props.get("TITLE", "")
        state = props.get("STATE", "")

        for icao in flight_airports:
            coord = AIRPORT_COORDS[icao]
            hit = _check_airport_vs_tfr(coord[0], coord[1], feature, TFR_BUFFER_NM)
            if not hit:
                continue

            dist = hit["distance_nm"]
            inside = hit.get("inside", False)
            proximity_desc = "airport inside TFR" if inside else f"{dist}nm from TFR"

            for flight in flight_airports[icao]:
                fid = flight["id"]
                # Use notam_key in source_message_id for dedup
                safe_key = notam_key.replace("/", "_").replace(" ", "_")
                source_id = f"tfr-{safe_key}-{fid}"
                alerts_to_insert.append({
                    "flight_id": fid,
                    "alert_type": "NOTAM_TFR",
                    "severity": "critical",
                    "airport_icao": icao,
                    "subject": f"TFR {notam_key} — {proximity_desc}"[:500],
                    "body": f"TFR {notam_key} ({proximity_desc}). "
                            f"{title}. State: {state}"[:2000],
                    "source_message_id": source_id,
                    "raw_data": json.dumps({
                        "tfr_notam_key": notam_key,
                        "tfr_title": title[:500],
                        "tfr_state": state,
                        "airport_distance_nm": dist,
                        "airport_inside_tfr": inside,
                    }),
                    "created_at": _utc_now(),
                })

    tfr_alerts_created = 0
    if alerts_to_insert:
        # Deduplicate by source_message_id before upserting (same TFR+flight may match
        # via both departure and arrival airport)
        seen_ids: set = set()
        deduped: list = []
        for a in alerts_to_insert:
            if a["source_message_id"] not in seen_ids:
                seen_ids.add(a["source_message_id"])
                deduped.append(a)
        alerts_to_insert = deduped

        print(f"TFR check: upserting {len(alerts_to_insert)} TFR alerts", flush=True)
        try:
            supa = sb()
            res = (
                supa.table(OPS_ALERTS_TABLE)
                .upsert(alerts_to_insert, on_conflict="source_message_id")
                .execute()
            )
            tfr_alerts_created = len(res.data) if res.data else 0
        except Exception as e:
            print(f"TFR alert upsert error: {repr(e)}", flush=True)

    print(f"TFR check complete: tfrs={len(features)} alerts={tfr_alerts_created}", flush=True)
    return {"tfr_count": len(features), "tfr_alerts_created": tfr_alerts_created}


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

    # ── TFR proximity check (area-wide TFRs not tied to specific airports) ──
    tfr_stats = {"tfr_count": 0, "tfr_alerts_created": 0}
    try:
        tfr_stats = _run_check_tfrs(flights)
    except Exception as e:
        print(f"TFR proximity check failed (non-fatal): {repr(e)}", flush=True)

    total_alerts = alerts_created + tfr_stats.get("tfr_alerts_created", 0)
    print(
        f"check_notams complete: flights={len(flights)} airports={len(airports)} "
        f"notam_alerts={alerts_created} tfr_alerts={tfr_stats.get('tfr_alerts_created', 0)}",
        flush=True,
    )
    return {
        "flights_checked": len(flights),
        "airports_checked": len(airports),
        "alerts_created": total_alerts,
        "notam_alerts": alerts_created,
        **tfr_stats,
    }


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
def debug_ics_fields(count: int = Query(5, ge=1, le=20), feed: int = Query(0, ge=0)):
    """Dump ALL raw ICS properties from the first N VEVENTs to see what JetInsight sends."""
    urls = _load_ics_urls()
    if not urls:
        return {"error": "No ICS URLs configured"}
    if feed >= len(urls):
        return {"error": f"feed index {feed} out of range (0-{len(urls)-1})"}
    try:
        r = requests.get(urls[feed], timeout=15, headers={"Cache-Control": "no-cache"})
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
        ("api-staging.cgifederal-aim.com", 443),
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
            params={"location": icao, "classification": "DOMESTIC,FDC"},
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


@app.get("/debug/tfr_test")
def debug_tfr_test():
    """Fetch all active TFRs and check proximity against all known airports.
    Use this to test the TFR proximity checker without needing scheduled flights."""
    result: Dict[str, Any] = {"ok": False}
    try:
        features = _fetch_tfr_geojson()
        result["tfr_count"] = len(features)
        result["sample_tfrs"] = [
            {
                "notam_key": f.get("properties", {}).get("NOTAM_KEY"),
                "title": f.get("properties", {}).get("TITLE", "")[:100],
                "state": f.get("properties", {}).get("STATE"),
                "geometry_type": f.get("geometry", {}).get("type"),
            }
            for f in features[:20]
        ]

        # Proximity check against all known airports
        TFR_BUFFER_NM = 3
        proximity_hits: List[Dict] = []
        for feature in features:
            props = feature.get("properties", {})
            notam_key = props.get("NOTAM_KEY", "unknown")
            title = props.get("TITLE", "")

            for icao, (lat, lon) in AIRPORT_COORDS.items():
                hit = _check_airport_vs_tfr(lat, lon, feature, TFR_BUFFER_NM)
                if hit:
                    proximity_hits.append({
                        "tfr_notam_key": notam_key,
                        "tfr_title": title[:80],
                        "airport": icao,
                        "distance_nm": hit["distance_nm"],
                        "inside_tfr": hit.get("inside", False),
                    })

        result["proximity_hits"] = proximity_hits
        result["airports_affected"] = sorted(set(h["airport"] for h in proximity_hits))
        result["hit_count"] = len(proximity_hits)
        result["ok"] = True
    except Exception as e:
        result["error"] = repr(e)
    return result


@app.get("/debug/swim_positions")
def debug_swim_positions():
    """Show recent SWIM positions for Baker fleet — latest per tail."""
    supa = sb()
    # Get all recent positions
    result = supa.table("swim_positions").select(
        "acid, tail_number, departure_icao, arrival_icao, event_type, event_time, "
        "latitude, longitude, altitude_ft, groundspeed_kt, aircraft_type, flight_status, etd, eta"
    ).order("event_time", desc=True).limit(50).execute()
    # Dedupe to latest per tail
    seen = set()
    latest = []
    for p in result.data:
        key = p.get("acid") or p.get("tail_number")
        if key and key not in seen:
            seen.add(key)
            latest.append(p)
    return {"count": len(latest), "positions": latest}


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
            params={"location": icao, "classification": "DOMESTIC,FDC"},
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
        # Skip grass/turf runways or runways shorter than 4000 ft
        if _is_ignorable_runway(m):
            return False
        return True
    if re.search(r"(CLSD|CLOSED).{0,60}(RWY|RUNWAY)", m):
        if _is_noise_notam(m):
            return False
        if _is_ignorable_runway(m):
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


def _is_ignorable_runway(msg_upper: str) -> bool:
    """Return True if the runway closure is for a grass/turf runway or one
    shorter than 4000 ft — not usable by our jets, so skip the alert."""
    # Grass / turf / sod surface
    if re.search(r"\b(TURF|GRASS|SOD)\b", msg_upper):
        return True
    # Runway dimensions like 3500X60 or 2800 X 75 — check length < 4000
    dim = re.search(r"\b(\d{3,5})\s*X\s*\d{2,4}\b", msg_upper)
    if dim:
        length = int(dim.group(1))
        if length < 4000:
            return True
    return False


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


# ─── SWIM Feed ────────────────────────────────────────────────────────────────

@app.post("/jobs/pull_swim")
def job_pull_swim():
    """Drain FAA SWIM SCDS queues (TFMS, STDDS, NOTAM) and write to Supabase."""
    from swim_client import pull_swim  # Lazy import — solace-pubsubplus is heavy
    t0 = time.time()
    try:
        stats = pull_swim()
    except Exception as e:
        print(f"[pull_swim] exception: {e}", flush=True)
        log_pipeline_run("swim-pull", status="error", message=str(e)[:200])
        raise HTTPException(500, detail=f"SWIM pull failed: {e}")
    duration_ms = int((time.time() - t0) * 1000)
    total_items = (
        stats.get("positions_upserted", 0)
        + stats.get("flow_control_upserted", 0)
        + stats.get("notams_upserted", 0)
    )
    log_pipeline_run(
        "swim-pull",
        items=total_items,
        duration_ms=duration_ms,
        message=f"pos={stats.get('positions_upserted',0)} flow={stats.get('flow_control_upserted',0)} notams={stats.get('notams_upserted',0)}",
    )
    return {"ok": True, **stats}
