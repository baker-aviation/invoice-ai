import { createServiceClient } from "@/lib/supabase/service";

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
  alerts: OpsAlert[];
};

export type FlightsResponse = {
  ok: boolean;
  flights: Flight[];
  count: number;
};

// ---------------------------------------------------------------------------
// NOTAM noise filter — matches backend logic in ops-monitor/main.py
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /RWY\s+\d+[LRC]?\/\d+[LRC]?\s+(CLSD|CLOSED)/i,
  /TWY\s+\w+\s+(CLSD|CLOSED)/i,
];

function isNoiseNotam(alert: { alert_type: string; body: string | null }): boolean {
  if (alert.alert_type !== "NOTAM_RUNWAY" && alert.alert_type !== "NOTAM_TAXIWAY") return false;
  if (!alert.body) return false;
  return NOISE_PATTERNS.some((p) => p.test(alert.body!));
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
// Flights — direct Supabase queries to flights + ops_alerts
// ---------------------------------------------------------------------------

const ALERT_COLUMNS =
  "id, flight_id, alert_type, severity, airport_icao, departure_icao, arrival_icao, tail_number, subject, body, edct_time, original_departure_time, acknowledged_at, acknowledged_by, created_at, raw_data";

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
    .select("id, ics_uid, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, summary, flight_type, pic, sic, pax_count, jetinsight_url")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  if (flightErr) throw new Error(`fetchFlights failed: ${flightErr.message}`);
  if (!flightRows || flightRows.length === 0) {
    return { ok: true, flights: [], count: 0 };
  }

  // Fetch alerts for these flights (batch by 200)
  const flightIds = flightRows.map((f) => f.id as string);
  const alertsByFlight = new Map<string, OpsAlert[]>();

  for (let i = 0; i < flightIds.length; i += 200) {
    const batch = flightIds.slice(i, i + 200);
    const { data: alertRows, error: alertErr } = await supa
      .from("ops_alerts")
      .select(ALERT_COLUMNS)
      .in("flight_id", batch);

    if (alertErr) throw new Error(`fetchFlights alerts failed: ${alertErr.message}`);

    for (const row of alertRows ?? []) {
      // Filter noise NOTAMs
      if (isNoiseNotam(row as { alert_type: string; body: string | null })) continue;

      const alert: OpsAlert = {
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
      };

      const fid = alert.flight_id ?? "";
      if (!alertsByFlight.has(fid)) alertsByFlight.set(fid, []);
      alertsByFlight.get(fid)!.push(alert);
    }
  }

  // Fetch orphan EDCT alerts (no flight_id) so they still show up — look back 48h
  const edctPast = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const { data: orphanRows } = await supa
    .from("ops_alerts")
    .select(ALERT_COLUMNS)
    .eq("alert_type", "EDCT")
    .is("flight_id", null)
    .is("acknowledged_at", null)
    .gte("created_at", edctPast)
    .order("created_at", { ascending: false })
    .limit(50);

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

  // Add synthetic flight entries for orphan EDCT alerts
  for (const alert of orphanAlerts) {
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
      alerts: [alert],
    });
  }

  return { ok: true, flights, count: flights.length };
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
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  acknowledged_at: string | null;
};

export async function fetchMxNotes(): Promise<MxNote[]> {
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("ops_alerts")
    .select("id, tail_number, airport_icao, subject, body, created_at, acknowledged_at, raw_data")
    .eq("alert_type", "MX_NOTE")
    .is("acknowledged_at", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error || !data) return [];

  return data.map((row) => {
    let startTime: string | null = null;
    let endTime: string | null = null;
    try {
      const rd = typeof row.raw_data === "string" ? JSON.parse(row.raw_data) : row.raw_data;
      startTime = rd?.start_time ?? null;
      endTime = rd?.end_time ?? null;
    } catch { /* ignore */ }
    return {
      id: row.id as string,
      tail_number: row.tail_number as string | null,
      airport_icao: row.airport_icao as string | null,
      subject: row.subject as string | null,
      body: row.body as string | null,
      start_time: startTime,
      end_time: endTime,
      created_at: row.created_at as string,
      acknowledged_at: row.acknowledged_at as string | null,
    };
  });
}
