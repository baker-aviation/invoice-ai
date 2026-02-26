const BASE = process.env.OPS_API_BASE_URL;

function mustBase(): string {
  if (!BASE) throw new Error("Missing OPS_API_BASE_URL in .env.local");
  return BASE.replace(/\/$/, "");
}

export type OpsAlert = {
  id: string;
  flight_id: string | null;
  alert_type: string;       // EDCT | NOTAM_RUNWAY | NOTAM_TAXIWAY | NOTAM_TFR | NOTAM_AERODROME | NOTAM_OTHER
  severity: string;         // critical | warning | info
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

export async function fetchFlights(params: {
  lookahead_hours?: number;
} = {}): Promise<FlightsResponse> {
  const base = mustBase();
  const url = new URL(`${base}/api/flights`);
  url.searchParams.set("lookahead_hours", String(params.lookahead_hours ?? 48));
  url.searchParams.set("include_alerts", "true");

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`fetchFlights failed: ${res.status}`);
  return res.json();
}
