import { createServiceClient } from "@/lib/supabase/service";
import { toIcao } from "@/lib/iataToIcao";
import { getRunwaySuppressedIds, detectAllRunwaysClosed, type AllRwysClosedAlert } from "@/lib/runwayData";

export type NotamDates = {
  effective_start: string | null;
  effective_end: string | null;
  issued: string | null;
  status: string | null;
  start_date_utc: string | null;
  end_date_utc: string | null;
  issue_date_utc: string | null;
};

export type OpsAlert = {
  id: string;
  flight_id: string | null;
  alert_type: string;
  severity: string;
  airport_icao: string | null;
  departure_icao: string | null;
  arrival_icao: string | null;
  tail_number: string | null;
  subject: string | null;
  body: string | null;
  edct_time: string | null;
  original_departure_time: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
  notam_dates: NotamDates | null;
  source_message_id: string | null;
};

export type Flight = {
  id: string;
  ics_uid: string;
  tail_number: string | null;
  departure_icao: string | null;
  arrival_icao: string | null;
  scheduled_departure: string;
  scheduled_arrival: string | null;
  summary: string | null;
  flight_type: string | null;
  pic: string | null;
  sic: string | null;
  pax_count: number | null;
  jetinsight_url: string | null;
  fa_flight_id: string | null;
  diverted?: boolean | null;
  alerts: OpsAlert[];
};

export type FlightsResponse = {
  ok: boolean;
  flights: Flight[];
  count: number;
  /** NOTAM_RUNWAY alert IDs suppressed because airport still has 5000+ ft paved open */
  suppressedRunwayNotamIds?: string[];
  /** Flights where ALL runways are closed within ±2hrs of departure/arrival */
  allRunwaysClosedAlerts?: AllRwysClosedAlert[];
};

// ---------------------------------------------------------------------------
// NOTAM noise filter — matches backend logic in ops-monitor/main.py
// ---------------------------------------------------------------------------

// Equipment/lighting terms that indicate a RWY NOTAM is NOT an actual closure.
// Mirrors _NOISE_TERMS in ops-monitor/main.py.
const NOISE_TERMS = /\b(ILS|PAPI|ALS|LGT|LIGHT|TWY|TAXIWAY|APRON|WINDCONE|WIND\s*CONE)\b/i;

function isNoiseNotam(alert: { alert_type: string; body: string | null }): boolean {
  if (alert.alert_type !== "NOTAM_RUNWAY" && alert.alert_type !== "NOTAM_TAXIWAY") return false;
  if (!alert.body) return false;
  return NOISE_TERMS.test(alert.body);
}

// ---------------------------------------------------------------------------
// Extract NOTAM dates from raw_data JSON (matches backend logic)
// ---------------------------------------------------------------------------

function extractNotamDates(rawData: unknown): NotamDates | null {
  if (!rawData) return null;

  // Supabase may return jsonb as a string — parse it first.
  // Also handles double-encoded JSON (backend json.dumps → JSONB string scalar).
  let data: Record<string, unknown>;
  try {
    data = typeof rawData === "string" ? JSON.parse(rawData) : (rawData as Record<string, unknown>);
  } catch {
    return null;
  }

  // Compact format (current): {"notam_dates": {...}}
  const nd = (data.notam_dates ?? {}) as Record<string, unknown>;

  // Legacy GeoJSON: {properties: {coreNOTAMData: {notam: {...}}}}
  // Also handles {properties: {coreNOTAMData: {notamEvent: {notam: {...}}}}}
  const props = (data.properties ?? {}) as Record<string, unknown>;
  const core = (props.coreNOTAMData ?? {}) as Record<string, unknown>;
  const notam = ((core.notam ?? (core.notamEvent as Record<string, unknown>)?.notam) ?? {}) as Record<string, unknown>;

  // Check both camelCase and snake_case field names at multiple levels
  const pick = (...keys: string[]): string | null => {
    for (const src of [nd, notam, core, data]) {
      for (const k of keys) {
        const v = src[k];
        if (typeof v === "string" && v) return v;
      }
    }
    return null;
  };

  return {
    effective_start: pick("effective_start", "effectiveStart"),
    effective_end: pick("effective_end", "effectiveEnd"),
    issued: pick("issued", "issue_date", "issueDate"),
    status: pick("status"),
    start_date_utc: pick("start_date_utc", "startDate", "startDateTime"),
    end_date_utc: pick("end_date_utc", "endDate", "endDateTime"),
    issue_date_utc: pick("issue_date_utc", "issueDate", "issuedDateTime"),
  };
}

// ---------------------------------------------------------------------------
// NOTAM time-relevance: only attach a NOTAM to a flight if the NOTAM's
// effective period overlaps with ±5 hours of the flight at that airport.
// ---------------------------------------------------------------------------

const NOTAM_RELEVANCE_HOURS = 5;

/** Parse an ISO or ICAO-compact date string into a timestamp (ms). Returns NaN on failure. */
function parseNotamTs(s: string | null | undefined): number {
  if (!s) return NaN;
  // ICAO compact: YYMMDDHHmm (10 digits)
  if (/^\d{10}$/.test(s)) {
    const yr = 2000 + Number(s.slice(0, 2));
    const mo = Number(s.slice(2, 4)) - 1;
    const dy = Number(s.slice(4, 6));
    const hr = Number(s.slice(6, 8));
    const mn = Number(s.slice(8, 10));
    return Date.UTC(yr, mo, dy, hr, mn);
  }
  return new Date(s).getTime();
}

/** Try to extract start/end timestamps from NOTAM body text as a fallback. */
function parseBodyDates(body: string | null): { start: number; end: number } {
  if (!body) return { start: NaN, end: NaN };
  // B) 2603011400 C) 2603151800
  const fromM = body.match(/\bB\)\s*(\d{10})\b/);
  const toM = body.match(/\bC\)\s*(\d{10})\b/);
  if (fromM) return { start: parseNotamTs(fromM[1]), end: toM ? parseNotamTs(toM[1]) : NaN };
  // WEF/TIL
  const wefM = body.match(/WEF\s+(\d{10})/);
  const tilM = body.match(/TIL\s+(\d{10})/);
  if (wefM) return { start: parseNotamTs(wefM[1]), end: tilM ? parseNotamTs(tilM[1]) : NaN };
  // Domestic: 2603011400-2603151800
  const domM = body.match(/\b(\d{10})-(\d{10})\b/);
  if (domM) return { start: parseNotamTs(domM[1]), end: parseNotamTs(domM[2]) };
  return { start: NaN, end: NaN };
}

/**
 * Check if a NOTAM's effective period overlaps with ±NOTAM_RELEVANCE_HOURS
 * around a flight time. Returns true (show it) if dates can't be determined.
 */
function notamOverlapsFlight(alert: OpsAlert, flightTimeIso: string | null): boolean {
  if (!flightTimeIso) return true; // can't check — show it
  const flightTs = new Date(flightTimeIso).getTime();
  if (isNaN(flightTs)) return true;

  const nd = alert.notam_dates;
  let start = parseNotamTs(nd?.effective_start) || parseNotamTs(nd?.start_date_utc);
  let end = parseNotamTs(nd?.effective_end) || parseNotamTs(nd?.end_date_utc);

  // Fallback: parse dates from NOTAM body text
  if (isNaN(start) && isNaN(end)) {
    const bodyDates = parseBodyDates(alert.body);
    start = bodyDates.start;
    end = bodyDates.end;
  }

  // If we still can't determine dates, show the NOTAM (fail open)
  if (isNaN(start) && isNaN(end)) return true;

  const buffer = NOTAM_RELEVANCE_HOURS * 3600_000;
  const windowStart = flightTs - buffer;
  const windowEnd = flightTs + buffer;

  // NOTAM with only a start date: treat as point-in-time
  if (isNaN(end)) return start <= windowEnd && start >= windowStart;
  // NOTAM with only an end date
  if (isNaN(start)) return end >= windowStart;
  // Full range: check overlap
  return start <= windowEnd && end >= windowStart;
}

// ---------------------------------------------------------------------------
// Flights — direct Supabase queries to flights + ops_alerts
// ---------------------------------------------------------------------------

const ALERT_COLUMNS =
  "id, flight_id, alert_type, severity, airport_icao, departure_icao, arrival_icao, tail_number, subject, body, edct_time, original_departure_time, acknowledged_at, acknowledged_by, created_at, raw_data, source_message_id";

/**
 * Lightweight flight fetch — returns flights with empty alerts arrays.
 * Use this when you only need flight schedule data (no EDCT/NOTAM/alert loading).
 */
export async function fetchFlightsLite(params: {
  lookahead_hours?: number;
  lookback_hours?: number;
} = {}): Promise<FlightsResponse> {
  const supa = createServiceClient();
  const lookahead = params.lookahead_hours ?? 120;
  const lookback = params.lookback_hours ?? 168;

  const now = new Date();
  const past = new Date(now.getTime() - lookback * 3600_000).toISOString();
  const future = new Date(now.getTime() + lookahead * 3600_000).toISOString();

  const { data: flightRows, error } = await supa
    .from("flights")
    .select("id, ics_uid, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, summary, flight_type, pic, sic, pax_count, jetinsight_url, fa_flight_id")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  if (error) throw new Error(`fetchFlightsLite failed: ${error.message}`);
  if (!flightRows?.length) return { ok: true, flights: [], count: 0 };

  // Deduplicate cross-feed flights
  const seen = new Map<string, number>();
  const flights: Flight[] = [];
  for (const f of flightRows) {
    if (f.tail_number && f.departure_icao && f.arrival_icao) {
      const sig = `${f.tail_number}|${f.departure_icao}|${f.arrival_icao}|${f.scheduled_departure}`;
      if (seen.has(sig)) continue;
      seen.set(sig, flights.length);
    }
    flights.push({
      id: f.id as string,
      ics_uid: f.ics_uid as string,
      tail_number: f.tail_number as string | null,
      departure_icao: f.departure_icao as string | null,
      arrival_icao: f.arrival_icao as string | null,
      scheduled_departure: f.scheduled_departure as string,
      scheduled_arrival: f.scheduled_arrival as string | null,
      summary: f.summary as string | null,
      flight_type: f.flight_type as string | null,
      pic: f.pic as string | null,
      sic: f.sic as string | null,
      pax_count: f.pax_count as number | null,
      jetinsight_url: f.jetinsight_url as string | null,
      fa_flight_id: f.fa_flight_id as string | null,
      alerts: [],
    });
  }

  return { ok: true, flights, count: flights.length };
}

export async function fetchFlights(params: {
  lookahead_hours?: number;
  lookback_hours?: number;
} = {}): Promise<FlightsResponse> {
  const supa = createServiceClient();
  const lookahead = params.lookahead_hours ?? 720;
  const lookback = params.lookback_hours ?? 12;

  const now = new Date();
  const past = new Date(now.getTime() - lookback * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + lookahead * 60 * 60 * 1000).toISOString();

  // Fetch flights in the time window
  const { data: flightRows, error: flightErr } = await supa
    .from("flights")
    .select("id, ics_uid, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, summary, flight_type, pic, sic, pax_count, jetinsight_url, fa_flight_id")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  if (flightErr) throw new Error(`fetchFlights failed: ${flightErr.message}`);
  if (!flightRows || flightRows.length === 0) {
    return { ok: true, flights: [], count: 0 };
  }

  // Fetch alerts for these flights (all batches in parallel)
  const flightIds = flightRows.map((f) => f.id as string);
  const alertsByFlight = new Map<string, OpsAlert[]>();

  const alertBatches: string[][] = [];
  for (let i = 0; i < flightIds.length; i += 200) {
    alertBatches.push(flightIds.slice(i, i + 200));
  }

  // Collect all airports from flights for NOTAM query
  const flightAirports = new Set<string>();
  for (const f of flightRows) {
    if (f.departure_icao) flightAirports.add(f.departure_icao as string);
    if (f.arrival_icao) flightAirports.add(f.arrival_icao as string);
  }
  const airportList = [...flightAirports];

  // Orphan EDCT + per-flight alerts + airport-level NOTAMs — all in parallel
  const edctPast = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const notamCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [alertResults, { data: orphanRows }, { data: notamRows }] = await Promise.all([
    Promise.all(alertBatches.map((batch) =>
      supa.from("ops_alerts").select(ALERT_COLUMNS).in("flight_id", batch)
    )),
    supa
      .from("ops_alerts")
      .select(ALERT_COLUMNS)
      .eq("alert_type", "EDCT")
      .is("flight_id", null)
      .is("acknowledged_at", null)
      .gte("created_at", edctPast)
      .order("created_at", { ascending: false })
      .limit(50),
    // Airport-level NOTAMs (flight_id IS NULL, new dedup scheme)
    airportList.length > 0
      ? supa
          .from("ops_alerts")
          .select(ALERT_COLUMNS)
          .like("alert_type", "NOTAM_%")
          .is("flight_id", null)
          .is("acknowledged_at", null)
          .in("airport_icao", airportList)
          .gte("created_at", notamCutoff)
          .order("created_at", { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [] as any[], error: null }),
  ]);

  // Helper to build OpsAlert from a DB row
  function rowToAlert(row: Record<string, unknown>): OpsAlert {
    return {
      id: row.id as string,
      flight_id: row.flight_id as string | null,
      alert_type: row.alert_type as string,
      severity: row.severity as string,
      airport_icao: row.airport_icao as string | null,
      departure_icao: row.departure_icao as string | null,
      arrival_icao: row.arrival_icao as string | null,
      tail_number: row.tail_number as string | null,
      subject: row.subject as string | null,
      body: row.body as string | null,
      edct_time: row.edct_time as string | null,
      original_departure_time: row.original_departure_time as string | null,
      acknowledged_at: row.acknowledged_at as string | null,
      acknowledged_by: row.acknowledged_by as string | null,
      created_at: row.created_at as string,
      notam_dates: extractNotamDates(row.raw_data),
      source_message_id: row.source_message_id as string | null,
    };
  }

  // Process per-flight alerts (EDCTs, OCEANIC_HF, and legacy per-flight NOTAMs)
  for (const { data: alertRows, error: alertErr } of alertResults) {
    if (alertErr) throw new Error(`fetchFlights alerts failed: ${alertErr.message}`);
    for (const row of alertRows ?? []) {
      if (isNoiseNotam(row as { alert_type: string; body: string | null })) continue;
      const alert = rowToAlert(row);
      const fid = alert.flight_id ?? "";
      if (!alertsByFlight.has(fid)) alertsByFlight.set(fid, []);
      alertsByFlight.get(fid)!.push(alert);
    }
  }

  // Distribute airport-level NOTAMs to flights by matching departure/arrival ICAO
  const notamAlertsByAirport = new Map<string, OpsAlert[]>();
  for (const row of notamRows ?? []) {
    if (isNoiseNotam(row as { alert_type: string; body: string | null })) continue;
    const alert = rowToAlert(row);
    const icao = (alert.airport_icao ?? "").toUpperCase();
    if (!notamAlertsByAirport.has(icao)) notamAlertsByAirport.set(icao, []);
    notamAlertsByAirport.get(icao)!.push(alert);
  }
  for (const f of flightRows) {
    const fid = f.id as string;
    if (!alertsByFlight.has(fid)) alertsByFlight.set(fid, []);
    const flightAlerts = alertsByFlight.get(fid)!;
    // Attach NOTAMs from departure and arrival airports (dedup by alert ID).
    // Only include NOTAMs whose effective period overlaps ±5h of the flight
    // at that airport — filters out closures for other days.
    const seen = new Set(flightAlerts.map((a) => a.id));
    const depIcao = (f.departure_icao as string | null)?.toUpperCase();
    const arrIcao = (f.arrival_icao as string | null)?.toUpperCase();
    for (const [icao, flightTime] of [
      [depIcao, f.scheduled_departure as string | null],
      [arrIcao, f.scheduled_arrival as string | null],
    ] as const) {
      if (!icao) continue;
      for (const notam of notamAlertsByAirport.get(icao) ?? []) {
        if (seen.has(notam.id)) continue;
        if (!notamOverlapsFlight(notam, flightTime)) continue;
        seen.add(notam.id);
        flightAlerts.push(notam);
      }
    }
  }

  // Compute suppressed NOTAM_RUNWAY IDs (airport still has 5000+ ft paved open).
  // Alerts stay attached to flights — frontend uses these IDs to show/hide.
  const allAlerts: OpsAlert[] = [];
  for (const alerts of alertsByFlight.values()) allAlerts.push(...alerts);
  const suppressedRunwayNotamIds = getRunwaySuppressedIds(allAlerts);

  const orphanAlerts: OpsAlert[] = (orphanRows ?? []).map((row) => ({
    id: row.id as string,
    flight_id: null,
    alert_type: row.alert_type as string,
    severity: row.severity as string,
    airport_icao: row.airport_icao as string | null,
    departure_icao: row.departure_icao as string | null,
    arrival_icao: row.arrival_icao as string | null,
    tail_number: row.tail_number as string | null,
    subject: row.subject as string | null,
    body: row.body as string | null,
    edct_time: row.edct_time as string | null,
    original_departure_time: row.original_departure_time as string | null,
    acknowledged_at: row.acknowledged_at as string | null,
    acknowledged_by: row.acknowledged_by as string | null,
    created_at: row.created_at as string,
    notam_dates: extractNotamDates(row.raw_data),
    source_message_id: row.source_message_id as string | null,
  }));

  // Assemble flights with nested alerts
  const allFlights: Flight[] = flightRows.map((f) => ({
    id: f.id as string,
    ics_uid: f.ics_uid as string,
    tail_number: f.tail_number as string | null,
    departure_icao: f.departure_icao as string | null,
    arrival_icao: f.arrival_icao as string | null,
    scheduled_departure: f.scheduled_departure as string,
    scheduled_arrival: f.scheduled_arrival as string | null,
    summary: f.summary as string | null,
    flight_type: f.flight_type as string | null,
    pic: f.pic as string | null,
    sic: f.sic as string | null,
    pax_count: f.pax_count as number | null,
    jetinsight_url: f.jetinsight_url as string | null,
    fa_flight_id: f.fa_flight_id as string | null,
    alerts: alertsByFlight.get(f.id as string) ?? [],
  }));

  // Deduplicate cross-feed flights: same tail+route+departure = same flight.
  // Keep the first (by scheduled_departure sort order) and merge alerts.
  const seen = new Map<string, number>();
  const flights: Flight[] = [];
  for (const f of allFlights) {
    if (f.tail_number && f.departure_icao && f.arrival_icao) {
      const sig = `${f.tail_number}|${f.departure_icao}|${f.arrival_icao}|${f.scheduled_departure}`;
      const existing = seen.get(sig);
      if (existing !== undefined) {
        // Merge alerts from the duplicate into the kept flight
        flights[existing].alerts.push(...f.alerts);
        continue;
      }
      seen.set(sig, flights.length);
    }
    flights.push(f);
  }

  // Try to match orphan EDCT alerts to real flights using normalized airport codes.
  // EDCT may use TJSJ while schedule has KSJU (same airport, different code systems).
  // Get all canonical forms for an airport code so KSJU matches TJSJ
  const airportKeys = (c: string | null): string[] => {
    if (!c) return [];
    const u = c.toUpperCase();
    const keys = [u];
    // Strip K prefix: KSJU → SJU
    if (u.length === 4 && u.startsWith("K")) {
      const stripped = u.slice(1);
      keys.push(stripped);
      // Convert IATA to ICAO: SJU → TJSJ
      const icao = toIcao(stripped);
      if (icao && icao !== u) keys.push(icao);
    }
    // 3-letter: add K prefix + ICAO lookup
    if (u.length === 3) {
      keys.push(`K${u}`);
      const icao = toIcao(u);
      if (icao) keys.push(icao);
    }
    return keys;
  };

  const sameAirport = (a: string | null, b: string | null): boolean => {
    if (!a || !b) return false;
    if (a.toUpperCase() === b.toUpperCase()) return true;
    const aKeys = airportKeys(a);
    const bKeys = airportKeys(b);
    return aKeys.some((k) => bKeys.includes(k));
  };

  for (const alert of orphanAlerts) {
    const aTail = alert.tail_number?.toUpperCase() ?? "";

    // Try to find a matching flight by tail + normalized airports
    const matchIdx = flights.findIndex((f) => {
      if (!f.tail_number || f.tail_number.toUpperCase() !== aTail) return false;
      return sameAirport(alert.departure_icao, f.departure_icao)
        && sameAirport(alert.arrival_icao, f.arrival_icao);
    });

    if (matchIdx !== -1) {
      // Attach the orphan EDCT to the matched flight
      flights[matchIdx].alerts.push(alert);
    } else {
      // No match — create synthetic flight entry
      flights.push({
        id: `edct-orphan-${alert.id}`,
        ics_uid: "",
        tail_number: alert.tail_number,
        departure_icao: alert.departure_icao,
        arrival_icao: alert.arrival_icao,
        scheduled_departure: alert.created_at,
        scheduled_arrival: null,
        summary: alert.subject,
        flight_type: null,
        pic: null,
        sic: null,
        pax_count: null,
        jetinsight_url: null,
        fa_flight_id: null,
        alerts: [alert],
      });
    }
  }

  // Detect flights where ALL runways are closed within ±2hrs of departure/arrival
  const allRunwaysClosedAlerts = detectAllRunwaysClosed(flights);

  return { ok: true, flights, count: flights.length, suppressedRunwayNotamIds, allRunwaysClosedAlerts };
}

// ---------------------------------------------------------------------------
// MX Notes — maintenance alerts from JetInsight ICS feeds
// ---------------------------------------------------------------------------

export type MxNote = {
  id: string;
  tail_number: string | null;
  airport_icao: string | null;
  subject: string | null;
  body: string | null;
  description: string | null; // free-text notes from JetInsight DESCRIPTION field
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  acknowledged_at: string | null;
  attachment_count?: number;
  scheduled_date?: string | null;
  assigned_van?: number | null;
};

export async function fetchMxNotes(): Promise<MxNote[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("ops_alerts")
    .select("id, tail_number, airport_icao, subject, body, created_at, acknowledged_at, raw_data, scheduled_date, assigned_van")
    .eq("alert_type", "MX_NOTE")
    .is("acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error || !data) return [];

  return data.map((row) => {
    let startTime: string | null = null;
    let endTime: string | null = null;
    let description: string | null = null;
    try {
      const rd = typeof row.raw_data === "string" ? JSON.parse(row.raw_data) : row.raw_data;
      startTime = rd?.start_time ?? null;
      endTime = rd?.end_time ?? null;
      description = rd?.description ?? null;
    } catch { /* ignore */ }
    return {
      id: row.id as string,
      tail_number: row.tail_number as string | null,
      airport_icao: row.airport_icao as string | null,
      subject: row.subject as string | null,
      body: row.body as string | null,
      description,
      start_time: startTime,
      end_time: endTime,
      created_at: row.created_at as string,
      acknowledged_at: row.acknowledged_at as string | null,
      scheduled_date: (row as Record<string, unknown>).scheduled_date as string | null ?? null,
      assigned_van: (row as Record<string, unknown>).assigned_van as number | null ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// MEL Items — Minimum Equipment List tracking
// ---------------------------------------------------------------------------

export type MelItem = {
  id: number;
  tail_number: string;
  category: "A" | "B" | "C" | "D";
  mel_reference: string | null;
  description: string;
  deferred_date: string;
  expiration_date: string | null;
  status: "open" | "cleared";
  cleared_by: string | null;
  cleared_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export async function fetchMelItems(): Promise<MelItem[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("mel_items")
    .select("*")
    .eq("status", "open")
    .order("expiration_date", { ascending: true, nullsFirst: false })
    .limit(500);

  if (error || !data) return [];
  return data as MelItem[];
}

// ---------------------------------------------------------------------------
// Aircraft Tags — conformity / long-term MX tags
// ---------------------------------------------------------------------------

export type AircraftTag = {
  id: string;
  tail_number: string;
  tag: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// SWIM Flow Control — GDP, Ground Stops, CTOPs from FAA SWIM/TFMS
// ---------------------------------------------------------------------------

export type SwimFlowEvent = {
  id: string;
  event_type: string;
  airport_icao: string | null;
  status: string;
  severity: string;
  subject: string;
  body: string | null;
  effective_at: string | null;
  expires_at: string | null;
  created_at: string;
};

export async function fetchSwimFlowControl(): Promise<SwimFlowEvent[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("swim_flow_control")
    .select("id, event_type, airport_icao, status, severity, subject, body, effective_at, expires_at, created_at")
    .eq("status", "active")
    .neq("event_type", "REROUTE")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !data) return [];
  return data as SwimFlowEvent[];
}

// ---------------------------------------------------------------------------
// Aircraft Tags — conformity / long-term MX tags
// ---------------------------------------------------------------------------

export async function fetchAircraftTags(): Promise<AircraftTag[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("aircraft_tags")
    .select("id, tail_number, tag, note, created_by, created_at")
    .order("created_at", { ascending: false });

  if (error || !data) return [];
  return data as AircraftTag[];
}

// ---------------------------------------------------------------------------
// International Ops — countries, permits, handlers, documents, customs, alerts
// ---------------------------------------------------------------------------

export type Country = {
  id: string;
  name: string;
  iso_code: string;
  icao_prefixes: string[];
  overflight_permit_required: boolean;
  landing_permit_required: boolean;
  permit_lead_time_days: number | null;
  permit_lead_time_working_days: boolean;
  treat_as_international: boolean;
  notes: string | null;
  baker_confirmed: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CountryRequirement = {
  id: string;
  country_id: string;
  requirement_type: "overflight" | "landing" | "customs" | "handling" | "note";
  name: string;
  description: string | null;
  required_documents: string[];
  attachment_url: string | null;
  attachment_filename: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type IntlLegPermit = {
  id: string;
  flight_id: string;
  country_id: string;
  permit_type: "overflight" | "landing";
  status: "not_started" | "drafted" | "submitted" | "approved";
  deadline: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  reference_number: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  country?: Country;
};

export type IntlLegHandler = {
  id: string;
  flight_id: string;
  handler_name: string;
  handler_contact: string | null;
  airport_icao: string;
  requested: boolean;
  approved: boolean;
  requested_at: string | null;
  approved_at: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type IntlDocument = {
  id: string;
  name: string;
  document_type: "airworthiness" | "medical" | "certificate" | "passport" | "insurance" | "other";
  entity_type: "aircraft" | "crew" | "company";
  entity_id: string;
  gcs_bucket: string;
  gcs_key: string;
  filename: string;
  content_type: string;
  expiration_date: string | null;
  is_current: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type UsCustomsAirport = {
  id: string;
  icao: string;
  airport_name: string;
  customs_type: "AOE" | "LRA" | "UserFee" | "None";
  hours_open: string | null;
  hours_close: string | null;
  timezone: string | null;
  advance_notice_hours: number | null;
  overtime_available: boolean;
  restrictions: string | null;
  notes: string | null;
  difficulty: "easy" | "moderate" | "hard" | null;
  baker_confirmed: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type IntlLegAlert = {
  id: string;
  flight_id: string | null;
  alert_type: "deadline_approaching" | "permit_resubmit" | "customs_conflict" | "tail_change" | "schedule_change" | "delay" | "diversion";
  severity: "critical" | "warning" | "info";
  message: string;
  related_country_id: string | null;
  related_permit_id: string | null;
  acknowledged: boolean;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// International Trips
// ---------------------------------------------------------------------------

export type IntlTrip = {
  id: string;
  tail_number: string;
  route_icaos: string[]; // e.g. ['KTEB', 'MYNN', 'MKJP', 'KOPF']
  flight_ids: string[];  // ordered flight IDs for each leg
  trip_date: string;     // date of first departure
  notes: string | null;
  pax_data_status: "not_started" | "salesperson_notified" | "uploaded";
  created_at: string;
  updated_at: string;
  // Joined
  clearances?: IntlTripClearance[];
  // Computed from first flight
  jetinsight_url?: string | null;
  // Per-flight departure/arrival times (keyed by flight ID)
  schedule_snapshot?: Record<string, { dep: string; arr: string | null }> | null;
  // Passenger names per leg (from JI CSV upload)
  leg_passengers?: Array<{ dep: string; arr: string; passengers: string }>;
  // Salesperson name (from JI CSV upload)
  salesperson?: string;
  // True if all legs are positioning (no pax expected)
  is_positioning?: boolean;
  // True if all flights became domestic (route changed, trip may be stale)
  is_domestic_now?: boolean;
};

export type IntlTripClearance = {
  id: string;
  trip_id: string;
  clearance_type: "outbound_clearance" | "landing_permit" | "inbound_clearance" | "overflight_permit";
  airport_icao: string;
  status: "not_started" | "submitted" | "received" | "approved";
  sort_order: number;
  notes: string | null;
  file_gcs_bucket: string | null;
  file_gcs_key: string | null;
  file_filename: string | null;
  file_content_type: string | null;
  handler_status: { status: string; from: string; note: string; date: string } | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Pinned NOTAMs
// ---------------------------------------------------------------------------

export type NotamPin = {
  alert_id: string;
  pinned_by: string;
  note: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Custom NOTAM alerts
// ---------------------------------------------------------------------------

export type CustomNotamAlert = {
  id: string;
  airport_icao: string | null;
  severity: "critical" | "warning" | "info";
  subject: string;
  body: string | null;
  created_by: string;
  created_by_name: string | null;
  expires_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

// Re-export client-safe helpers (these are also importable directly from @/lib/intlUtils)
import { isInternationalFlight as _isIntlFlight } from "@/lib/intlUtils";
export { isInternationalIcao, isInternationalFlight } from "@/lib/intlUtils";

// ---------------------------------------------------------------------------
// Fetch international flights (30-day lookahead)
// ---------------------------------------------------------------------------

export async function fetchInternationalFlights(): Promise<Flight[]> {
  const result = await fetchFlights({ lookahead_hours: 720, lookback_hours: 24 });
  return result.flights.filter(_isIntlFlight);
}

// ---------------------------------------------------------------------------
// Fetch countries
// ---------------------------------------------------------------------------

export async function fetchCountries(): Promise<Country[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("countries")
    .select("*")
    .order("name");
  if (error || !data) return [];
  return data as Country[];
}

// ---------------------------------------------------------------------------
// Fetch country requirements
// ---------------------------------------------------------------------------

export async function fetchCountryRequirements(countryId?: string): Promise<CountryRequirement[]> {
  const supa = createServiceClient();
  let q = supa
    .from("country_requirements")
    .select("*")
    .eq("is_active", true)
    .order("sort_order");
  if (countryId) q = q.eq("country_id", countryId);
  const { data, error } = await q;
  if (error || !data) return [];
  return data as CountryRequirement[];
}

// ---------------------------------------------------------------------------
// Fetch permits for a flight
// ---------------------------------------------------------------------------

export async function fetchPermitsForFlight(flightId: string): Promise<IntlLegPermit[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_permits")
    .select("*, country:countries(*)")
    .eq("flight_id", flightId)
    .order("created_at");
  if (error || !data) return [];
  return data as IntlLegPermit[];
}

// ---------------------------------------------------------------------------
// Fetch all pending permits (for the dashboard view)
// ---------------------------------------------------------------------------

export async function fetchPendingPermits(): Promise<IntlLegPermit[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_permits")
    .select("*, country:countries(*)")
    .neq("status", "approved")
    .order("deadline", { ascending: true, nullsFirst: false });
  if (error || !data) return [];
  return data as IntlLegPermit[];
}

// ---------------------------------------------------------------------------
// Fetch handlers for a flight
// ---------------------------------------------------------------------------

export async function fetchHandlersForFlight(flightId: string): Promise<IntlLegHandler[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_handlers")
    .select("*")
    .eq("flight_id", flightId)
    .order("created_at");
  if (error || !data) return [];
  return data as IntlLegHandler[];
}

// ---------------------------------------------------------------------------
// Fetch international documents
// ---------------------------------------------------------------------------

export async function fetchIntlDocuments(entityType?: string, entityId?: string): Promise<IntlDocument[]> {
  const supa = createServiceClient();
  let q = supa
    .from("intl_documents")
    .select("*")
    .eq("is_current", true)
    .order("created_at", { ascending: false });
  if (entityType) q = q.eq("entity_type", entityType);
  if (entityId) q = q.eq("entity_id", entityId);
  const { data, error } = await q;
  if (error || !data) return [];
  return data as IntlDocument[];
}

// ---------------------------------------------------------------------------
// Fetch US customs airports
// ---------------------------------------------------------------------------

export async function fetchUsCustomsAirports(): Promise<UsCustomsAirport[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("us_customs_airports")
    .select("*")
    .order("icao");
  if (error || !data) return [];
  return data as UsCustomsAirport[];
}

// ---------------------------------------------------------------------------
// Fetch international leg alerts
// ---------------------------------------------------------------------------

export async function fetchIntlAlerts(unackedOnly = true): Promise<IntlLegAlert[]> {
  const supa = createServiceClient();
  let q = supa
    .from("intl_leg_alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (unackedOnly) q = q.eq("acknowledged", false);
  const { data, error } = await q;
  if (error || !data) return [];
  return data as IntlLegAlert[];
}
