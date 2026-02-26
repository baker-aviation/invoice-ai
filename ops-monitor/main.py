# ops-monitor/main.py
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, HTTPException, Query
from icalendar import Calendar

from supa import sb

app = FastAPI()

# ─── Config ───────────────────────────────────────────────────────────────────

ICS_URL = os.getenv("JETINSIGHT_ICS_URL")
SAMSARA_API_KEY = os.getenv("SAMSARA_API_KEY")
FAA_CLIENT_ID = os.getenv("FAA_CLIENT_ID")
FAA_CLIENT_SECRET = os.getenv("FAA_CLIENT_SECRET")

# FAA NMS API (replaces legacy external-api.faa.gov)
# Prod:    https://api-nms.aim.faa.gov
# Staging: https://api-staging.cgifederal-aim.com
NMS_BASE_URL = os.getenv("NMS_BASE_URL", "https://api-nms.aim.faa.gov")
NMS_AUTH_URL = f"{NMS_BASE_URL}/v1/auth/token"
NMS_API_BASE = f"{NMS_BASE_URL}/nmsapi"

FOREFLIGHT_MAILBOX = os.getenv("FOREFLIGHT_MAILBOX", "ForeFlight@baker-aviation.com")
MS_TENANT_ID = os.getenv("MS_TENANT_ID")
MS_CLIENT_ID = os.getenv("MS_CLIENT_ID")
MS_CLIENT_SECRET = os.getenv("MS_CLIENT_SECRET")

FLIGHTS_TABLE = "flights"
OPS_ALERTS_TABLE = "ops_alerts"

# ─── NMS bearer token cache (module-level, refreshed when expired) ────────────

import time as _time

_nms_token_cache: Dict[str, Any] = {"token": None, "expires_at": 0.0}


def _get_nms_token() -> str:
    """Fetch (or return cached) NMS bearer token using client_credentials flow."""
    now = _time.time()
    if _nms_token_cache["token"] and now < _nms_token_cache["expires_at"] - 60:
        return _nms_token_cache["token"]
    if not FAA_CLIENT_ID or not FAA_CLIENT_SECRET:
        raise RuntimeError("FAA_CLIENT_ID / FAA_CLIENT_SECRET not configured")
    r = requests.post(
        NMS_AUTH_URL,
        data={"grant_type": "client_credentials"},
        auth=(FAA_CLIENT_ID, FAA_CLIENT_SECRET),
        timeout=15,
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


# ─── GET /api/flights  (called by dashboard) ──────────────────────────────────


@app.get("/api/flights")
def get_flights(
    lookahead_hours: int = Query(120, ge=1, le=168),
    include_alerts: bool = Query(True),
):
    """
    Return upcoming flights and their ops alerts for the dashboard.
    """
    supa = sb()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    res = (
        supa.table(FLIGHTS_TABLE)
        .select("*")
        .gte("scheduled_departure", now.isoformat())
        .lte("scheduled_departure", cutoff.isoformat())
        .order("scheduled_departure", desc=False)
        .execute()
    )
    flights = res.data or []

    if include_alerts and flights:
        flight_ids = [f["id"] for f in flights]
        alerts_res = (
            supa.table(OPS_ALERTS_TABLE)
            .select("*")
            .in_("flight_id", flight_ids)
            .is_("acknowledged_at", "null")
            .order("created_at", desc=False)
            .execute()
        )
        alerts_by_flight: Dict[str, List] = {}
        for a in (alerts_res.data or []):
            fid = a.get("flight_id")
            if fid:
                alerts_by_flight.setdefault(fid, []).append(a)

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


@app.post("/jobs/sync_schedule")
def sync_schedule(lookahead_hours: int = Query(120, ge=1, le=168)):
    """
    Fetch the JetInsight ICS feed and upsert upcoming flights into Supabase.
    """
    if not ICS_URL:
        raise HTTPException(400, "JETINSIGHT_ICS_URL not configured")

    r = requests.get(ICS_URL, timeout=30)
    r.raise_for_status()

    cal = Calendar.from_ical(r.content)
    supa = sb()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    upserted = skipped = 0

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

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

        flight = {
            "ics_uid": uid,
            "tail_number": tail,
            "departure_icao": dep_icao,
            "arrival_icao": arr_icao,
            "scheduled_departure": dep_dt.isoformat(),
            "scheduled_arrival": arr_dt.isoformat() if arr_dt else None,
            "summary": summary,
            "updated_at": _utc_now(),
        }

        result = (
            supa.table(FLIGHTS_TABLE)
            .upsert(flight, on_conflict="ics_uid")
            .execute()
        )
        if result.data:
            upserted += 1
        else:
            skipped += 1

    return {"ok": True, "upserted": upserted, "skipped": skipped}


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


@app.post("/jobs/check_notams")
def check_notams(lookahead_hours: int = Query(120, ge=1, le=168)):
    """
    For each upcoming flight, query the FAA NOTAM API for departure and arrival
    airports and store relevant NOTAMs as ops_alerts.
    """
    if not FAA_CLIENT_ID or not FAA_CLIENT_SECRET:
        raise HTTPException(400, "FAA_CLIENT_ID / FAA_CLIENT_SECRET not configured for NMS API")

    supa = sb()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=lookahead_hours)

    flights_res = (
        supa.table(FLIGHTS_TABLE)
        .select("*")
        .gte("scheduled_departure", now.isoformat())
        .lte("scheduled_departure", cutoff.isoformat())
        .execute()
    )
    flights = flights_res.data or []
    if not flights:
        return {"ok": True, "flights_checked": 0, "alerts_created": 0}

    # Collect unique airports
    airports: set = set()
    for f in flights:
        if f.get("departure_icao"):
            airports.add(f["departure_icao"])
        if f.get("arrival_icao"):
            airports.add(f["arrival_icao"])

    # Fetch all airports in parallel — one request per ICAO (FAA API limitation)
    notams_by_airport: Dict[str, List] = {}
    with ThreadPoolExecutor(max_workers=min(len(airports), 8)) as pool:
        future_to_icao = {pool.submit(_fetch_notams, icao): icao for icao in airports}
        for future in as_completed(future_to_icao):
            icao = future_to_icao[future]
            try:
                notams_by_airport[icao] = future.result()
            except Exception as e:
                print(f"NOTAM fetch error {icao}: {repr(e)}", flush=True)
                notams_by_airport[icao] = []

    alerts_created = 0
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
                msg = notam_data.get("text", "") or ""
                if not _is_relevant_notam_msg(msg):
                    continue
                notam_id = notam_data.get("id", "") or notam_data.get("number", "")
                alert = {
                    "flight_id": fid,
                    "alert_type": _classify_notam(msg),
                    "severity": _notam_severity(msg),
                    "airport_icao": notam_data.get("icaoLocation") or icao,
                    "subject": notam_data.get("number", "")[:500],
                    "body": msg[:2000],
                    "source_message_id": f"nms-{notam_id}-{fid}",
                    "raw_data": json.dumps(feature),
                    "created_at": _utc_now(),
                }
                try:
                    res = (
                        supa.table(OPS_ALERTS_TABLE)
                        .upsert(alert, on_conflict="source_message_id", ignore_duplicates=True)
                        .execute()
                    )
                    if res.data:
                        alerts_created += 1
                except Exception as e:
                    print(f"NOTAM alert insert error: {repr(e)}", flush=True)

    return {
        "ok": True,
        "flights_checked": len(flights),
        "airports_checked": len(airports),
        "alerts_created": alerts_created,
    }


def _fetch_notams(icao: str) -> List[Dict]:
    """Return list of GeoJSON feature dicts from the NMS API for a given ICAO."""
    token = _get_nms_token()
    for attempt in range(4):
        r = requests.get(
            f"{NMS_API_BASE}/v1/notams",
            headers={
                "Authorization": f"Bearer {token}",
                "nmsResponseFormat": "GEOJSON",
            },
            params={"location": icao, "classification": "DOMESTIC"},
            timeout=20,
        )
        print(f"NMS NOTAM {icao}: status={r.status_code} body={r.text[:300]!r}", flush=True)
        if r.status_code == 429:
            wait = 2 ** attempt  # 1s, 2s, 4s, 8s
            print(f"NMS rate limit {icao}, retrying in {wait}s (attempt {attempt + 1})", flush=True)
            _time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json().get("data", {}).get("geojson", [])
    # All retries exhausted
    r.raise_for_status()
    return []


def _is_relevant_notam_msg(msg: str) -> bool:
    return bool(re.search(
        r"CLSD|CLOSED|U/S|OTS|OUT OF SERVICE|TFR|HAZARD|UNLIT|WORK IN PROG",
        msg.upper(),
    ))


def _classify_notam(msg: str) -> str:
    m = msg.upper()
    if re.search(r"\bRWY\b|RUNWAY", m):
        return "NOTAM_RUNWAY"
    if re.search(r"\bTWY\b|TAXIWAY", m):
        return "NOTAM_TAXIWAY"
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
