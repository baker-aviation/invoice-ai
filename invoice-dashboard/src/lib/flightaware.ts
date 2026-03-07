/**
 * FlightAware AeroAPI v4 client
 *
 * Docs: https://www.flightaware.com/aeroapi/portal/documentation
 * Base: https://aeroapi.flightaware.com/aeroapi/
 * Auth: x-apikey header
 */

const BASE = "https://aeroapi.flightaware.com/aeroapi";

function apiKey(): string {
  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) throw new Error("FLIGHTAWARE_API_KEY not set");
  return key;
}

function headers() {
  return { "x-apikey": apiKey(), Accept: "application/json; charset=UTF-8" };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FaAirport = {
  code: string | null;        // ICAO code (e.g. "KTEB")
  code_iata: string | null;   // IATA code (e.g. "TEB")
  code_icao: string | null;
  code_lid: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
};

export type FaPosition = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  groundspeed: number | null;
  heading: number | null;
  timestamp: string | null;
};

export type FaFlight = {
  ident: string;              // e.g. "KOW102"
  fa_flight_id: string;
  operator: string | null;
  registration: string | null; // tail number e.g. "N102VR"
  aircraft_type: string | null;
  origin: FaAirport | null;
  destination: FaAirport | null;
  // OOOI times (ISO 8601)
  scheduled_out: string | null;
  estimated_out: string | null;
  actual_out: string | null;
  scheduled_off: string | null;
  estimated_off: string | null;
  actual_off: string | null;
  scheduled_on: string | null;
  estimated_on: string | null;
  actual_on: string | null;
  scheduled_in: string | null;
  estimated_in: string | null;
  actual_in: string | null;
  // Route
  route: string | null;
  route_distance: number | null; // nautical miles
  filed_ete: number | null;      // filed enroute time (seconds)
  filed_airspeed: number | null;
  filed_altitude: number | null;
  progress_percent: number | null;
  status: string | null;         // e.g. "En Route", "Landed", "Scheduled"
  departure_delay: number | null;
  arrival_delay: number | null;
  diverted: boolean;
  cancelled: boolean;
  // Position (available for en-route flights)
  last_position: FaPosition | null;
};

// Simplified version for the dashboard
export type FlightInfo = {
  tail: string;
  ident: string;
  fa_flight_id: string;
  origin_icao: string | null;
  origin_name: string | null;
  destination_icao: string | null;
  destination_name: string | null;
  status: string | null;
  progress_percent: number | null;
  // Times
  departure_time: string | null;   // actual or estimated gate out
  arrival_time: string | null;     // estimated runway on (ETA)
  scheduled_arrival: string | null;
  actual_departure: string | null; // actual gate out
  actual_arrival: string | null;   // actual gate in
  // Route
  route: string | null;
  route_distance_nm: number | null;
  filed_altitude: number | null;
  // Flags
  diverted: boolean;
  cancelled: boolean;
  // Aircraft
  aircraft_type: string | null; // ICAO type code e.g. "C750", "CL30", "CL35"
  // Position (from FlightAware, for en-route flights)
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  groundspeed: number | null;
  heading: number | null;
};

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

// LADD/PIA-blocked aircraft: registration lookup returns nothing,
// so we fall back to querying by callsign (operator + fleet number).
const CALLSIGN_FALLBACKS: Record<string, string> = {
  N301HR: "KOW301",
};

/**
 * Get recent and upcoming flights for a registration (tail number).
 * Returns the most recent / current / upcoming flights.
 * Falls back to callsign lookup for LADD/PIA-blocked aircraft.
 */
export async function getFlightsByRegistration(
  registration: string,
): Promise<FaFlight[]> {
  const url = `${BASE}/flights/${encodeURIComponent(registration)}`;
  const res = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("FlightAware: invalid API key");
    if (res.status === 429) throw new Error("FlightAware: rate limited");
    return [];
  }
  const data = await res.json();
  let flights = (data.flights ?? []) as FaFlight[];
  console.log(`[FA] ${registration}: ${flights.length} flights returned`);

  // Fallback: try callsign for blocked aircraft
  if (flights.length === 0 && CALLSIGN_FALLBACKS[registration]) {
    const callsign = CALLSIGN_FALLBACKS[registration];
    console.log(`[FA] ${registration}: trying callsign fallback ${callsign}`);
    const csUrl = `${BASE}/flights/${encodeURIComponent(callsign)}`;
    try {
      const csRes = await fetch(csUrl, {
        headers: headers(),
        signal: AbortSignal.timeout(10000),
      });
      if (csRes.ok) {
        const csData = await csRes.json();
        flights = (csData.flights ?? []) as FaFlight[];
        console.log(`[FA] ${callsign}: ${flights.length} flights returned (callsign fallback)`);
      }
    } catch { /* ignore callsign fallback errors */ }
  }

  return flights;
}

/**
 * Get the last position for a specific flight by fa_flight_id.
 */
async function getFlightPosition(
  faFlightId: string,
): Promise<FaPosition | null> {
  const url = `${BASE}/flights/${encodeURIComponent(faFlightId)}/position`;
  try {
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // The position endpoint returns the last position directly
    if (data.last_position) return data.last_position as FaPosition;
    // Or it might return position fields at top level
    if (data.latitude != null && data.longitude != null) return data as FaPosition;
    return null;
  } catch {
    return null;
  }
}

export type FaTrackPoint = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  groundspeed: number | null;
  heading: number | null;
  timestamp: string;
};

/**
 * Get the full flight track (list of positions) for a specific flight by fa_flight_id.
 */
export async function getFlightTrack(
  faFlightId: string,
): Promise<FaTrackPoint[]> {
  const url = `${BASE}/flights/${encodeURIComponent(faFlightId)}/track`;
  try {
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.positions ?? []) as FaTrackPoint[];
  } catch {
    return [];
  }
}

/**
 * For a list of tail numbers, return all recent flights from FlightAware
 * (within 12 hours past + upcoming). Includes completed, en-route, and scheduled.
 * Only fetches position for the single active en-route flight per tail (to limit API calls).
 */
export async function getActiveFlights(
  tails: string[],
): Promise<FlightInfo[]> {
  const results: FlightInfo[] = [];
  const now = Date.now();

  // Query in batches of 3 to stay well under rate limits
  const BATCH = 3;
  for (let i = 0; i < tails.length; i += BATCH) {
    const batch = tails.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (tail) => {
        try {
          const flights = await getFlightsByRegistration(tail);
          const recent: FlightInfo[] = [];

          for (const f of flights) {
            if (f.cancelled) continue;
            // Include flights from last 12 hours + upcoming
            const dep = f.actual_out ?? f.estimated_out ?? f.scheduled_out;
            if (dep) {
              const depMs = new Date(dep).getTime();
              if (depMs < now - 12 * 3600_000) continue;
            }

            const info = toFlightInfo(tail, f);
            // last_position is already extracted by toFlightInfo from the flights response —
            // no separate getFlightPosition call needed (saves ~1 API call per en-route aircraft per refresh)

            recent.push(info);
          }

          return recent;
        } catch {
          return [];
        }
      }),
    );
    for (const batch of batchResults) {
      results.push(...batch);
    }
    // Rate limit pause between batches
    if (i + BATCH < tails.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickActiveFlight(flights: FaFlight[]): FaFlight | null {
  if (!flights.length) return null;

  // Prefer en-route flights
  const enRoute = flights.find(
    (f) =>
      f.actual_off != null &&
      f.actual_on == null &&
      !f.cancelled,
  );
  if (enRoute) return enRoute;

  // Then flights that departed recently (within 12 hours)
  const now = Date.now();
  const recent = flights.find((f) => {
    const dep = f.actual_out ?? f.estimated_out ?? f.scheduled_out;
    if (!dep) return false;
    const depMs = new Date(dep).getTime();
    return depMs > now - 12 * 3600_000 && !f.cancelled;
  });
  if (recent) return recent;

  // Then upcoming scheduled flights
  const upcoming = flights.find((f) => {
    const dep = f.scheduled_out ?? f.estimated_out;
    if (!dep) return false;
    return new Date(dep).getTime() > now && !f.cancelled;
  });
  return upcoming ?? null;
}

function toFlightInfo(tail: string, f: FaFlight): FlightInfo {
  return {
    tail,
    ident: f.ident,
    fa_flight_id: f.fa_flight_id,
    origin_icao: f.origin?.code_icao ?? f.origin?.code ?? null,
    origin_name: f.origin?.name ?? null,
    destination_icao: f.destination?.code_icao ?? f.destination?.code ?? null,
    destination_name: f.destination?.name ?? null,
    status: f.status,
    progress_percent: f.progress_percent,
    departure_time: f.actual_out ?? f.estimated_out ?? f.estimated_off ?? f.scheduled_out,
    arrival_time: f.estimated_on ?? f.scheduled_on,
    scheduled_arrival: f.scheduled_on,
    actual_departure: f.actual_out ?? f.actual_off ?? null,
    actual_arrival: f.actual_in ?? f.actual_on ?? null,
    route: f.route,
    route_distance_nm: f.route_distance,
    filed_altitude: f.filed_altitude,
    diverted: f.diverted,
    cancelled: f.cancelled,
    aircraft_type: f.aircraft_type ?? null,
    latitude: f.last_position?.latitude ?? null,
    longitude: f.last_position?.longitude ?? null,
    altitude: f.last_position?.altitude ?? null,
    groundspeed: f.last_position?.groundspeed ?? null,
    heading: f.last_position?.heading ?? null,
  };
}
