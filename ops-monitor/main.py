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

from supa import sb

app = FastAPI()

# ─── Config ───────────────────────────────────────────────────────────────────

# Support multiple per-aircraft ICS URLs stored as newline-separated list in
# JETINSIGHT_ICS_URLS, falling back to the legacy single-URL JETINSIGHT_ICS_URL.
_raw_ics = os.getenv("JETINSIGHT_ICS_URLS") or os.getenv("JETINSIGHT_ICS_URL") or ""
ICS_URLS: list[str] = [u.strip() for u in _raw_ics.splitlines() if u.strip()]
SAMSARA_API_KEY = os.getenv("SAMSARA_API_KEY")
FAA_CLIENT_ID = os.getenv("FAA_CLIENT_ID")
FAA_CLIENT_SECRET = os.getenv("FAA_CLIENT_SECRET")

# FAA NMS API (staging / pre-prod — cgifederal-aim.com)
NMS_AUTH_URL = "https://api-staging.cgifederal-aim.com/v1/auth/token"
NMS_API_BASE = "https://api-staging.cgifederal-aim.com/nmsapi"

FOREFLIGHT_MAILBOX = os.getenv("FOREFLIGHT_MAILBOX", "ForeFlight@baker-aviation.com")
MS_TENANT_ID = os.getenv("MS_TENANT_ID")
MS_CLIENT_ID = os.getenv("MS_CLIENT_ID")
MS_CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")

FLIGHTS_TABLE = "flights"
OPS_ALERTS_TABLE = "ops_alerts"

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


def _parse_flight_fields(component) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Extract (departure_icao, arrival_icao, tail_number) from a JetInsight VEVENT.

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

    return dep_icao, arr_icao, tail


# ─── Health ───────────────────────────────────────────────────────────────────


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "ops-monitor", "ts": _utc_now()}


# ─── GET /api/vans  (Samsara live vehicle locations) ──────────────────────────

@app.get("/api/vans")
def get_vans():
    if not SAMSARA_API_KEY:
        raise HTTPException(status_code=503, detail="SAMSARA_API_KEY not configured")

    try:
        r = requests.get(
            "https://api.samsara.com/fleet/vehicles/stats",
            headers={"Authorization": f"Bearer {SAMSARA_API_KEY}"},
            params={"types": "gps"},
            timeout=10,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Samsara API error: {e}")

    raw = r.json().get("data") or []
    vans: List[Dict[str, Any]] = []
    for v in raw:
        gps = v.get("gps") or {}
        vans.append({
            "id": v.get("id"),
            "name": v.get("name"),
            "lat": gps.get("latitude"),
            "lon": gps.get("longitude"),
            "speed_mph": gps.get("speedMilesPerHour"),
            "heading": gps.get("headingDegrees"),
            "address": (gps.get("reverseGeo") or {}).get("formattedLocation"),
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
        raise HTTPException(status_code=502, detail=f"Samsara API error: {e}")

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
    supa = sb()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    # Look back 12 hours so flights that departed earlier today (but haven't
    # landed yet) still appear in the arrivals schedule.
    lookback = now - timedelta(hours=12)
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

    if include_alerts and flights:
        flight_id_set = {f["id"] for f in flights}
        alerts_by_flight: Dict[str, List] = {}
        try:
            # Fetch all unacknowledged alerts and filter in Python to avoid
            # URL-length limits from large .in_() lists with many flight UUIDs.
            alerts_res = (
                supa.table(OPS_ALERTS_TABLE)
                .select("*")
                .is_("acknowledged_at", "null")
                .order("created_at", desc=False)
                .execute()
            )
            for a in (alerts_res.data or []):
                fid = a.get("flight_id")
                if fid and fid in flight_id_set:
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


def _fetch_ics_events(url: str) -> list:
    """Fetch one ICS feed and return its VEVENT components."""
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    cal = Calendar.from_ical(r.content)
    return [c for c in cal.walk() if c.name == "VEVENT"]


@app.post("/jobs/sync_schedule")
def sync_schedule(lookahead_hours: int = Query(720, ge=1, le=720)):
    """
    Fetch all per-aircraft JetInsight ICS feeds in parallel and upsert
    upcoming flights into Supabase.
    """
    import time as _time
    t0 = _time.monotonic()

    if not ICS_URLS:
        raise HTTPException(400, "JETINSIGHT_ICS_URLS not configured")

    print(f"sync_schedule: starting, {len(ICS_URLS)} feeds, lookahead={lookahead_hours}h", flush=True)

    # Fetch all feeds in parallel (cap workers at 8 to stay within memory)
    all_components: list = []
    feed_results: dict = {}
    pool = ThreadPoolExecutor(max_workers=min(len(ICS_URLS), 8))
    future_to_url = {pool.submit(_fetch_ics_events, url): url for url in ICS_URLS}
    try:
        for future in as_completed(future_to_url, timeout=60):
            url = future_to_url[future]
            try:
                events = future.result()
                all_components.extend(events)
                feed_results[url[-12:]] = len(events)
            except Exception as e:
                feed_results[url[-12:]] = f"ERR:{repr(e)[:60]}"
                print(f"ICS fetch error {url[:80]}: {repr(e)}", flush=True)
    except FuturesTimeoutError:
        print("ICS fetch 60s budget exceeded; some feeds may be missing", flush=True)
    finally:
        pool.shutdown(wait=False)

    t_fetch = _time.monotonic() - t0
    print(f"sync_schedule: fetch phase done in {t_fetch:.1f}s, {len(all_components)} events from {len(feed_results)}/{len(ICS_URLS)} feeds", flush=True)

    supa = sb()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    upserted = skipped = errors = 0

    for i, component in enumerate(all_components):
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

            # Only care about flights departing within the lookahead window
            if dep_dt > cutoff or (arr_dt and arr_dt < now):
                skipped += 1
                continue

            dep_icao, arr_icao, tail = _parse_flight_fields(component)

            # Build the upsert payload, omitting NULL fields so we never
            # overwrite previously-good data when parsing fails on a
            # slightly different summary format.
            flight: Dict[str, Any] = {
                "ics_uid": uid,
                "scheduled_departure": dep_dt.isoformat(),
                "summary": summary,
                "updated_at": _utc_now(),
            }
            if tail is not None:
                flight["tail_number"] = tail
            if dep_icao is not None:
                flight["departure_icao"] = dep_icao
            if arr_icao is not None:
                flight["arrival_icao"] = arr_icao
            if arr_dt is not None:
                flight["scheduled_arrival"] = arr_dt.isoformat()

            result = (
                supa.table(FLIGHTS_TABLE)
                .upsert(flight, on_conflict="ics_uid")
                .execute()
            )
            if result.data:
                upserted += 1
            else:
                skipped += 1

            if (i + 1) % 50 == 0:
                print(f"sync_schedule: upsert progress {i+1}/{len(all_components)}", flush=True)
        except Exception as e:
            errors += 1
            print(f"sync_schedule event error uid={component.get('UID','?')}: {repr(e)}", flush=True)

    t_total = _time.monotonic() - t0
    print(f"sync_schedule: done in {t_total:.1f}s — upserted={upserted} skipped={skipped} errors={errors} from {len(all_components)} events", flush=True)
    return {"ok": True, "upserted": upserted, "skipped": skipped, "errors": errors, "fetch_secs": round(t_fetch, 1), "total_secs": round(t_total, 1)}


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

    return {"ok": True, "ingested": ingested, "skipped": skipped, "errors": errors}


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
    edct_time = None
    edct_m = re.search(
        r"EDCT\s*[:\-]?\s*(\d{2}/\d{2}/\d{4}\s+\d{4}Z|\d{4}Z|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})",
        body, re.I,
    )
    if edct_m:
        edct_time = edct_m.group(1).strip()

    # Original / proposed departure
    orig_dep = None
    orig_m = re.search(
        r"(?:Original|Proposed|Filed|Scheduled)\s+(?:Departure|Dep)\s*[:\-]?\s*"
        r"(\d{2}/\d{2}/\d{4}\s+\d{4}Z|\d{4}Z|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})",
        body, re.I,
    )
    if orig_m:
        orig_dep = orig_m.group(1).strip()

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
                # NMS GeoJSON structure: feature.properties.coreNOTAMData.notam
                notam_data = (
                    feature.get("properties", {})
                    .get("coreNOTAMData", {})
                    .get("notam", {})
                )
                if not notam_data:
                    continue
                # NMS uses "text", legacy API uses "traditionalMessage"
                msg = notam_data.get("text") or notam_data.get("traditionalMessage") or ""
                if not _is_relevant_notam_msg(msg):
                    continue
                notam_id = notam_data.get("id", "") or notam_data.get("number", "")
                alerts_to_insert.append({
                    "flight_id": fid,
                    "alert_type": _classify_notam(msg),
                    "severity": _notam_severity(msg),
                    "airport_icao": notam_data.get("icaoLocation") or icao,
                    "subject": notam_data.get("number", "")[:500],
                    "body": msg[:2000],
                    "source_message_id": f"nms-{notam_id}-{fid}",
                    "raw_data": json.dumps(feature),
                    "created_at": _utc_now(),
                })

    alerts_created = 0
    if alerts_to_insert:
        print(f"check_notams: upserting {len(alerts_to_insert)} alerts in bulk", flush=True)
        try:
            # Supabase upsert accepts a list — one round-trip for all rows
            res = (
                supa.table(OPS_ALERTS_TABLE)
                .upsert(alerts_to_insert, on_conflict="source_message_id", ignore_duplicates=True)
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
        return {"ok": True, "timeout": True, "alerts_created": 0}
    except Exception as e:
        print(f"check_notams exception: {repr(e)}", flush=True)
        raise HTTPException(500, detail=str(e))
    return {"ok": True, **stats}


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
        return True
    if re.search(r"(CLSD|CLOSED).{0,60}(RWY|RUNWAY)", m):
        return True
    # Airport/aerodrome closure
    if re.search(r"(\bAD\b|AERODROME|AIRPORT).{0,30}(CLSD|CLOSED)", m):
        return True
    if re.search(r"(CLSD|CLOSED).{0,30}(\bAD\b|AERODROME|AIRPORT)", m):
        return True
    # TFR
    if re.search(r"\bTFR\b|TEMPORARY FLIGHT RESTRICTION", m):
        return True
    # PPR
    if re.search(r"\bPPR\b|PRIOR PERMISSION REQUIRED", m):
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
    if re.search(r"\bAD\b|AERODROME|AIRPORT", m):
        return "NOTAM_AERODROME"
    return "NOTAM_OTHER"


def _notam_severity(msg: str) -> str:
    m = msg.upper()
    if re.search(r"CLSD|CLOSED|STOP", m):
        return "critical"
    if re.search(r"TFR", m):
        return "critical"
    return "warning"
