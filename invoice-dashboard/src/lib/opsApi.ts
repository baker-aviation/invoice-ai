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

  // Supabase may return jsonb as a string — parse it first
  let obj: Record<string, unknown>;
  try {
    obj = typeof rawData === "string" ? JSON.parse(rawData) : (rawData as Record<string, unknown>);
  } catch {
    return null;
  }

  // Compact format (current): {"notam_dates": {...}}
  const nd = obj.notam_dates as Record<string, unknown> | undefined;
  if (nd) {
    return {
      effective_start: (nd.effective_start as string) ?? null,
      effective_end: (nd.effective_end as string) ?? null,
      issued: (nd.issued as string) ?? null,
      status: (nd.status as string) ?? null,
      start_date_utc: (nd.start_date_utc as string) ?? null,
      end_date_utc: (nd.end_date_utc as string) ?? null,
      issue_date_utc: (nd.issue_date_utc as string) ?? null,
    };
  }

  // Legacy GeoJSON: {properties: {coreNOTAMData: {notam: {...}}}}
  // Also handles {properties: {coreNOTAMData: {notamEvent: {notam: {...}}}}}
  const core = (obj.properties as Record<string, unknown>)?.coreNOTAMData as Record<string, unknown> | undefined;
  const notam = (core?.notam ?? (core?.notamEvent as Record<string, unknown>)?.notam) as Record<string, unknown> | undefined;
  if (!notam) return null;
  return {
    effective_start: (notam.effectiveStart as string) ?? null,
    effective_end: (notam.effectiveEnd as string) ?? null,
    issued: (notam.issued as string) ?? null,
    status: (notam.status as string) ?? null,
    start_date_utc: (notam.startDate as string) ?? null,
    end_date_utc: (notam.endDate as string) ?? null,
    issue_date_utc: (notam.issueDate as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Flights — direct Supabase queries to flights + ops_alerts
// ---------------------------------------------------------------------------

const ALERT_COLUMNS =
  "id, flight_id, alert_type, severity, airport_icao, departure_icao, arrival_icao, tail_number, subject, body, edct_time, original_departure_time, acknowledged_at, created_at, raw_data";

export async function fetchFlights(params: {
  lookahead_hours?: number;
} = {}): Promise<FlightsResponse> {
  const supa = createServiceClient();
  const lookahead = params.lookahead_hours ?? 720;

  const now = new Date();
  const past = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + lookahead * 60 * 60 * 1000).toISOString();

  // Fetch flights in the time window
  const { data: flightRows, error: flightErr } = await supa
    .from("flights")
    .select("id, ics_uid, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, summary")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  if (flightErr) throw new Error(`fetchFlights failed: ${flightErr.message}`);
  if (!flightRows || flightRows.length === 0) {
    return { ok: true, flights: [], count: 0 };
  }

  // Fetch unacknowledged alerts for these flights (batch by 200)
  const flightIds = flightRows.map((f) => f.id as string);
  const alertsByFlight = new Map<string, OpsAlert[]>();

  for (let i = 0; i < flightIds.length; i += 200) {
    const batch = flightIds.slice(i, i + 200);
    const { data: alertRows, error: alertErr } = await supa
      .from("ops_alerts")
      .select(ALERT_COLUMNS)
      .in("flight_id", batch)
      .is("acknowledged_at", null);

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
        created_at: row.created_at as string,
        notam_dates: extractNotamDates(row.raw_data),
      };

      const fid = alert.flight_id ?? "";
      if (!alertsByFlight.has(fid)) alertsByFlight.set(fid, []);
      alertsByFlight.get(fid)!.push(alert);
    }
  }

  // Assemble flights with nested alerts
  const flights: Flight[] = flightRows.map((f) => ({
    id: f.id as string,
    ics_uid: f.ics_uid as string,
    tail_number: f.tail_number as string | null,
    departure_icao: f.departure_icao as string | null,
    arrival_icao: f.arrival_icao as string | null,
    scheduled_departure: f.scheduled_departure as string,
    scheduled_arrival: f.scheduled_arrival as string | null,
    summary: f.summary as string | null,
    alerts: alertsByFlight.get(f.id as string) ?? [],
  }));

  return { ok: true, flights, count: flights.length };
}
