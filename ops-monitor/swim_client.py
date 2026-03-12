# ops-monitor/swim_client.py
"""
FAA SWIM (System Wide Information Management) client.

Connects to SCDS (SWIM Cloud Distribution Service) via Solace PubSub+,
drains messages from TFMS, STDDS, and NOTAM queues, parses FIXM XML,
and writes results to Supabase.

Queue configuration (from SWIFT portal):
  - TFMS:  R14 Flight Data + R14 Flow Data
  - STDDS: Terminal Automation Information + Tower Departure Event Service
  - NOTAM: AIM NMS Publication
"""

import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from xml.etree import ElementTree as ET

from supa import sb

# ── SWIM Queue Configuration ──────────────────────────────────────────────────

# Queue names from the SWIFT portal (not secrets — they're UUIDs)
SWIM_QUEUES = {
    "TFMS": {
        "queue": "charlie.airninetwo.com.TFMS.e5109ea9-f16e-41a7-a88f-f33caee601cd.OUT",
        "vpn": "TFMS",
        "broker": "tcps://ems1.swim.faa.gov:55443",
    },
    "STDDS": {
        "queue": "charlie.airninetwo.com.STDDS.d858d975-ab44-4ac3-b5dc-0ac869fb057b.OUT",
        "vpn": "STDDS",
        "broker": None,  # uses default SWIM_BROKER_URL
    },
    "NOTAM": {
        "queue": "charlie.airninetwo.com.AIM_FNS.7539384d-dc7d-4104-9f36-7c2823bd6884.OUT",
        "vpn": "AIM_FNS",
        "broker": None,
    },
}

# Baker Aviation fleet — must match BAKER_FLEET in maintenanceData.ts
BAKER_TAILS_SET = {
    "N51GB",  "N102VR", "N106PC", "N125DZ", "N125TH", "N187CR", "N201HR",
    "N301HR", "N371DB", "N416F",  "N513JB", "N519FX", "N521FX", "N533FX",
    "N548FX", "N552FX", "N553FX", "N555FX", "N700LH", "N703TX", "N733FL",
    "N818CF", "N860TX", "N883TR", "N910E",  "N939TX", "N954JS", "N955GH",
    "N957JS", "N971JS", "N988TX", "N992MG", "N998CX",
}
# Baker ICAO callsign prefix (e.g. KOW519, KOW553)
BAKER_CALLSIGN_PREFIX = "KOW"
# Combined set for fast string pre-filtering
BAKER_IDENTIFIERS = BAKER_TAILS_SET | {BAKER_CALLSIGN_PREFIX}
NNUM_RE = re.compile(r"N\d{1,5}[A-Z]{0,2}")

# Maximum messages to drain per queue per run (prevent runaway)
MAX_MESSAGES_PER_QUEUE = 5000
# Per-queue overrides (TFMS is ~50 msg/sec firehose, but string pre-filter is fast)
MAX_MESSAGES_OVERRIDE = {"TFMS": 5000}
# Max seconds to spend draining a single queue
MAX_DRAIN_SECS = 30
# Receive timeout per message (ms) — stop draining when queue is empty
RECEIVE_TIMEOUT_MS = 3000


# ── Solace Connection ─────────────────────────────────────────────────────────

def _get_swim_config():
    """Load SWIM connection config from env vars (set via GCP Secret Manager)."""
    broker = os.environ.get("SWIM_BROKER_URL", "")
    username = os.environ.get("SWIM_USERNAME", "")
    password = os.environ.get("SWIM_PASSWORD", "")
    if not all([broker, username, password]):
        raise RuntimeError(
            "Missing SWIM env vars — set SWIM_BROKER_URL, SWIM_USERNAME, SWIM_PASSWORD"
        )
    return broker, username, password


def drain_queue(queue_name: str, vpn_name: str, max_messages: int = MAX_MESSAGES_PER_QUEUE, broker_override: Optional[str] = None) -> List[str]:
    """Connect to a SCDS Solace queue and drain all pending messages.

    Returns a list of raw XML message bodies.
    """
    from solace.messaging.messaging_service import MessagingService, RetryStrategy
    from solace.messaging.resources.queue import Queue

    default_broker, username, password = _get_swim_config()
    broker = broker_override or default_broker

    print(f"[SWIM] Connecting: vpn={vpn_name}, user={username}, broker={broker}", flush=True)
    broker_props = {
        "solace.messaging.transport.host": broker,
        "solace.messaging.service.vpn-name": vpn_name,
        "solace.messaging.authentication.scheme.basic.username": username,
        "solace.messaging.authentication.scheme.basic.password": password,
        "solace.messaging.tls.trust-store-path": "/etc/ssl/certs/",
    }

    messaging_service = (
        MessagingService.builder()
        .from_properties(broker_props)
        .with_reconnection_retry_strategy(RetryStrategy.parametrized_retry(3, 3000))
        .build()
    )

    messaging_service.connect()
    print(f"[SWIM] Connected to {vpn_name}, draining {queue_name}", flush=True)

    try:
        queue = Queue.durable_exclusive_queue(queue_name)
        receiver = (
            messaging_service.create_persistent_message_receiver_builder()
            .build(queue)
        )
        receiver.start()

        messages: List[str] = []
        t_start = time.time()
        for _ in range(max_messages):
            if time.time() - t_start > MAX_DRAIN_SECS:
                print(f"[SWIM] {vpn_name}: hit {MAX_DRAIN_SECS}s time limit", flush=True)
                break
            msg = receiver.receive_message(timeout=RECEIVE_TIMEOUT_MS)
            if msg is None:
                break  # Queue is empty
            payload = msg.get_payload_as_string() or ""
            if not payload and msg.get_payload_as_bytes():
                payload = msg.get_payload_as_bytes().decode("utf-8", errors="replace")
            messages.append(payload)
            receiver.ack(msg)

        print(f"[SWIM] Drained {len(messages)} messages from {vpn_name} in {time.time()-t_start:.1f}s", flush=True)
        return messages

    finally:
        try:
            messaging_service.disconnect()
        except Exception:
            pass


# ── FIXM XML Parsing ──────────────────────────────────────────────────────────

def _safe_text(el: Optional[ET.Element]) -> Optional[str]:
    """Get text content from an XML element, or None."""
    return el.text.strip() if el is not None and el.text else None


def _find_any(root: ET.Element, *tags: str) -> Optional[ET.Element]:
    """Find first matching element by local name (ignoring namespace)."""
    for el in root.iter():
        local = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        if local in tags:
            return el
    return None


def _extract_tail_number(text: str) -> Optional[str]:
    """Extract Baker N-number from text."""
    m = NNUM_RE.search(text or "")
    if m and m.group(0) in BAKER_TAILS_SET:
        return m.group(0)
    return None


def parse_tfms_flight_message(xml_str: str) -> Optional[Dict[str, Any]]:
    """Parse a TFMS R14 Flight Data message (FIXM XML).

    Extracts: aircraft ID, tail, departure/arrival airports, position, event type.
    """
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return None

    # Try to find aircraft identification
    acid_el = _find_any(root, "aircraftIdentification", "acid")
    acid = _safe_text(acid_el)

    # Find departure/arrival airports
    dep_el = _find_any(root, "departureAerodrome", "departurePoint", "origin")
    arr_el = _find_any(root, "arrivalAerodrome", "destinationPoint", "destination")
    dep_icao = _safe_text(dep_el) or (dep_el.get("code") if dep_el is not None else None)
    arr_icao = _safe_text(arr_el) or (arr_el.get("code") if arr_el is not None else None)

    # Position data
    lat_el = _find_any(root, "latitude", "lat")
    lon_el = _find_any(root, "longitude", "lon")
    alt_el = _find_any(root, "altitude", "assignedAltitude")
    spd_el = _find_any(root, "groundSpeed", "groundspeed")

    lat = float(_safe_text(lat_el)) if _safe_text(lat_el) else None
    lon = float(_safe_text(lon_el)) if _safe_text(lon_el) else None
    alt = None
    if _safe_text(alt_el):
        try:
            alt = int(float(_safe_text(alt_el)))
        except ValueError:
            pass
    spd = None
    if _safe_text(spd_el):
        try:
            spd = int(float(_safe_text(spd_el)))
        except ValueError:
            pass

    # Event type from message type or root tag
    root_tag = root.tag.split("}")[-1] if "}" in root.tag else root.tag
    event_type = "POSITION"
    tag_lower = root_tag.lower()
    if "departure" in tag_lower:
        event_type = "DEPARTURE"
    elif "arrival" in tag_lower:
        event_type = "ARRIVAL"
    elif "flightplan" in tag_lower or "flightPlan" in tag_lower:
        event_type = "FLIGHT_PLAN"

    # Timestamp
    time_el = _find_any(root, "timestamp", "timeOfDeparture", "timeOfArrival", "time")
    event_time = _safe_text(time_el)
    if not event_time:
        event_time = datetime.now(timezone.utc).isoformat()

    tail = _extract_tail_number(acid or "")

    return {
        "acid": acid,
        "tail_number": tail,
        "departure_icao": dep_icao,
        "arrival_icao": arr_icao,
        "latitude": lat,
        "longitude": lon,
        "altitude_ft": alt,
        "groundspeed_kt": spd,
        "event_type": event_type,
        "event_time": event_time,
    }


def parse_tfms_flow_message(xml_str: str) -> Optional[Dict[str, Any]]:
    """Parse a TFMS R14 Flow Data message (GDP, Ground Stop, CTOP)."""
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return None

    root_tag = root.tag.split("}")[-1] if "}" in root.tag else root.tag

    # Determine event type
    event_type = "UNKNOWN"
    tag_lower = root_tag.lower()
    if "grounddelay" in tag_lower or "gdp" in tag_lower:
        event_type = "GDP"
    elif "groundstop" in tag_lower:
        event_type = "GROUND_STOP"
    elif "ctop" in tag_lower or "collaborative" in tag_lower:
        event_type = "CTOP"
    elif "airspaceflow" in tag_lower or "afp" in tag_lower:
        event_type = "AFP"

    # Airport
    airport_el = _find_any(root, "airport", "aerodrome", "facility", "controlElement")
    airport = _safe_text(airport_el) or (airport_el.get("code") if airport_el is not None else None)

    # Times
    eff_el = _find_any(root, "effectiveStart", "beginDate", "startTime")
    exp_el = _find_any(root, "effectiveEnd", "endDate", "endTime")

    # Description / reason
    reason_el = _find_any(root, "reason", "description", "remarks")
    reason = _safe_text(reason_el)

    severity = "critical" if event_type in ("GROUND_STOP", "GDP") else "warning"

    subject = f"{event_type}"
    if airport:
        subject += f" at {airport}"

    return {
        "event_type": event_type,
        "airport_icao": airport,
        "status": "active",
        "severity": severity,
        "subject": subject,
        "body": reason,
        "effective_at": _safe_text(eff_el),
        "expires_at": _safe_text(exp_el),
    }


def parse_notam_message(xml_str: str) -> Optional[Dict[str, Any]]:
    """Parse an AIM NMS NOTAM publication message (AIXM 5.1 XML)."""
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return None

    # NOTAM ID
    notam_id_el = _find_any(root, "id", "notamId", "identifier")
    notam_id = _safe_text(notam_id_el)
    if not notam_id:
        # Try attribute
        for el in root.iter():
            gml_id = el.get("{http://www.opengis.net/gml/3.2}id") or el.get("id")
            if gml_id:
                notam_id = gml_id
                break

    if not notam_id:
        return None

    # Location / airport
    location_el = _find_any(root, "location", "affectedFIR", "designator")
    airport = _safe_text(location_el)

    # NOTAM text
    text_el = _find_any(root, "text", "notamText", "description", "note")
    body = _safe_text(text_el)

    # Classification
    class_el = _find_any(root, "classification", "type", "purpose")
    classification = _safe_text(class_el)

    # Times
    eff_el = _find_any(root, "effectiveStart", "beginPosition", "validTimeBegin")
    exp_el = _find_any(root, "effectiveEnd", "endPosition", "validTimeEnd")

    # Classify the NOTAM (reuse logic from main.py patterns)
    notam_type = "NOTAM_OTHER"
    if body:
        m = body.upper()
        if re.search(r"\bPPR\b|PRIOR PERMISSION REQUIRED", m):
            notam_type = "NOTAM_PPR"
        elif re.search(r"(RWY|RUNWAY).{0,60}(CLSD|CLOSED)", m):
            notam_type = "NOTAM_RUNWAY"
        elif re.search(r"TFR|TEMPORARY FLIGHT RESTRICTION", m):
            notam_type = "NOTAM_TFR"
        elif re.search(r"(\bAD\b|AERODROME|AIRPORT).{0,30}(RSTD|RESTRICTED)", m):
            notam_type = "NOTAM_AD_RESTRICTED"
        elif re.search(r"\bAD\b|AERODROME|AIRPORT", m):
            notam_type = "NOTAM_AERODROME"

    return {
        "notam_id": notam_id,
        "airport_icao": airport,
        "classification": classification,
        "notam_type": notam_type,
        "status": "active",
        "subject": f"NOTAM {notam_id}" + (f" ({airport})" if airport else ""),
        "body": body,
        "effective_at": _safe_text(eff_el),
        "expires_at": _safe_text(exp_el),
    }


# ── Main Pull Logic ───────────────────────────────────────────────────────────

def _is_baker_flight(msg: Dict[str, Any]) -> bool:
    """Check if a flight message involves a Baker Aviation aircraft."""
    tail = msg.get("tail_number")
    if tail and tail in BAKER_TAILS_SET:
        return True
    acid = (msg.get("acid") or "").upper()
    # Check KOW callsign prefix
    if acid.startswith(BAKER_CALLSIGN_PREFIX):
        return True
    # Check if callsign contains a Baker N-number
    m = NNUM_RE.search(acid)
    return bool(m and m.group(0) in BAKER_TAILS_SET)


def pull_swim() -> Dict[str, Any]:
    """Drain all SWIM queues and write parsed data to Supabase.

    Returns stats dict.
    """
    t0 = time.time()
    stats: Dict[str, Any] = {
        "tfms_flight_messages": 0,
        "tfms_flow_messages": 0,
        "stdds_messages": 0,
        "notam_messages": 0,
        "positions_upserted": 0,
        "flow_control_upserted": 0,
        "notams_upserted": 0,
        "errors": 0,
    }

    supa = sb()

    # ── 1. TFMS: Flight Data + Flow Data ──────────────────────────────────────
    try:
        tfms_raw = drain_queue(
            SWIM_QUEUES["TFMS"]["queue"],
            SWIM_QUEUES["TFMS"]["vpn"],
            max_messages=MAX_MESSAGES_OVERRIDE.get("TFMS", MAX_MESSAGES_PER_QUEUE),
            broker_override=SWIM_QUEUES["TFMS"].get("broker"),
        )
    except Exception as e:
        print(f"[SWIM] TFMS drain error: {type(e).__name__}: {e}", flush=True)
        # Log full exception details for auth debugging
        import traceback
        traceback.print_exc()
        tfms_raw = []
        stats["errors"] += 1
        stats["tfms_error"] = str(e)

    positions_batch: List[Dict[str, Any]] = []
    flow_batch: List[Dict[str, Any]] = []

    # Flow data keywords — cheap string check before XML parse
    FLOW_KEYWORDS = ("GroundDelay", "GroundStop", "GDP", "CTOP", "AirspaceFlow", "AFP")

    for raw in tfms_raw:
        # Fast pre-filter: skip XML parse unless message might be relevant
        has_baker_tail = any(t in raw for t in BAKER_IDENTIFIERS)
        has_flow_keyword = any(kw in raw for kw in FLOW_KEYWORDS)

        if not has_baker_tail and not has_flow_keyword:
            continue  # Skip — not a Baker flight and not flow control

        if has_baker_tail:
            flight = parse_tfms_flight_message(raw)
            if flight and _is_baker_flight(flight):
                source_id = f"swim-tfms-{flight['acid']}-{flight['event_time']}"
                positions_batch.append({
                    **flight,
                    "source_id": source_id,
                    "raw_xml": raw[:4000],
                })
                stats["tfms_flight_messages"] += 1
                continue

        if has_flow_keyword:
            flow = parse_tfms_flow_message(raw)
            if flow and flow["event_type"] != "UNKNOWN":
                source_id = f"swim-flow-{flow['event_type']}-{flow.get('airport_icao', 'UNK')}-{flow.get('effective_at', '')}"
                flow_batch.append({
                    **flow,
                    "source_id": source_id,
                    "raw_xml": raw[:4000],
                })
                stats["tfms_flow_messages"] += 1

    # ── 2. STDDS: Terminal Automation + Departure Events ──────────────────────
    try:
        stdds_raw = drain_queue(
            SWIM_QUEUES["STDDS"]["queue"],
            SWIM_QUEUES["STDDS"]["vpn"],
            broker_override=SWIM_QUEUES["STDDS"].get("broker"),
        )
    except Exception as e:
        print(f"[SWIM] STDDS drain error: {e}", flush=True)
        stdds_raw = []
        stats["errors"] += 1

    for raw in stdds_raw:
        # Fast pre-filter: skip unless a Baker tail appears in the raw XML
        if not any(t in raw for t in BAKER_IDENTIFIERS):
            continue
        flight = parse_tfms_flight_message(raw)  # STDDS uses similar FIXM structure
        if flight and _is_baker_flight(flight):
            source_id = f"swim-stdds-{flight['acid']}-{flight['event_time']}"
            positions_batch.append({
                **flight,
                "source_id": source_id,
                "raw_xml": raw[:4000],
            })
            stats["stdds_messages"] += 1

    # ── 3. NOTAM Distribution ─────────────────────────────────────────────────
    try:
        notam_raw = drain_queue(
            SWIM_QUEUES["NOTAM"]["queue"],
            SWIM_QUEUES["NOTAM"]["vpn"],
            broker_override=SWIM_QUEUES["NOTAM"].get("broker"),
        )
    except Exception as e:
        print(f"[SWIM] NOTAM drain error: {e}", flush=True)
        notam_raw = []
        stats["errors"] += 1

    notams_batch: List[Dict[str, Any]] = []
    for raw in notam_raw:
        notam = parse_notam_message(raw)
        if notam:
            notams_batch.append({
                **notam,
                "raw_xml": raw[:4000],
            })
            stats["notam_messages"] += 1

    # ── 4. Write to Supabase ──────────────────────────────────────────────────
    CHUNK = 50

    # Positions
    for i in range(0, len(positions_batch), CHUNK):
        chunk = positions_batch[i : i + CHUNK]
        try:
            supa.table("swim_positions").upsert(
                chunk, on_conflict="source_id"
            ).execute()
            stats["positions_upserted"] += len(chunk)
        except Exception as e:
            print(f"[SWIM] positions upsert error: {e}", flush=True)
            stats["errors"] += 1

    # Flow control (GDP, ground stops, etc.) — keep ALL, not just Baker flights
    for i in range(0, len(flow_batch), CHUNK):
        chunk = flow_batch[i : i + CHUNK]
        try:
            supa.table("swim_flow_control").upsert(
                chunk, on_conflict="source_id"
            ).execute()
            stats["flow_control_upserted"] += len(chunk)
        except Exception as e:
            print(f"[SWIM] flow_control upsert error: {e}", flush=True)
            stats["errors"] += 1

    # NOTAMs — keep ALL (we filter by airport on the dashboard side)
    for i in range(0, len(notams_batch), CHUNK):
        chunk = notams_batch[i : i + CHUNK]
        try:
            supa.table("swim_notams").upsert(
                chunk, on_conflict="notam_id"
            ).execute()
            stats["notams_upserted"] += len(chunk)
        except Exception as e:
            print(f"[SWIM] notams upsert error: {e}", flush=True)
            stats["errors"] += 1

    stats["total_secs"] = round(time.time() - t0, 1)
    print(f"[SWIM] Done: {stats}", flush=True)
    return stats
